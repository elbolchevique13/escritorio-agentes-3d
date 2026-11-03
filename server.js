// Servidor local do escritorio.
// - Conecta no servidor do opencode (opencode --port 4096) e le o fluxo /event.
// - Mantem um estado completo (quem trabalha, o que faz, permissao, erro, contexto...).
// - Envia esse estado para a pagina (index.html) via SSE em /events.
// - Recebe os eventos do Claude Code (hooks) em POST /claude.
// - Com remoto.json: tambem abre o painel na rede do Tailscale (celular) e manda avisos pelo ntfy.
// Uso: node server.js   (abre em http://localhost:4747)
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const remoto = require("./remoto");

const PORT = process.env.PORT || 4747;
const HOST = process.env.HOST || "127.0.0.1";
const OC_PORT = process.env.OC_PORT || 4096;
const LOG = process.env.ESCRITORIO_LOG_FILE || path.join(__dirname, "events.log");
const DEBUG_LOG = process.env.ESCRITORIO_LOG === "1";

const mk = () => ({ status: "idle", text: "", kind: "think", since: 0, until: 0 });
const S = {
  oc: false,
  cc: false, // Claude Code ativo
  project: "",
  versao: String(Date.now()), // muda a cada vez que o servidor liga: a pagina se recarrega sozinha
  session: "", // sessao principal atual (os personagens aleatorios mudam a cada sessao nova)
  model: "",
  ctxTokens: 0,
  cost: 0,
  files: 0,
  subagents: 0,
  subs: [], // lista de subagentes: { id, name, task, text, kind, status: working|done, parent }
  skills: [], // skills usadas por ultimo: { t, name, agent: plan|build|sub, by: tipo do subagente }
  log: [],
  agents: { plan: mk(), build: mk() },
  janela: { pinned: false, hidden: false, controle: process.platform === "win32" },
  remoto: false, // existe remoto.json: painel no celular e avisos
  fora: false, // modo "fora": avisa no celular e segura as permissoes do Claude Code ate alguem responder no painel
  pedidos: [], // permissoes esperando resposta: { id, t, agent, text, sempre }
};
let REMOTO = remoto.ler();
S.remoto = !!REMOTO;
let main = "build";
let lastSignal = 0;
const clients = new Set();
const sessions = new Map(); // sessionID -> { parentID }
const projects = new Map(); // projeto -> { costs: messageID -> custo, costBase, edited: arquivos editados }
const childActive = new Map(); // sessionID de subagente -> ultimo sinal
const childInfo = new Map(); // sessionID de subagente -> { name, task, text, kind }
const childDone = new Map(); // sessionID de subagente -> quando terminou (fica visivel por alguns segundos)
const loggedParts = new Set();
const sampled = new Set();

// ---------- tags de funcao ----------
// coluna "tag" do agentes.tsv: 1-2 palavras minusculas, ate 16 caracteres
const TAG_OK = /^[a-z0-9][a-z0-9-]{0,15}$/;
const SLUG_OK = /^[a-z0-9][a-z0-9-]{0,31}$/;
// plan e build nao moram no agentes.tsv: a tag deles nasce aqui
const TAGS = { plan: "auditor", build: "construtor" };
// onde o volume guarda chat.json e tags.json (no container: /app/dados)
const DADOS = process.env.ESCRITORIO_DADOS || (DEBUG_LOG ? path.dirname(LOG) : "");
const CHAT_FILE = DADOS ? path.join(DADOS, "chat.json") : "";
const TAGS_FILE = DADOS ? path.join(DADOS, "tags.json") : "";
const CHAT_MAX = 200;
const KINDS = new Set(["think", "read", "edit", "bash", "search", "web", "wait", "skill"]);
const CHAT = { seq: 0, lista: [] };

// ---------- utilitarios ----------
const cut = (s, n) => { s = String(s == null ? "" : s).replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const base = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || "";
const other = (w) => (w === "plan" ? "build" : "plan");
const pick = (name) => {
  const n = String(name || "").toLowerCase();
  if (n.includes("plan")) return "plan";
  if (n.includes("build")) return "build";
  return null; // subagentes (explore, general...) nao trocam o agente principal
};
const isChild = (sid) => !!(sid && sessions.get(sid) && sessions.get(sid).parentID);
// tira os itens mais antigos (Map/Set guardam a ordem de insercao)
const cap = (col, n) => { while (col.size > n) col.delete(col.keys().next().value); };

// ---------- custo e arquivos: contados por projeto ----------
function proj() {
  let p = projects.get(S.project);
  if (!p) { p = { costs: new Map(), costBase: 0, edited: new Set() }; projects.set(S.project, p); cap(projects, 30); }
  return p;
}
function addCost(id, cost) {
  const p = proj();
  p.costs.set(id, cost);
  // mensagens antigas ja tem o custo final: entram num total fixo
  while (p.costs.size > 300) { const [k, v] = p.costs.entries().next().value; p.costBase += v; p.costs.delete(k); }
}
function addEdited(file) { const p = proj(); p.edited.add(file); cap(p.edited, 2000); }
// log de depuracao (grava prompts e comandos): so com ESCRITORIO_LOG=1
const note = (line) => { if (DEBUG_LOG) try { fs.appendFileSync(LOG, line + "\n"); } catch {} };

// ---------- arquivos do volume (chat e tags) ----------
// grava em arquivo temporario e renomeia: ninguem le um JSON pela metade
function gravarJson(file, valor) {
  if (!file) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(valor));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}
function lerJson(file, padrao) {
  if (!file) return padrao;
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return padrao; }
}
// tags de plan/build sobrevivem ao restart; as dos moradores vem do agentes.tsv
function salvarTags() { gravarJson(TAGS_FILE, { plan: TAGS.plan, build: TAGS.build }); }

