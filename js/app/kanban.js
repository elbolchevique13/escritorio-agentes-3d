// Overlay do kanban: uma coluna por etapa e um card por tarefa.
// Todo texto de agente entra por textContent; o HUD so le o snapshot (/events).

export const COLUNAS = [
  ["fila", "Fila"],
  ["fazendo", "Fazendo"],
  ["revisao", "Revisão"],
  ["feito", "Feito"],
];

export function iniciarKanban(el) {
  const head = document.createElement("header");
  const titulo = document.createElement("div");
  titulo.className = "hud-titulo";
  const h2 = document.createElement("h2");
  h2.textContent = "Kanban";
  const sub = document.createElement("p");
  sub.textContent = "O que cada morador está fazendo agora.";
  titulo.append(h2, sub);
  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "fechar";
  fechar.title = "Fechar (Esc)";
  fechar.setAttribute("aria-label", "Fechar o kanban");
  fechar.textContent = "×";
  head.append(titulo, fechar);

  const vazio = document.createElement("p");
  vazio.className = "hud-vazio";
  vazio.textContent = "Nenhum card no quadro ainda.";
  vazio.hidden = true;

  const quadro = document.createElement("div");
  quadro.className = "kanban-quadro";
  const colunas = new Map();
  for (const [col, rotulo] of COLUNAS) {
    const secao = document.createElement("section");
    secao.className = "kanban-col";
    secao.dataset.col = col;
    const h3 = document.createElement("h3");
    const nome = document.createElement("span");
    nome.textContent = rotulo;
    const contagem = document.createElement("b");
    contagem.className = "contagem";
    contagem.textContent = "0";
    h3.append(nome, contagem);
    const lista = document.createElement("ul");
    lista.className = "kanban-cards";
    secao.append(h3, lista);
    quadro.appendChild(secao);
    colunas.set(col, { lista, contagem });
  }

  el.textContent = "";
  el.append(head, vazio, quadro);

  function card(c) {
    const li = document.createElement("li");
    li.className = "kanban-card";
    li.dataset.id = String(c.id || "");
    li.dataset.auto = c.auto ? "1" : "0";

    const topo = document.createElement("div");
    topo.className = "kanban-topo";
    const nome = document.createElement("b");
    nome.textContent = c.nome || c.slug || "?";
    topo.appendChild(nome);
    if (c.tag) {
      const tag = document.createElement("small");
      tag.className = "tag";
      tag.textContent = c.tag;
      topo.appendChild(tag);
    }
    const hora = document.createElement("time");
    hora.textContent = c.hora || "";
    if (c.t) hora.title = new Date(c.t).toLocaleString("pt-BR");
    topo.appendChild(hora);

    const titulo = document.createElement("p");
    titulo.textContent = c.titulo || "";

    li.append(topo, titulo);
    return li;
  }

  function mostrar(kanban) {
    const cards = kanban && Array.isArray(kanban.cards) ? kanban.cards : [];
    const porColuna = new Map(COLUNAS.map(([col]) => [col, []]));
    for (const c of cards) if (c && porColuna.has(c.col)) porColuna.get(c.col).push(c);
    for (const [col, { lista, contagem }] of colunas) {
      const listaCol = porColuna.get(col).slice().sort((a, b) => (a.t || 0) - (b.t || 0));
      lista.textContent = "";
      for (const c of listaCol) lista.appendChild(card(c));
      if (!listaCol.length) {
        const li = document.createElement("li");
        li.className = "col-vazio";
        li.textContent = "nenhum card";
        lista.appendChild(li);
      }
      contagem.textContent = String(listaCol.length);
    }
    vazio.hidden = cards.length > 0;
    quadro.hidden = cards.length === 0;
  }

  return { mostrar };
}