// Overlay do stream de pensamento: uma coluna por agente ativo.
// O snapshot traz so o rabo da fila; GET /stream completa o historico ao abrir.
const ICONES = { think: "💭", read: "📖", edit: "✏️", bash: "⌨️", search: "🔎", web: "🌐", wait: "✋", skill: "✨" };
const NOMES = { plan: "Auditor", build: "Construtor" };
const TIPOS = new Set(["reasoning", "tool", "decision"]);

export function iniciarStream(el) {
  const head = document.createElement("header");
  const titulo = document.createElement("div");
  titulo.className = "hud-titulo";
  const h2 = document.createElement("h2");
  h2.textContent = "Stream";
  const sub = document.createElement("p");
  sub.textContent = "O raciocínio de cada agente, ao vivo.";
  titulo.append(h2, sub);
  const filtro = document.createElement("select");
  filtro.className = "stream-filtro";
  filtro.setAttribute("aria-label", "Filtrar por morador");
  const todos = document.createElement("option");
  todos.value = "";
  todos.textContent = "todos";
  filtro.appendChild(todos);
  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "fechar";
  fechar.title = "Fechar (Esc)";
  fechar.setAttribute("aria-label", "Fechar o stream");
  fechar.textContent = "×";
  head.append(titulo, filtro, fechar);

  const vazio = document.createElement("p");
  vazio.className = "hud-vazio";
  vazio.textContent = "Nenhum agente ativo no momento.";
  const colunas = new Map();
  const corpo = document.createElement("div");
  corpo.className = "stream-colunas";
  el.textContent = "";
  el.append(head, vazio, corpo);

  const vistos = new Map(); // slug + id -> linha
  const ultimo = new Map(); // slug -> ultimo trecho
  let escolhido = "";
  let carregando = false;
  let opcoes = new Set([""]);

  function opcao(slug, nome) {
    if (opcoes.has(slug)) return;
    opcoes.add(slug);
    const o = document.createElement("option");
    o.value = slug;
    o.textContent = nome || slug;
    filtro.appendChild(o);
  }

  function aplicarFiltro() {
    let visiveis = 0;
    for (const [slug, col] of colunas) {
      const mostra = !escolhido || slug === escolhido;
      col.el.hidden = !mostra;
      if (mostra) visiveis++;
    }
    vazio.hidden = visiveis > 0;
  }

  function garantirColuna(slug, nome, tag) {
    let col = colunas.get(slug);
    if (col) {
      if (nome) col.nome.textContent = nome;
      if (tag !== undefined) {
        col.tag.textContent = tag || "";
        col.tag.hidden = !tag;
      }
      return col;
    }
    const artigo = document.createElement("article");
    artigo.className = "stream-col";
    artigo.dataset.slug = slug;
    const cab = document.createElement("button");
    cab.type = "button";
    cab.className = "stream-cab";
    cab.setAttribute("aria-expanded", "true");
    cab.title = "Recolher ou expandir a coluna";
    const nomeEl = document.createElement("b");
    nomeEl.textContent = nome || slug;
    const tagEl = document.createElement("small");
    tagEl.className = "tag";
    tagEl.textContent = tag || "";
    tagEl.hidden = !tag;
    const ultimoEl = document.createElement("span");
    ultimoEl.className = "stream-ultimo";
    const seta = document.createElement("span");
    seta.className = "seta";
    seta.textContent = "▾";
    cab.append(nomeEl, tagEl, ultimoEl, seta);
    const lista = document.createElement("div");
    lista.className = "stream-lista";
    artigo.append(cab, lista);
    cab.addEventListener("click", () => {
      const recolhida = artigo.classList.toggle("recolhida");
      cab.setAttribute("aria-expanded", String(!recolhida));
      seta.textContent = recolhida ? "▸" : "▾";
    });
    // auto-scroll pausa com o mouse sobre a coluna e retoma ao sair
    artigo.addEventListener("mouseenter", () => {
      artigo.dataset.pausado = "1";
    });
    artigo.addEventListener("mouseleave", () => {
      delete artigo.dataset.pausado;
      lista.scrollTop = lista.scrollHeight;
    });
    corpo.appendChild(artigo);
    col = { el: artigo, lista, nome: nomeEl, tag: tagEl, ultimo: ultimoEl };
    colunas.set(slug, col);
    opcao(slug, nome || slug);
    return col;
  }

  function linha(t) {
    const tipo = TIPOS.has(t.tipo) ? t.tipo : "reasoning";
    const kind = t.kind || "think";
    const li = document.createElement("li");
    li.className = "stream-trecho stream-" + tipo;
    li.dataset.id = String(t.id || "");
    li.dataset.slug = String(t.slug || "");

    const meta = document.createElement("div");
    meta.className = "stream-meta";
    const hora = document.createElement("time");
    hora.textContent = t.hora || "";
    const icone = document.createElement("span");
    icone.className = "stream-icone";
    icone.textContent = tipo === "decision" ? "✓" : tipo === "reasoning" ? "💭" : ICONES[kind] || "💭";
    icone.title = kind;
    meta.append(hora, icone);

    const texto = document.createElement("p");
    texto.className = "stream-texto";
    texto.textContent = t.texto || "";
    li.append(meta, texto);
    if (t.res) {
      const res = document.createElement("p");
      res.className = "stream-res";
      res.textContent = t.res;
      li.appendChild(res);
    }
    return li;
  }

  function atualizarUltimo(slug) {
    const col = colunas.get(slug);
    if (!col) return;
    const t = ultimo.get(slug);
    col.ultimo.textContent = t ? (t.kind || t.tipo || "") + " · " + (t.hora || "") : "";
    if (t) {
      col.nome.textContent = t.nome || col.nome.textContent;
      col.tag.textContent = t.tag || "";
      col.tag.hidden = !t.tag;
      opcao(slug, t.nome || slug);
    }
  }

  function semAtividade(col) {
    const vazia = col.lista.children.length === 0;
    col.el.classList.toggle("vazia", vazia);
    if (vazia && !col.lista.querySelector(".stream-vazio")) {
      const p = document.createElement("p");
      p.className = "stream-vazio";
      p.textContent = "sem atividade";
      col.lista.appendChild(p);
    } else if (!vazia) {
      const p = col.lista.querySelector(".stream-vazio");
      if (p) p.remove();
    }
  }

  function adicionar(t) {
    if (!t || !t.slug || !t.texto) return false;
    const slug = String(t.slug);
    const chave = slug + "\u0000" + String(t.id || t.t + ":" + t.hora);
    const col = garantirColuna(slug, t.nome, t.tag);
    let li = vistos.get(chave);
    if (li) {
      const texto = li.querySelector(".stream-texto");
      if (texto && t.texto) texto.textContent = t.texto;
      const antigo = li.querySelector(".stream-res");
      if (t.res) {
        if (antigo) antigo.textContent = t.res;
        else {
          const res = document.createElement("p");
          res.className = "stream-res";
          res.textContent = t.res;
          li.appendChild(res);
        }
      }
      ultimo.set(slug, t);
      return false;
    }
    li = linha(t);
    col.lista.appendChild(li);
    vistos.set(chave, li);
    ultimo.set(slug, t);
    return true;
  }

  function aplicar(streams) {
    let novos = 0;
    if (streams && typeof streams === "object") {
      for (const [slug, lista] of Object.entries(streams)) {
        if (!Array.isArray(lista)) continue;
        for (const t of lista) if (adicionar({ ...t, slug })) novos++;
      }
    }
    for (const slug of ultimo.keys()) atualizarUltimo(slug);
    for (const col of colunas.values()) semAtividade(col);
    if (novos) {
      for (const col of colunas.values()) {
        if (!col.el.dataset.pausado) col.lista.scrollTop = col.lista.scrollHeight;
      }
    }
    aplicarFiltro();
  }

  function agenteAtivo(slug, nome, tag) {
    if (!garantirColuna(slug, nome, tag)) return;
    atualizarUltimo(slug);
    semAtividade(colunas.get(slug));
    opcao(slug, nome || slug);
  }

  // snapshot: kanban/som completos e stream so com o rabo da fila (dedupe por id)
  function mostrar(stream, subs, agents) {
    for (const who of ["plan", "build"]) {
      const a = agents && agents[who];
      if (a && (a.status === "working" || a.status === "waiting")) agenteAtivo(who, NOMES[who], a.tag);
    }
    for (const s of subs || []) {
      if (!s || !s.id || s.status === "done") continue;
      agenteAtivo(String(s.id), s.name || s.id, s.tag);
    }
    aplicar(stream);
    aplicarFiltro();
  }

  // ao abrir: GET /stream uma vez traz o historico completo (o snapshot corta em 240 ch)
  async function aoAbrir() {
    if (carregando) return;
    carregando = true;
    try {
      const r = await fetch("/stream");
      if (r.ok) {
        const corpo = await r.json();
        aplicar(corpo && corpo.streams);
      }
    } catch {
      // sem rede o snapshot continua atualizando o que ja esta na tela
    } finally {
      carregando = false;
    }
    aplicarFiltro();
  }

  filtro.addEventListener("change", () => {
    escolhido = filtro.value;
    aplicarFiltro();
  });

  mostrar(null, [], null);
  return { mostrar, aoAbrir };
}