// ---------- chat: os baloes viram historico ----------
// guarda os ultimos 200 baloes, com hora, quem falou, o kind e o texto
function fala(slug, nome, kind, texto) {
  texto = cut(texto, 60);
  if (!slug || !texto) return null;
  // se a ultima fala desse morador e o mesmo texto, o balao so continua: nao entra de novo
  for (let i = CHAT.lista.length - 1; i >= 0; i--) {
    const x = CHAT.lista[i];
    if (x.slug !== slug) continue;
    if (x.texto === texto) return null;
    break;
  }
  const t = Date.now();
  const item = {
    id: ++CHAT.seq, t, hora: new Date(t).toTimeString().slice(0, 8),
    slug: cut(slug, 32), nome: cut(nome || slug, 40),
    tag: TAGS[slug] || "", kind: KINDS.has(kind) ? kind : "think", texto,
  };
  CHAT.lista.push(item);
  while (CHAT.lista.length > CHAT_MAX) CHAT.lista.shift();
  agendarChat();
  return item;
}
let chatTimer = null;
function agendarChat() {
  if (!CHAT_FILE || chatTimer) return;
  chatTimer = setTimeout(() => { chatTimer = null; gravarChat(); }, 400);
}
function gravarChat() { return gravarJson(CHAT_FILE, CHAT.lista.slice(-CHAT_MAX)); }

// o volume manda: chat e tags de plan/build voltam no restart
(function carregar() {
  const lista = lerJson(CHAT_FILE, []);
  if (Array.isArray(lista)) {
    for (const x of lista.slice(-CHAT_MAX)) {
      if (!x || !x.texto) continue;
      CHAT.lista.push(x);
      CHAT.seq = Math.max(CHAT.seq, Number(x.id) || 0);
    }
  }
  const tags = lerJson(TAGS_FILE, null);
  if (tags && typeof tags === "object") {
    for (const id of ["plan", "build"]) if (TAG_OK.test(tags[id])) TAGS[id] = tags[id];
  }
})();


// ---------- subagentes ----------
function touchChild(sid) {
  childActive.set(sid, Date.now());
  childDone.delete(sid);
}
function endChild(sid, force) {
  if (!childActive.has(sid) && !force) return;
  childActive.delete(sid);
  childDone.set(sid, Date.now());
}
function subView(id, status) {
  const i = childInfo.get(id) || {};
  // a tag so aparece se existir e couber no formato; undefined viraria "undefined" no regex
  const t = TAGS[id];
  return { id, name: i.name || "subagente", task: i.task || "", text: i.text || "", kind: i.kind || "think", tag: typeof t === "string" && TAG_OK.test(t) ? t : "", status, parent: main };
}
// subagente do Claude Code avisa quando termina (PostToolUse/SubagentStop): espera bem mais antes de dar como perdido
const childTimeout = (id) => (id.startsWith("cc:") ? 10 * 60000 : 25000);

// ---------- skills ----------
function addSkill(name, agent, by) {
  name = cut(name, 40);
  if (!name) return;
  S.skills = S.skills.filter((k) => !(k.name === name && k.agent === agent && k.by === (by || "")));
  S.skills.push({ t: Date.now(), name, agent, by: by || "" });
  if (S.skills.length > 6) S.skills.shift();
}

// ---------- estado e envio ----------
let pending = null;
function snapshot() {
  const now = Date.now();
  for (const [k, t] of childActive) if (now - t > childTimeout(k)) endChild(k);
  for (const [k, t] of childDone) if (now - t > 8000) childDone.delete(k);
  if (childInfo.size > 60) {
    for (const k of childInfo.keys()) {
      if (!childActive.has(k) && !childDone.has(k)) childInfo.delete(k);
      if (childInfo.size <= 40) break;
    }
  }
  S.subagents = childActive.size;
  S.subs = [
    ...[...childActive.keys()].map((id) => subView(id, "working")),
    ...[...childDone.keys()].map((id) => subView(id, "done")),
  ];
  const p = proj();
  S.files = p.edited.size;
  S.cost = [...p.costs.values()].reduce((a, b) => a + b, p.costBase);
  S.tags = { ...TAGS };
  S.chat = CHAT.lista.slice(-50);
  S.now = now;
  return S;
}
function push() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
    for (const r of clients) r.write(msg);
  }, 120);
}
function addLog(text) {
  const last = S.log[S.log.length - 1];
  if (last && last.text === text) return;
  S.log.push({ t: Date.now(), agent: main, text });
  if (S.log.length > 8) S.log.shift();
}
const isAgent = (w) => w === "plan" || w === "build";
const NOMES = { plan: "Auditor", build: "Construtor" };
// aviso no celular quando o agente muda de estado (so no modo "fora")
function avisarCelular(who, status, text) {
  if (!S.fora || !REMOTO) return;
  const nome = NOMES[who], onde = S.project ? " · " + S.project : "";
  const link = remoteIp ? `http://${remoteIp}:${PORT}/` : "";
  if (status === "waiting") remoto.avisar(REMOTO, { titulo: nome + " precisa de você" + onde, texto: text || "pedido de permissão", prioridade: "high", tags: "raising_hand", link });
  if (status === "done") remoto.avisar(REMOTO, { titulo: nome + " terminou" + onde, texto: (S.log.filter((l) => l.text !== "terminou").pop() || {}).text || "pronto!", tags: "white_check_mark", link });
  if (status === "error") remoto.avisar(REMOTO, { titulo: nome + " deu erro" + onde, texto: text || "erro", prioridade: "high", tags: "x", link });
}
function setA(who, status, text, kind) {
  if (!isAgent(who)) return false; // "__proto__", "constructor"... viriam do Object.prototype
  const a = S.agents[who];
  if (a.status !== status) avisarCelular(who, status, text);
  if (status === "working" && (a.status === "idle" || a.status === "done" || a.status === "error")) a.since = Date.now();
  if (status === "waiting" && !a.since) a.since = Date.now();
  a.status = status;
  if (text !== undefined) a.text = text;
  if (kind !== undefined) a.kind = kind;
  // o mesmo texto que vira balao entra no chat (vazio e silencio nao entram)
  if (text && status !== "idle") fala(who, NOMES[who] || who, kind, text);
  if (status === "working" || status === "waiting") lastSignal = Date.now();
  if (status === "done") a.until = Date.now() + 8000;
  if (status === "error") a.until = Date.now() + 20000;
  if (status === "idle") a.since = 0;
  push();
  return true;
}
function work(text, kind) {
  const o = other(main);
  if (S.agents[o].status === "working" || S.agents[o].status === "waiting") setA(o, "idle");
  if (S.agents[main].status === "waiting") return; // espera a resposta da permissao
  setA(main, "working", text, kind);
}
// keepBg: subagentes em segundo plano continuam trabalhando depois que o agente principal para
function finish(keepBg) {
  for (const k of [...childActive.keys()]) if (!(keepBg && (childInfo.get(k) || {}).bg)) endChild(k);
  for (const w of ["plan", "build"]) {
    const a = S.agents[w];
    if (a.status === "working") setA(w, "done", "pronto!", "think");
    else if (a.status === "waiting") setA(w, "idle");
  }
  addLog("terminou");
  push();
}
function idleAll() {
  for (const w of ["plan", "build"]) if (S.agents[w].status !== "idle") setA(w, "idle");
}

