// Overlay do som (jukebox): o que toca, quem pediu, a fila e os controles.
// O servidor guarda so o estado (/som); volume, pausa e "ligar som" sao do cliente.
import { config } from "./config.js";
import { beep, SONS } from "./avisos.js";

const VID = /^[A-Za-z0-9_-]{11}$/;
const EMBED = (vid) => `https://www.youtube.com/embed/${vid}?autoplay=1&rel=0`;

export function iniciarSom(el) {
  const head = document.createElement("header");
  const titulo = document.createElement("div");
  titulo.className = "hud-titulo";
  const h2 = document.createElement("h2");
  h2.textContent = "Som";
  const sub = document.createElement("p");
  sub.textContent = "A música pedida por quem está no escritório.";
  titulo.append(h2, sub);
  const fechar = document.createElement("button");
  fechar.type = "button";
  fechar.className = "fechar";
  fechar.title = "Fechar (Esc)";
  fechar.setAttribute("aria-label", "Fechar o som");
  fechar.textContent = "×";
  head.append(titulo, fechar);

  const agora = document.createElement("section");
  agora.className = "som-agora";
  const h3 = document.createElement("h3");
  h3.textContent = "Tocando agora";
  const faixa = document.createElement("div");
  faixa.className = "som-faixa";
  agora.append(h3, faixa);

  const player = document.createElement("div");
  player.className = "som-player";
  player.hidden = true;

  const controles = document.createElement("div");
  controles.className = "som-controles";
  // o input fica FORA do label: dentro, o clique borbulha e o label alterna duas vezes
  const rotulo = document.createElement("div");
  rotulo.className = "som-toggle";
  const ligar = document.createElement("input");
  ligar.type = "checkbox";
  ligar.id = "somLigar";
  ligar.checked = !!config.get("jukeboxSom");
  const ligarTxt = document.createElement("label");
  ligarTxt.htmlFor = "somLigar";
  ligarTxt.textContent = "Ligar som";
  rotulo.append(ligar, ligarTxt);

  const pausar = document.createElement("button");
  pausar.type = "button";
  pausar.textContent = "Pausar";
  pausar.hidden = true;
  const pular = document.createElement("button");
  pular.type = "button";
  pular.textContent = "Pular";
  const limpar = document.createElement("button");
  limpar.type = "button";
  limpar.textContent = "Limpar";
  controles.append(rotulo, pausar, pular, limpar);

  const erro = document.createElement("p");
  erro.className = "hud-erro";
  erro.hidden = true;

  const filaBox = document.createElement("section");
  filaBox.className = "som-fila-box";
  const filaTitulo = document.createElement("h3");
  filaTitulo.textContent = "Fila";
  const fila = document.createElement("ol");
  fila.className = "som-fila";
  filaBox.append(filaTitulo, fila);

  el.textContent = "";
  el.append(head, agora, player, controles, erro, filaBox);

  let estado = { atual: null, fila: [] };
  let pausado = false;

  function tagDe(item) {
    const tag = document.createElement("small");
    tag.className = "tag";
    tag.textContent = item.tag || "";
    tag.hidden = !item.tag;
    return tag;
  }

  function desenharFaixa() {
    faixa.textContent = "";
    const item = estado.atual;
    if (!item) {
      const vazio = document.createElement("p");
      vazio.className = "som-vazio";
      vazio.textContent = "Nada tocando. Peça uma música pelo mundo.";
      faixa.appendChild(vazio);
      pausar.hidden = true;
      return;
    }
    const nome = document.createElement("strong");
    nome.textContent = item.titulo || item.vid || "sem título";
    const quem = document.createElement("span");
    quem.className = "som-quem";
    const pessoa = document.createElement("span");
    pessoa.textContent = "pedida por " + (item.nome || item.slug || "?");
    quem.append(pessoa, tagDe(item));
    const link = document.createElement("a");
    link.href = item.url || "#";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "abrir no YouTube";
    faixa.append(nome, quem, link);
    pausar.hidden = false;
    pausar.textContent = pausado ? "Retomar" : "Pausar";
  }

  function desenharFila() {
    const lista = Array.isArray(estado.fila) ? estado.fila : [];
    fila.textContent = "";
    for (const item of lista) {
      const li = document.createElement("li");
      const tituloItem = document.createElement("span");
      tituloItem.textContent = item.titulo || item.vid || "sem título";
      const quem = document.createElement("small");
      quem.textContent = item.nome || item.slug || "?";
      li.append(tituloItem, tagDe(item), quem);
      const hora = document.createElement("time");
      hora.textContent = item.hora || "";
      li.appendChild(hora);
      fila.appendChild(li);
    }
    filaTitulo.textContent = "Fila (" + lista.length + ")";
    if (!lista.length) {
      const li = document.createElement("li");
      li.className = "som-vazio";
      li.textContent = "fila vazia";
      fila.appendChild(li);
    }
  }

  // o iframe so existe com "ligar som" ativo, musica atual e vid valido
  function desenharPlayer() {
    const item = estado.atual;
    const pode = !!config.get("jukeboxSom") && !pausado && item && VID.test(item.vid || "");
    if (!pode) {
      player.textContent = "";
      player.hidden = true;
      return;
    }
    let frame = player.querySelector("iframe");
    const src = EMBED(item.vid);
    if (!frame) {
      frame = document.createElement("iframe");
      frame.setAttribute("allow", "autoplay; encrypted-media");
      frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
      frame.setAttribute("allowfullscreen", "");
      player.appendChild(frame);
    }
    frame.title = item.titulo || item.vid;
    if (frame.getAttribute("src") !== src) frame.setAttribute("src", src);
    player.hidden = false;
  }

  function mostrar(som) {
    estado = {
      atual: som && som.atual ? som.atual : null,
      fila: som && Array.isArray(som.fila) ? som.fila : [],
    };
    if (!estado.atual) pausado = false;
    desenharFaixa();
    desenharFila();
    desenharPlayer();
  }

  function mostrarErro(msg) {
    erro.textContent = msg || "";
    erro.hidden = !msg;
  }

  async function acao(nome) {
    mostrarErro("");
    try {
      const r = await fetch("/som", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ acao: nome }),
      });
      const corpo = await r.json().catch(() => null);
      if (!r.ok) {
        mostrarErro((corpo && corpo.erro && corpo.erro.mensagem) || "O servidor recusou a ação.");
        beep(SONS.error);
        return;
      }
      if (corpo && ("atual" in corpo || "fila" in corpo)) mostrar(corpo);
    } catch {
      mostrarErro("Não consegui falar com o servidor.");
      beep(SONS.error);
    }
  }

  ligar.addEventListener("change", () => {
    config.set("jukeboxSom", ligar.checked);
    if (ligar.checked) pausado = false;
    desenharFaixa();
    desenharPlayer();
  });
  pausar.addEventListener("click", () => {
    pausado = !pausado;
    desenharFaixa();
    desenharPlayer();
  });
  pular.addEventListener("click", () => acao("pular"));
  limpar.addEventListener("click", () => acao("limpar"));

  mostrar(estado);
  return { mostrar };
}