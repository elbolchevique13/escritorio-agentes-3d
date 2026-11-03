// HUD: barra do topo, contexto, log de atividade e avisos quando um agente muda de estado.
import { config } from './config.js';
import { beep, SONS, notificar, ligarSom } from './avisos.js';
import { janela, responder, fora } from './conexao.js';

const $ = (id) => document.getElementById(id);
const fmtK = (n) => n >= 100000 ? Math.round(n / 1000) + 'K' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
const fmtT = (ms) => { const s = Math.max(0, Math.floor(ms / 1000)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
export const NOMES = { plan: 'Auditor', build: 'Construtor' };

const prev = { plan: 'idle', build: 'idle' };
const inicio = { plan: 0, build: 0 };
let ultimaDur = 0, atual = null, acoesHud = {}, chavePedidos = '';
const local = /^(localhost|127\.0\.0\.1)$/.test(location.hostname); // no celular a janela do PC nao e controlada

// icone do kind no chat (o mesmo kind que pinta o balao e o telao)
const KIND_ICONE = { think: '💭', read: '📖', edit: '✏️', bash: '⌨️', search: '🔎', web: '🌐', wait: '✋', skill: '✨' };
const chat = { ids: new Set(), slugs: new Map(), carregado: false };

// chamado a cada estado novo (real ou do demo)
export function mostrar(s) {
  atual = s;
  for (const who of ['plan', 'build']) {
    const a = s.agents[who], era = prev[who];
    if (era === a.status) continue;
    if (a.status === 'working' && era !== 'waiting') inicio[who] = Date.now();
    if ((era === 'working' || era === 'waiting') && a.status !== 'working') ultimaDur = Date.now() - (inicio[who] || Date.now());
    if (a.status === 'done') { beep(SONS.done); notificar('Pronto!', NOMES[who] + ' terminou o trabalho.'); }
    if (a.status === 'waiting') { beep(SONS.waiting); notificar('Preciso de você', a.text || 'O agente pediu permissão.'); }
    if (a.status === 'error') { beep(SONS.error); notificar('Deu erro', a.text || 'O agente encontrou um erro.'); }
    prev[who] = a.status;
  }
  $('proj').textContent = s.project ? '· ' + s.project : '';
  const usado = s.ctxTokens || 0, lim = config.get('ctxLimite'), pct = Math.min(100, usado / lim * 100);
  $('ctxTxt').textContent = `${fmtK(usado)} / ${fmtK(lim)} (${Math.round(pct)}%)`;
  $('ctxFill').style.width = pct + '%';
  $('ctxBar').className = 'bar' + (pct >= 80 ? ' hot' : pct >= 60 ? ' mid' : '');
  $('cFiles').textContent = s.files || 0;
  $('cSub').textContent = s.subagents || 0;
  $('cCost').textContent = '$' + (s.cost || 0).toFixed(2);
  $('cModelWrap').hidden = !s.model;
  $('cModel').textContent = String(s.model || '').split('/').pop();
  const ul = $('log'); ul.textContent = '';
  for (const e of (s.log || []).slice().reverse().slice(0, 5)) {
    const li = document.createElement('li');
    const tm = document.createElement('time'); tm.textContent = new Date(e.t).toTimeString().slice(0, 8);
    const dot = document.createElement('i'); dot.style.background = e.agent === 'plan' ? 'var(--plan)' : 'var(--build)';
    const sp = document.createElement('span'); sp.textContent = e.text; sp.title = e.text;
    li.append(tm, dot, sp); ul.appendChild(li);
  }
  pedidos(s.pedidos || []);
  subagentes(s.subs || []);
  skills(s.skills || [], s.now || Date.now());
  falas(s.chat);
  tempo();
  janelaBotoes(s.janela);
  $('bFora').hidden = !s.remoto;
  $('bFora').classList.toggle('on', !!s.fora);
}

// permissoes esperando resposta: permitir, sempre permitir ou negar (no PC ou no celular)
function pedidos(lista) {
  const chave = lista.map((p) => p.id).join();
  if (chave === chavePedidos) return; // nao refaz os botoes no meio de um toque
  chavePedidos = chave;
  const ul = $('pedidosList'); ul.textContent = '';
  $('pedidosBox').hidden = !lista.length;
  $('bGaveta').classList.toggle('alerta', !!lista.length); // gaveta fechada: a seta avisa
  for (const p of lista) {
    const li = document.createElement('li');
    const quem = document.createElement('b'); quem.textContent = NOMES[p.agent] || p.agent;
    quem.style.color = p.agent === 'plan' ? 'var(--plan)' : 'var(--build)';
    const txt = document.createElement('span'); txt.textContent = p.text; txt.title = p.text;
    const bt = document.createElement('div'); bt.className = 'resp';
    const botao = (rotulo, decisao, cls) => {
      const b = document.createElement('button'); b.textContent = rotulo; b.className = cls; b.dataset.decisao = decisao;
      b.addEventListener('click', () => { for (const x of bt.children) x.disabled = true; responder(p.id, decisao); });
      bt.appendChild(b);
    };
    botao('Permitir', 'sim', 'sim');
    if (p.sempre) botao('Sempre', 'sempre', 'sempre');
    botao('Negar', 'nao', 'nao');
    li.append(quem, txt, bt); ul.appendChild(li);
  }
}

// cada subagente: nome do personagem, tipo, tag e o que esta fazendo agora
function subagentes(subs) {
  const ul = $('subsList'); ul.textContent = '';
  $('subsBox').hidden = !subs.length;
  for (const x of subs.slice(0, 8)) {
    const li = document.createElement('li'); li.className = x.status === 'done' ? 'done' : '';
    const dot = document.createElement('i');
    const nome = document.createElement('b'); nome.textContent = (acoesHud.nomeSub && acoesHud.nomeSub(x.id)) || x.name;
    const tipo = document.createElement('small'); tipo.textContent = x.name;
    const tag = document.createElement('small'); tag.className = 'tag'; tag.textContent = x.tag || ''; tag.hidden = !x.tag;
    const sp = document.createElement('span'); sp.textContent = x.status === 'done' ? 'pronto ✔' : (x.text || x.task || 'trabalhando…');
    li.title = [x.tag, x.task, x.text].filter(Boolean).join(' — ');
    li.append(dot, nome, tipo, tag, sp); ul.appendChild(li);
  }
}

// chat: os baloes viram historico com hora, nome, tag e o icone do kind
function criarFala(x) {
  const li = document.createElement('li');
  li.dataset.id = String(x.id);
  li.dataset.slug = x.slug || '';
  const hora = document.createElement('time');
  hora.textContent = x.hora || new Date(x.t || Date.now()).toTimeString().slice(0, 8);
  const ic = document.createElement('i');
  ic.className = 'kind'; ic.textContent = KIND_ICONE[x.kind] || '💭'; ic.title = x.kind || 'think';
  const nome = document.createElement('b'); nome.textContent = x.nome || x.slug || '?';
  const tag = document.createElement('small'); tag.className = 'tag'; tag.textContent = x.tag || ''; tag.hidden = !x.tag;
  const txt = document.createElement('span'); txt.textContent = x.texto || ''; txt.title = x.texto || '';
  li.append(hora, ic, nome, tag, txt);
  return li;
}

function opcaoFiltro(slug, nome) {
  const sel = $('chatFiltro');
  const o = document.createElement('option');
  o.value = slug; o.textContent = nome || slug;
  sel.appendChild(o);
}

function filtrarChat() {
  const f = $('chatFiltro').value;
  for (const li of $('chatList').children) li.hidden = !!f && li.dataset.slug !== f;
}

// texto de agente entra por textContent: nada de innerHTML
function falas(lista) {
  if (!Array.isArray(lista) || !lista.length) return;
  const box = $('chatBox'), ul = $('chatList');
  const noFim = ul.scrollHeight - ul.scrollTop - ul.clientHeight < 12;
  let novos = 0;
  for (const x of lista) {
    if (!x || x.id === undefined || chat.ids.has(x.id)) continue;
    chat.ids.add(x.id);
    ul.appendChild(criarFala(x));
    if (!chat.slugs.has(x.slug)) { chat.slugs.set(x.slug, x.nome || x.slug); opcaoFiltro(x.slug, x.nome || x.slug); }
    novos++;
  }
  while (ul.children.length > 200) ul.removeChild(ul.firstChild);
  if (!novos) return;
  box.hidden = false;
  filtrarChat();
  // acompanha o fim; se o usuario rolou para cima, respeita a leitura dele
  if (noFim || !chat.carregado) ul.scrollTop = ul.scrollHeight;
  chat.carregado = true;
}

// historico que ja existia quando a pagina abriu
export function carregarChat() {
  fetch('/chat?n=200').then((r) => (r.ok ? r.json() : [])).then(falas).catch(() => {});
}

// skills usadas por ultimo; a que acabou de ser chamada fica acesa
function skills(lista, agora) {
  const box = $('skillsList'); box.textContent = '';
  $('skillsBox').hidden = !lista.length;
  for (const k of lista.slice().reverse()) {
    const el = document.createElement('span'); el.className = 'skill' + (agora - k.t < 30000 ? ' ativa' : '');
    el.textContent = k.name;
    const quem = document.createElement('small'); quem.textContent = ' · ' + (k.agent === 'sub' ? k.by || 'subagente' : NOMES[k.agent] || k.agent);
    el.appendChild(quem);
    el.title = 'skill ' + k.name + ' — ' + new Date(k.t).toTimeString().slice(0, 8);
    box.appendChild(el);
  }
}

// tempo do trabalho atual (ou o do ultimo, quando ninguem trabalha)
function tempo() {
  if (!atual) return;
  const w = ['plan', 'build'].find((k) => ['working', 'waiting'].includes(atual.agents[k].status));
  $('cTime').textContent = fmtT(w ? Date.now() - (inicio[w] || atual.agents[w].since) : ultimaDur);
}
setInterval(tempo, 1000);

export function status(c) {
  const dot = $('dot'), conn = $('conn'), sv = c.ultimo;
  if (c.erro) { conn.textContent = c.erro; return; }
  if (!c.conectado) { dot.className = 'dot'; conn.textContent = 'servidor desconectado'; return; }
  const on = [sv && sv.oc && 'opencode', sv && sv.cc && 'Claude Code'].filter(Boolean);
  dot.className = on.length ? 'dot on' : 'dot wait';
  conn.textContent = on.length ? 'conectado ao ' + on.join(' + ') : 'aguardando o opencode ou o Claude Code…';
}

function janelaBotoes(w) {
  const on = !!(w && w.controle) && local;
  $('bPin').hidden = $('bHide').hidden = !on;
  $('bPin').classList.toggle('on', !!(w && w.pinned));
}

// liga os botoes do topo; acoes que dependem da cena 3D chegam por "acoes"
export function iniciarHud(acoes) {
  acoesHud = acoes;
  const bSound = $('bSound');
  bSound.classList.toggle('on', config.get('som'));
  bSound.addEventListener('click', async () => { await ligarSom(!config.get('som')); bSound.classList.toggle('on', config.get('som')); });

  $('bPin').addEventListener('click', () => { const on = !$('bPin').classList.contains('on'); config.set('fixar', on); janela({ acao: 'fixar', on }); });
  $('bHide').addEventListener('click', () => janela({ acao: 'ocultar' }));
  $('bFora').addEventListener('click', () => fora(!$('bFora').classList.contains('on')));
  $('chatFiltro').addEventListener('change', filtrarChat);
  carregarChat();

  const CAMS = ['seguir', 'livre', 'cinema'];
  const bCam = $('bCam');
  const cam = (m) => { bCam.querySelector('span').textContent = m; config.set('camera', m); acoes.camera(m); };
  bCam.addEventListener('click', () => cam(CAMS[(CAMS.indexOf(config.get('camera')) + 1) % CAMS.length]));
  bCam.querySelector('span').textContent = config.get('camera');

  const bQual = $('bQual');
  const qual = (q) => { bQual.querySelector('span').textContent = q; config.set('qualidade', q); acoes.qualidade(q); };
  bQual.addEventListener('click', () => qual(config.get('qualidade') === 'alta' ? 'baixa' : 'alta'));
  bQual.querySelector('span').textContent = config.get('qualidade');

  $('bLook').addEventListener('click', () => acoes.aparencia());
  $('bDemo').addEventListener('click', () => acoes.demo());

  // tela estreita: o HUD fica numa gaveta embaixo; fecha ao tocar na cena, no Esc ou ao abrir algo por cima
  const bGaveta = $('bGaveta'), hud = $('hud');
  const gaveta = (on) => {
    document.body.classList.toggle('gaveta-aberta', on);
    bGaveta.textContent = on ? '▼' : '▲';
    bGaveta.title = on ? 'Esconder o painel' : 'Mostrar o painel';
    bGaveta.setAttribute('aria-expanded', on);
  };
  bGaveta.addEventListener('click', () => gaveta(!document.body.classList.contains('gaveta-aberta')));
  document.addEventListener('pointerdown', (e) => { if (!hud.contains(e.target)) gaveta(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') gaveta(false); });
  for (const id of ['bLook', 'bDemo', 'bHide']) $(id).addEventListener('click', () => gaveta(false));

  $('ctx').addEventListener('click', () => {
    const v = prompt('Limite de contexto do modelo, em tokens:', config.get('ctxLimite'));
    if (v && parseInt(v, 10) > 1000) { config.set('ctxLimite', parseInt(v, 10)); if (atual) mostrar(atual); }
  });
  // minimizar: o painel vira uma pilula so com o contexto
  const bMin = $('bMin');
  const minimizar = (on) => {
    document.body.classList.toggle('painel-min', on);
    bMin.textContent = on ? '+' : '–';
    bMin.title = on ? 'Mostrar o painel' : 'Minimizar o painel';
  };
  minimizar(config.get('painelMin'));
  bMin.addEventListener('click', (e) => { e.stopPropagation(); config.set('painelMin', !config.get('painelMin')); minimizar(config.get('painelMin')); });
  bMin.addEventListener('dblclick', (e) => e.stopPropagation());
  // clicar no log mostra/esconde a lista (modo compacto)
  document.body.classList.toggle('compacto', config.get('compacto'));
  $('painel').addEventListener('dblclick', () => { config.set('compacto', !config.get('compacto')); document.body.classList.toggle('compacto', config.get('compacto')); });
}