// ---------- traducao dos eventos do opencode ----------
function describe(part) {
  const tool = String(part.tool || "").toLowerCase();
  const input = (part.state && part.state.input) || {};
  const file = base(input.filePath || input.path || input.file || input.filename || "");
  switch (tool) {
    case "read": return ["lendo " + (file || "arquivo"), "read"];
    case "edit": case "write": case "patch": case "multiedit": case "apply_patch":
      return ["editando " + (file || "arquivo"), "edit"];
    case "bash": return ["rodando " + cut(input.command || input.description || "comando", 40), "bash"];
    case "grep": return ["procurando " + cut(input.pattern || "", 32), "search"];
    case "glob": return ["procurando arquivos " + cut(input.pattern || "", 28), "search"];
    case "list": case "ls": return ["listando " + (file || "pasta"), "search"];
    case "webfetch": case "websearch": case "codesearch": return ["pesquisando na web", "web"];
    case "task": return ["chamando subagente" + (input.description ? ": " + cut(input.description, 30) : ""), "think"];
    case "todowrite": case "todoread": return ["organizando tarefas", "think"];
    default: return [cut(part.tool || "trabalhando", 30), "think"];
  }
}
const isEditTool = (t) => ["edit", "write", "patch", "multiedit", "apply_patch"].includes(String(t || "").toLowerCase());

function sample(t, p) {
  let key = t;
  if (t === "message.part.updated" && p.part) key += ":" + p.part.type + ":" + (p.part.tool || "");
  if (t === "message.updated" && p.info) key += ":" + p.info.role + ":" + (p.info.agent || p.info.mode || "");
  if (sampled.has(key)) return;
  sampled.add(key);
  note(key + " " + JSON.stringify(p).slice(0, 600));
}

function handle(ev) {
  const t = ev && ev.type;
  const p = (ev && ev.properties) || {};
  if (!t) return;
  sample(t, p);

  switch (t) {
    case "session.created":
    case "session.updated": {
      const i = p.info || {};
      if (t === "session.created" && i.id && !i.parentID && i.id !== S.session) { S.session = i.id; push(); }
      if (i.id) {
        sessions.set(i.id, { parentID: i.parentID });
        cap(sessions, 500);
        if (i.parentID) {
          const old = childInfo.get(i.id) || {};
          const m = /\(@([\w-]+)\s+subagent\)/i.exec(i.title || "");
          childInfo.set(i.id, {
            name: (m && m[1]) || old.name || "subagente",
            task: cut((i.title || "").replace(/\s*\(@[\w-]+\s+subagent\)\s*$/i, ""), 60) || old.task || "",
            text: old.text || "",
            kind: old.kind || "think",
          });
        }
        if (!i.parentID && i.directory) { const d = base(i.directory); if (d && d !== S.project) { S.project = d; push(); } }
      }
      break;
    }

    case "message.updated": {
      const i = p.info;
      if (!i) break;
      if (isChild(i.sessionID)) { touchChild(i.sessionID); lastSignal = Date.now(); push(); break; }
      const a = pick(i.agent || i.mode);
      if (a) main = a;
      if (i.role === "user") wakeWindow(true); // novo pedido no opencode
      if (i.role === "assistant") {
        if (i.modelID) S.model = i.modelID;
        if (typeof i.cost === "number" && i.id) addCost(i.id, i.cost);
        const tk = i.tokens;
        if (tk) {
          const sum = (tk.input || 0) + (tk.output || 0) + (tk.reasoning || 0) + ((tk.cache && tk.cache.read) || 0) + ((tk.cache && tk.cache.write) || 0);
          if (sum > 0) S.ctxTokens = sum;
        }
        if (S.agents[main].status !== "working") work("pensando…", "think");
        else { lastSignal = Date.now(); push(); }
      }
      break;
    }

    case "message.part.updated": {
      const part = p.part;
      if (!part) break;
      const child = isChild(part.sessionID);
      if (child) touchChild(part.sessionID);
      let text, kind;
      if (part.type === "tool") {
        [text, kind] = describe(part);
        const st = part.state && part.state.status;
        if (st === "completed" && isEditTool(part.tool)) {
          const f = (part.state.input && (part.state.input.filePath || part.state.input.path)) || "";
          if (f) addEdited(f);
        }
        const id = part.id || part.callID;
        if (id && !loggedParts.has(id)) { loggedParts.add(id); cap(loggedParts, 1000); addLog((child ? "› " : "") + text); }
      } else if (part.type === "reasoning") { text = "pensando…"; kind = "think"; }
      else if (part.type === "text") { text = "escrevendo a resposta…"; kind = "edit"; }
      else break;
      if (child) {
        const ci = childInfo.get(part.sessionID) || { name: "subagente", task: "" };
        childInfo.set(part.sessionID, { ...ci, text, kind });
        text = "› " + text;
      }
      work(text, kind);
      break;
    }

    case "permission.asked":
    case "permission.updated": {
      const what = p.permission || p.type || "acao";
      const pat = (Array.isArray(p.patterns) ? p.patterns[0] : p.pattern) || p.title || "";
      const txt = "pedindo permissão: " + what + (pat ? " " + cut(pat, 36) : "");
      const o = other(main);
      if (S.agents[o].status === "working") setA(o, "idle");
      setA(main, "waiting", txt, "wait");
      addLog(txt);
      if (p.id && p.sessionID && !perms.has("oc:" + p.id)) addPedido("oc:" + p.id, { src: "oc", sid: p.sessionID, ocId: p.id }, what + (pat ? ": " + pat : ""));
      break;
    }
    case "permission.replied": {
      const rid = p.permissionID || p.requestID || p.id;
      if (rid && perms.has("oc:" + rid)) dropPedido("oc:" + rid);
      if (S.agents[main].status === "waiting") setA(main, "working", "continuando…", "think");
      break;
    }

    case "session.error": {
      if (p.sessionID && isChild(p.sessionID)) break;
      const e = p.error || {};
      const name = e.name || "";
      if (/abort/i.test(name)) { idleAll(); break; }
      const msg = cut((e.data && e.data.message) || e.message || name || "erro", 90);
      const o = other(main);
      if (S.agents[o].status !== "idle") setA(o, "idle");
      setA(main, "error", msg, "think");
      addLog("erro: " + msg);
      break;
    }

    case "session.status": {
      const sid = p.sessionID;
      const st = p.status || {};
      if (sid && isChild(sid)) { if (st.type === "idle") { endChild(sid); push(); } break; }
      if (st.type === "retry") work("⚠ tentando de novo (" + (st.attempt || "?") + "): " + cut(st.message || "", 60), "think");
      else if (st.type === "busy") { if (S.agents[main].status !== "working") work("trabalhando…", "think"); }
      else if (st.type === "idle") finish();
      break;
    }

    case "session.idle": {
      const sid = p.sessionID;
      if (sid && isChild(sid)) { endChild(sid); push(); break; }
      finish();
      break;
    }
  }
}

// ---------- janela do escritorio ----------
const { exec } = require("child_process");
const janela = require("./janela");
const W = S.janela; // { pinned: sempre por cima, hidden: o usuario apertou "ocultar" }
let lastOpen = 0;
const locais = () => [...clients].filter((r) => !r.remoto).length; // o celular nao conta como janela aberta

let opener = Object.assign((url) => {
  if (process.platform === "win32") {
    // abre como janela de aplicativo (igual a do opencode); se nao tiver Edge, usa o navegador padrao
    exec(`start "" msedge --app=${url} --window-size=1280,800`, (err) => { if (err) exec(`start "" ${url}`); });
  } else if (process.platform === "darwin") exec(`open ${url}`);
  else exec(`xdg-open ${url}`);
}, { real: true });
function openOffice() {
  if (process.env.OPEN_BROWSER === "0" && opener.real) return;
  if (locais() > 0 || Date.now() - lastOpen < 60000) return; // ja esta aberto
  lastOpen = Date.now();
  opener(`http://localhost:${PORT}`);
}

// o agente comecou a trabalhar: abre a janela, ou restaura se estiver minimizada.
// So o botao "ocultar" da pagina segura a janela escondida, e so ate o proximo pedido.
function wakeWindow(newRequest) {
  if (newRequest && W.hidden) { W.hidden = false; push(); }
  if (W.hidden) return;
  // procura a janela pelo titulo antes de abrir outra (logo apos reiniciar o servidor,
  // a janela que ja existe ainda esta reconectando e clients fica vazio)
  janela.send("restore").then((r) => {
    if (r === "ok") { if (W.pinned) janela.send("pin"); }
    else if (locais() === 0) openOffice();
  });
}

// acoes dos botoes da pagina: { acao: "ocultar" } ou { acao: "fixar", on: true|false }
function windowAction(j) {
  if (j.acao === "ocultar") { W.hidden = true; janela.send("minimize"); }
  else if (j.acao === "fixar") { W.pinned = !!j.on; janela.send(W.pinned ? "pin" : "unpin"); }
  else return false;
  push();
  return true;
}

// ---------- permissoes respondidas pelo painel (no PC ou no celular) ----------
// Claude Code: no modo "fora" o servidor segura a resposta do hook PermissionRequest ate alguem responder.
// opencode: o pedido aparece no painel sempre; a resposta vai para a API do opencode.
const perms = new Map(); // id -> { src: "cc"|"oc", agent, fim?, sid?, ocId?, sugestoes? }
const ESPERA = 9 * 60000; // o hook espera ate 10 min (timeout do instalar-claude.js)

function addPedido(id, info, text) {
  info.agent = main;
  perms.set(id, info);
  S.pedidos = S.pedidos.filter((x) => x.id !== id);
  S.pedidos.push({ id, t: Date.now(), agent: main, text: cut(text, 160), sempre: info.src === "oc" || !!info.sugestoes });
  while (S.pedidos.length > 10) dropPedido(S.pedidos[0].id);
  push();
}
// tira o pedido da tela; "out" e a resposta para o hook do Claude Code (vazio: o Claude pergunta no terminal)
function dropPedido(id, out) {
  const p = perms.get(id);
  perms.delete(id);
  S.pedidos = S.pedidos.filter((x) => x.id !== id);
  if (p && p.fim) p.fim(out);
  push();
  return p;
}

// texto do pedido com mais detalhe que o balao (o comando inteiro, o arquivo...)
function ccPedidoTexto(name, input) {
  input = input || {};
  const det = input.command || input.file_path || input.notebook_path || input.url || input.query || input.pattern || input.description || "";
  return (name || "ferramenta") + (det ? ": " + det : "");
}

function segurar(p, res) {
  const id = "cc:" + crypto.randomBytes(6).toString("hex");
  const timer = setTimeout(() => dropPedido(id), ESPERA);
  const fim = (out) => {
    clearTimeout(timer);
    if (res.writableEnded || res.destroyed) return;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(out || "");
  };
  // o hook foi encerrado (o Claude desistiu, o usuario interrompeu...): o pedido some do painel
  res.on("close", () => { if (perms.has(id)) dropPedido(id); });
  const sug = Array.isArray(p.permission_suggestions) && p.permission_suggestions.length ? p.permission_suggestions : null;
  addPedido(id, { src: "cc", fim, sugestoes: sug }, ccPedidoTexto(p.tool_name, p.tool_input));
}

function ocResponder(sid, pid, resposta) {
  const post = (p, body, cb) => {
    const data = JSON.stringify(body);
    const r = http.request({ host: "127.0.0.1", port: OC_PORT, path: p, method: "POST", timeout: 5000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) } }, (res) => { res.resume(); cb && cb(res.statusCode); });
    r.on("timeout", () => r.destroy());
    r.on("error", () => {});
    r.end(data);
  };
  // versoes mais novas do opencode usam /permission/:id/reply
  post(`/session/${encodeURIComponent(sid)}/permissions/${encodeURIComponent(pid)}`, { response: resposta }, (st) => {
    if (st >= 400) post(`/permission/${encodeURIComponent(pid)}/reply`, { reply: resposta });
  });
}

// decisao: "sim" (so desta vez), "sempre" ou "nao"
function responder(id, decisao) {
  if (!["sim", "sempre", "nao"].includes(decisao) || !perms.has(id)) return false;
  const p = perms.get(id);
  if (p.src === "cc") {
    const d = decisao === "nao" ? { behavior: "deny", message: "Negado pelo painel do Escritorio." } : { behavior: "allow" };
    if (decisao === "sempre" && p.sugestoes) d.updatedPermissions = p.sugestoes;
    dropPedido(id, JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: d } }));
  } else {
    dropPedido(id);
    ocResponder(p.sid, p.ocId, decisao === "nao" ? "reject" : decisao === "sempre" ? "always" : "once");
  }
  addLog(decisao === "nao" ? "permissão negada pelo painel" : "permitido pelo painel");
  if (S.agents[p.agent].status === "waiting") setA(p.agent, "working", "continuando…", "think");
  return true;
}

// modo "fora": desligado, as permissoes seguradas voltam para o terminal
function setFora(on) {
  S.fora = !!on;
  if (!S.fora) for (const [id, p] of [...perms]) if (p.src === "cc") dropPedido(id);
  push();
}

// ---------- Claude Code (eventos enviados pelos hooks em POST /claude) ----------
const ccSessions = new Map(); // session_id -> ultimo sinal
const ccSubs = new Map(); // agent_id do subagente -> id usado na tela

function ccRefresh() {
  const now = Date.now();
  for (const [k, t] of ccSessions) if (now - t > 30 * 60000) ccSessions.delete(k);
  const on = ccSessions.size > 0;
  if (S.cc !== on) { S.cc = on; push(); }
}

// le o final da transcricao para mostrar modelo e tamanho do contexto
function ccUsage(file) {
  try {
    if (!file || !fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    const len = Math.min(size, 256 * 1024);
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const l of lines) {
      if (!l.includes('"usage"')) continue;
      try {
        const m = JSON.parse(l).message;
        if (!m || !m.usage) continue;
        const u = m.usage;
        const sum = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        if (sum > 0) S.ctxTokens = sum;
        if (m.model) S.model = m.model;
        return;
      } catch {}
    }
  } catch {}
}

function ccDescribe(name, input) {
  input = input || {};
  const file = base(input.file_path || input.notebook_path || input.path || "");
  switch (name) {
    case "Read": return ["lendo " + (file || "arquivo"), "read"];
    case "Edit": case "MultiEdit": case "Write": case "NotebookEdit": return ["editando " + (file || "arquivo"), "edit"];
    case "Bash": case "PowerShell": case "BashOutput": return ["rodando " + cut(input.command || input.description || "comando", 40), "bash"];
    case "Grep": return ["procurando " + cut(input.pattern || "", 32), "search"];
    case "Glob": return ["procurando arquivos " + cut(input.pattern || "", 28), "search"];
    case "LS": return ["listando " + (file || "pasta"), "search"];
    case "WebFetch": case "WebSearch": return ["pesquisando na web", "web"];
    case "Task": case "Agent": return ["chamando subagente" + (input.description ? ": " + cut(input.description, 30) : ""), "think"];
    case "TodoWrite": case "TaskCreate": case "TaskUpdate": return ["organizando tarefas", "think"];
    case "Skill": return ["usando a skill " + cut(input.skill || input.command || input.name || "", 30), "skill"];
    default:
      if (String(name).startsWith("mcp__")) return ["usando " + cut(String(name).split("__").slice(1).join(" "), 30), "web"];
      return [cut(name || "trabalhando", 30), "think"];
  }
}

// descobre a qual subagente da tela pertence um evento vindo de dentro de um subagente
function ccChild(p) {
  if (!p.agent_id) return null;
  if (ccSubs.has(p.agent_id)) return ccSubs.get(p.agent_id);
  const used = new Set(ccSubs.values());
  const livres = [...childActive.keys()].reverse().filter((k) => k.startsWith("cc:") && !used.has(k));
  // de preferencia um subagente do mesmo tipo (varios podem ter sido chamados de uma vez)
  const free = livres.find((k) => (childInfo.get(k) || {}).name === p.agent_type) || livres[0];
  const id = free || "cc:" + p.agent_id;
  ccSubs.set(p.agent_id, id);
  cap(ccSubs, 100);
  if (!childInfo.has(id)) childInfo.set(id, { name: p.agent_type || "subagente", task: "", text: "", kind: "think" });
  return id;
}

function handleClaude(p) {
  const ev = p.hook_event_name;
  if (!ev) return;
  note("claude:" + ev + " " + JSON.stringify(p).slice(0, 400));
  if (p.session_id) ccSessions.set(p.session_id, Date.now());
  if (p.cwd) { const d = base(p.cwd); if (d && d !== S.project) S.project = d; }
  ccRefresh();

  switch (ev) {
    case "SessionStart":
      if (p.session_id && !p.agent_id) S.session = p.session_id;
      wakeWindow(false);
      ccUsage(p.transcript_path);
      push();
      break;

    case "UserPromptSubmit": {
      if (p.session_id && !p.agent_id) S.session = p.session_id;
      wakeWindow(true);
      main = p.permission_mode === "plan" ? "plan" : "build";
      if (S.agents[main].status === "waiting") S.agents[main].status = "working";
      // "/nome-da-skill ..." digitado pelo usuario (so o nome sai do prompt)
      const slash = /^\/([\w:-]+)/.exec(String(p.prompt || "").trim());
      if (slash) { addSkill(slash[1], main); work("usando a skill " + cut(slash[1], 30), "skill"); }
      else work("pensando…", "think");
      addLog(slash ? "novo pedido: /" + cut(slash[1], 30) : "novo pedido");
      break;
    }

    case "PreToolUse": {
      const [text, kind] = ccDescribe(p.tool_name, p.tool_input);
      const skill = p.tool_name === "Skill" && text.slice("usando a skill ".length);
      if (p.tool_name === "ExitPlanMode") main = "plan";
      const child = ccChild(p); // antes de criar um subagente novo: ele nao pode ser confundido com o pai
      if (p.tool_name === "Task" || p.tool_name === "Agent") {
        const id = "cc:" + (p.tool_use_id || Date.now());
        const i = p.tool_input || {};
        childInfo.set(id, { name: i.subagent_type || "subagente", task: cut(i.description || i.prompt || "", 60), text: "começando…", kind: "think", bg: !!i.run_in_background });
        touchChild(id);
        addLog(text);
        if (!child) { work(text, kind); break; }
      }
      if (child) {
        // evento de dentro de um subagente: atualiza so o subagente (o principal segue esperando por ele)
        const ci = childInfo.get(child) || {};
        if (p.tool_name !== "Task" && p.tool_name !== "Agent") childInfo.set(child, { ...ci, text, kind });
        touchChild(child);
        if (skill) addSkill(skill, "sub", ci.name);
        addLog("› " + (ci.name || "subagente") + ": " + text);
        lastSignal = Date.now();
        push();
        break;
      }
      if (skill) addSkill(skill, main);
      addLog(text);
      if (S.agents[main].status === "waiting") S.agents[main].status = "working";
      work(text, kind);
      break;
    }

    case "PostToolUse":
    case "PostToolUseFailure": {
      const i = p.tool_input || {};
      if (["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(p.tool_name) && (i.file_path || i.notebook_path)) addEdited(i.file_path || i.notebook_path);
      if (p.tool_name === "Task" || p.tool_name === "Agent") {
        const id = "cc:" + p.tool_use_id;
        const r = JSON.stringify(p.tool_response || "").slice(0, 4000);
        const ci = childInfo.get(id);
        // em segundo plano a ferramenta volta na hora: o subagente segue trabalhando ate o SubagentStop
        if (ci && (ci.bg || /async|background|launched/i.test(r))) {
          ci.bg = true;
          const m = /agent_?id\W{0,4}([\w-]{6,})/i.exec(r);
          if (m && !ccSubs.has(m[1])) ccSubs.set(m[1], id);
          touchChild(id);
        } else {
          endChild(id, true);
          for (const [k, v] of ccSubs) if (v === id) ccSubs.delete(k);
        }
      } else {
        const child = ccChild(p);
        if (child) touchChild(child);
      }
      if (S.agents[main].status === "waiting") S.agents[main].status = "working";
      ccUsage(p.transcript_path);
      lastSignal = Date.now();
      push();
      break;
    }

    case "PermissionRequest":
    case "Notification": {
      const type = p.notification_type || "";
      if (ev === "Notification" && type && type !== "permission_prompt") break; // "idle_prompt" etc. nao muda nada
      if (ev === "Notification" && !type && !/permiss|permission|approve/i.test(p.message || "")) break;
      const txt = ev === "PermissionRequest"
        ? "pedindo permissão: " + cut(ccDescribe(p.tool_name, p.tool_input)[0], 40)
        : cut(p.message || "pedindo permissão", 60);
      const o = other(main);
      if (S.agents[o].status === "working") setA(o, "idle");
      setA(main, "waiting", txt, "wait");
      addLog(txt);
      break;
    }

    case "SubagentStart": {
      const id = ccChild(p);
      if (id) touchChild(id);
      push();
      break;
    }

    case "SubagentStop": {
      const used = new Set(ccSubs.values());
      // sem nenhum evento de dentro dele: encerra o subagente em segundo plano mais antigo do mesmo tipo
      const id = (p.agent_id && ccSubs.get(p.agent_id)) ||
        [...childActive.keys()].find((k) => k.startsWith("cc:") && !used.has(k) && (childInfo.get(k) || {}).bg && childInfo.get(k).name === p.agent_type);
      if (id) { endChild(id, true); ccSubs.delete(p.agent_id); }
      push();
      break;
    }

    case "PreCompact":
      work("organizando a memória…", "think");
      break;

    case "StopFailure": {
      const msg = cut(p.error || p.message || "erro na API", 90);
      setA(main, "error", msg, "think");
      addLog("erro: " + msg);
      break;
    }

    case "Stop":
      if (p.agent_id) break; // Stop vindo de dentro de um subagente nao encerra o principal
      ccUsage(p.transcript_path);
      for (const [k, v] of ccSubs) if (!childActive.has(v) || !(childInfo.get(v) || {}).bg) ccSubs.delete(k);
      finish(true);
      break;

    case "SessionEnd":
      ccSessions.delete(p.session_id);
      ccRefresh();
      if (!ccSessions.size && !S.oc) idleAll();
      break;
  }
}

// ---------- conexao com o servidor do opencode ----------
// entrega cada evento SSE completo (varias linhas "data:" viram uma so) e devolve o resto do buffer
function sseEvents(buf, onData) {
  let i;
  while ((i = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (data) onData(data);
  }
  return buf.length > 5 * 1024 * 1024 ? "" : buf; // evento sem fim: descarta
}

function connectOpencode() {
  let finished = false;
  const retry = () => {
    if (finished) return;
    finished = true;
    if (S.oc) { S.oc = false; idleAll(); push(); }
    setTimeout(connectOpencode, 3000);
  };
  const req = http.get(
    { host: "127.0.0.1", port: OC_PORT, path: "/event", headers: { Accept: "text/event-stream" } },
    (res) => {
      if (res.statusCode !== 200) { res.resume(); return retry(); }
      S.oc = true;
      push();
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        buf = sseEvents(buf + chunk.replace(/\r/g, ""), (data) => { try { handle(JSON.parse(data)); } catch {} });
      });
      res.on("end", retry);
      res.on("error", retry);
    }
  );
  req.on("error", retry);
}

// ---------- relogio: expira "pronto"/"erro" e cobre eventos de fim perdidos ----------
function tick() {
  const now = Date.now();
  for (const w of ["plan", "build"]) {
    const a = S.agents[w];
    if ((a.status === "done" || a.status === "error") && now > a.until) setA(w, "idle");
    if (a.status === "working" && now - lastSignal > 120000) setA(w, "idle");
  }
  if (childActive.size || childDone.size) push();
}

// ---------- HTTP ----------
// um erro num request nunca pode derrubar o servidor inteiro
const atender = (rem) => (req, res) => {
  req.remoto = rem;
  try { route(req, res); }
  catch (e) { try { if (!res.headersSent) res.writeHead(500); res.end(); } catch {} }
};
const server = http.createServer(atender(false));

// celular: um segundo servidor, so no IP do Tailscale (nunca 0.0.0.0), e so com o token
let remoteServer = null, remoteIp = "";
function ligarRemoto(ip, port) {
  remoteIp = ip;
  remoteServer = http.createServer(atender(true));
  return new Promise((ok) => {
    remoteServer.on("error", (e) => { console.log("Painel do celular nao ligou em " + ip + ": " + e.code); remoteServer = null; remoteIp = ""; ok(0); });
    remoteServer.listen(port, ip, () => ok(remoteServer.address().port));
  });
}

// so a propria pagina e os hooks locais podem falar com o servidor: bloqueia
// outros sites abertos no navegador (leitura do /events, /set via <img>...) e DNS rebinding
const LOCAL = /^(localhost|127\.0\.0\.1)(:\d+)?$/i;
// no celular: o IP do Tailscale ou o nome do MagicDNS (maquina.tailnet.ts.net)
const hostRemoto = (host) => { const h = host.replace(/:\d+$/, ""); return (!!remoteIp && h === remoteIp) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.ts\.net$/.test(h); };
function allowed(req) {
  const host = String(req.headers.host || "").toLowerCase();
  if (!(req.remoto ? hostRemoto(host) : LOCAL.test(host))) return false;
  const site = req.headers["sec-fetch-site"];
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host.toLowerCase() !== host) return false; } catch { return false; } }
  return true;
}

// le o corpo inteiro em UTF-8, com limite (os hooks mandam o conteudo dos arquivos escritos)
const MAX_BODY = 10 * 1024 * 1024;
function readBody(req, res, done) {
  let body = "", size = 0, over = false;
  req.setEncoding("utf8");
  req.on("data", (c) => {
    if (over) return;
    size += Buffer.byteLength(c);
    if (size > MAX_BODY) { over = true; res.writeHead(413, { Connection: "close" }); res.end(); return; }
    body += c;
  });
  req.on("end", () => { if (!over) done(body); });
}

// arquivos da pagina: so dentro de js/, css/ e vendor/ (nunca ../ nem outros arquivos do projeto)
const STATIC_DIRS = ["js", "css", "vendor"];
const TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".txt": "text/plain; charset=utf-8" };
function serveStatic(pathname, res) {
  const rel = path.normalize(decodeURIComponent(pathname)).replace(/^[\\/]+/, "");
  const dir = rel.split(/[\\/]/)[0];
  if (!STATIC_DIRS.includes(dir)) return false;
  const file = path.join(__dirname, rel);
  if (!file.startsWith(path.join(__dirname, dir) + path.sep)) return false;
  const type = TYPES[path.extname(file).toLowerCase()];
  let st;
  try { st = fs.statSync(file); } catch { return false; }
  if (!type || !st.isFile()) return false;
  // vendor/ nao muda; o resto muda enquanto o escritorio e desenvolvido
  res.writeHead(200, { "Content-Type": type, "Content-Length": st.size, "Cache-Control": dir === "vendor" ? "max-age=86400" : "no-cache" });
  fs.createReadStream(file).pipe(res);
  return true;
}

// celular: o link com ?t=<token> grava um cookie; depois so o cookie vale.
// Pelo celular so a pagina, o estado e as respostas (nada de /set, /claude, /janela...)
const REMOTE_PATHS = new Set(["/", "/index.html", "/events", "/responder", "/fora", "/chat", "/favicon.ico"]);
function remoteAuth(req, res, url) {
  const t = url.searchParams.get("t");
  if (t !== null && remoto.tokenOk(REMOTO, t)) {
    res.writeHead(302, { "Set-Cookie": `esc_t=${REMOTO.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`, Location: "/", "Cache-Control": "no-store" });
    res.end();
    return false;
  }
  if (!remoto.tokenOk(REMOTO, remoto.cookieToken(req))) {
    res.writeHead(401, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Abra o link com o token (rode node remoto.js no computador para ver o link).");
    return false;
  }
  if (REMOTE_PATHS.has(url.pathname) || /^\/(js|css|vendor)\//.test(url.pathname)) return true;
  res.writeHead(403);
  res.end();
  return false;
}

function route(req, res) {
  if (!allowed(req)) { res.writeHead(403); return res.end(); }
  // base fixa: o cabecalho Host vem de fora e pode ser invalido
  const url = new URL(req.url, "http://localhost");
  if (req.remoto && !remoteAuth(req, res, url)) return;

  if (url.pathname === "/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
    res.remoto = req.remoto;
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  // teste manual: /set?agent=plan&status=working|waiting|error|done|idle&kind=edit&text=ola
  if (url.pathname === "/set") {
    const q = url.searchParams;
    const who = q.get("agent");
    const status = q.get("status") || "working";
    const ok = ["idle", "working", "waiting", "error", "done"].includes(status) &&
      setA(who, status, q.get("text") || (status === "working" ? "teste manual" : ""), q.get("kind") || "think");
    if (ok && status !== "idle") main = who;
    res.writeHead(ok ? 200 : 400);
    return res.end(ok ? "ok" : "use agent=plan|build e status=idle|working|waiting|error|done");
  }

  // teste manual de subagente: /sub?id=a1&name=explore&task=buscar&text=procurando&kind=search&tag=backend&status=working|done
  if (url.pathname === "/sub") {
    const q = url.searchParams;
    const id = q.get("id") || "teste";
    const tag = String(q.get("tag") || "");
    if (tag && TAG_OK.test(tag) && SLUG_OK.test(id)) TAGS[id] = tag;
    if ((q.get("status") || "working") === "done") {
      endChild(id, true);
    } else {
      const old = childInfo.get(id) || {};
      const info = {
        name: q.get("name") || old.name || "explore",
        task: q.get("task") || old.task || "",
        text: q.get("text") || old.text || "",
        kind: q.get("kind") || old.kind || "think",
      };
      childInfo.set(id, info);
      touchChild(id);
      // o balao do morador tambem entra no chat; texto vazio nao fala nada
      if (q.get("text")) fala(id, info.name, info.kind, info.text);
    }
    note("sub " + (q.get("status") || "working") + " " + id + " " + (q.get("text") || "").slice(0, 200));
    push();
    res.writeHead(200);
    return res.end("ok");
  }

  // tag de funcao: /tag?id=leme&tag=backend (o tsv continua sendo a fonte dos moradores)
  if (url.pathname === "/tag") {
    const q = url.searchParams;
    const id = String(q.get("id") || "");
    const tag = String(q.get("tag") || "");
    const ok = (SLUG_OK.test(id) || id === "plan" || id === "build") && TAG_OK.test(tag);
    if (!ok) {
      res.writeHead(400);
      return res.end("use id de morador (ou plan|build) e tag [a-z0-9-] ate 16 caracteres");
    }
    TAGS[id] = tag;
    if (id === "plan" || id === "build") salvarTags();
    note("tag " + id + " " + tag);
    push();
    res.writeHead(200);
    return res.end("ok");
  }

  // historico do chat para abrir a pagina ja com as falas: /chat?n=50
  if (url.pathname === "/chat") {
    const pedido = parseInt(url.searchParams.get("n") || "50", 10) || 50;
    const n = Math.max(1, Math.min(CHAT_MAX, pedido));
    const body = JSON.stringify(CHAT.lista.slice(-n));
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(body) });
    return res.end(body);
  }

  // botoes da janela: ocultar e sempre por cima
  if (url.pathname === "/janela" && req.method === "POST") {
    return readBody(req, res, (body) => {
      let ok = false;
      try { ok = windowAction(JSON.parse(body || "{}")); } catch {}
      const out = JSON.stringify(W);
      res.writeHead(ok ? 200 : 400, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(out) });
      res.end(out);
    });
  }

  // eventos dos hooks do Claude Code
  if (url.pathname === "/claude" && req.method === "POST") {
    return readBody(req, res, (body) => {
      let p;
      try { p = JSON.parse(body || "{}"); handleClaude(p); }
      catch { res.writeHead(400); return res.end(); }
      // modo "fora": o hook espera a resposta dada pelo painel (no celular)
      if (p && p.hook_event_name === "PermissionRequest" && S.fora) return segurar(p, res);
      res.writeHead(200);
      res.end();
    });
  }

  // resposta a um pedido de permissao: { id, decisao: "sim" | "sempre" | "nao" }
  if (url.pathname === "/responder" && req.method === "POST") {
    return readBody(req, res, (body) => {
      let ok = false;
      try { const j = JSON.parse(body || "{}"); ok = responder(String(j.id || ""), j.decisao); } catch {}
      res.writeHead(ok ? 200 : 404);
      res.end();
    });
  }

  // modo "fora": { on: true | false }
  if (url.pathname === "/fora" && req.method === "POST") {
    return readBody(req, res, (body) => {
      let j = null;
      try { j = JSON.parse(body || "{}"); } catch {}
      if (!j || typeof j.on !== "boolean") { res.writeHead(400); return res.end(); }
      setFora(j.on);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ fora: S.fora }));
    });
  }

  if (url.pathname === "/state" && req.method === "POST") {
    return readBody(req, res, (body) => {
      try {
        const j = JSON.parse(body || "{}");
        res.writeHead(setA(j.agent, j.status === "working" ? "working" : "idle", j.text, j.kind) ? 200 : 400);
      } catch { res.writeHead(400); }
      res.end();
    });
  }

  if (serveStatic(url.pathname, res)) return;

  if (url.pathname === "/favicon.ico") { res.writeHead(204); return res.end(); }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(res);
  }

  res.writeHead(404);
  res.end();
}

function start() {
  connectOpencode();
  setInterval(tick, 1000);
  setInterval(() => { for (const r of clients) r.write(": ping\n\n"); }, 20000);
  setInterval(ccRefresh, 60000);
  // 127.0.0.1: so aceita conexoes da propria maquina
  server.listen(PORT, HOST, () =>
    console.log(`Escritorio em http://localhost:${PORT} (${HOST}; ouvindo opencode na porta ${OC_PORT} e Claude Code em /claude)`));
  // celular: espera o Tailscale aparecer (ele pode ligar depois do servidor)
  const tentar = () => {
    if (!REMOTO || remoteServer) return;
    const ip = REMOTO.ip || remoto.ipTailscale();
    if (ip) ligarRemoto(ip, PORT).then((p) => p && console.log(`Painel no celular: http://${ip}:${p}/ (abra uma vez o link do node remoto.js)`));
  };
  tentar();
  setInterval(tentar, 30000);
}

// "node server.js" liga tudo; os testes so importam as funcoes
if (require.main === module) start();
module.exports = { _setOpener: (fn) => { opener = fn; }, _setRemoto: (c) => { REMOTO = c; S.remoto = !!c; }, ligarRemoto,
  remoteServer: () => remoteServer, responder, setFora, S, server, handle, handleClaude, snapshot, setA, sseEvents,
  fala, tags: () => ({ ...TAGS }), chat: () => CHAT.lista.slice(), _gravarChat: gravarChat, _dados: () => DADOS,
  sizes: () => ({ sessions: sessions.size, loggedParts: loggedParts.size, ccSubs: ccSubs.size, projects: projects.size }) };