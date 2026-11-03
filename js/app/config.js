// Preferencias do usuario, guardadas no navegador (localStorage).
// Tudo passa por aqui: se o navegador bloquear o armazenamento, os padroes continuam valendo.
const KEY = 'escritorio.config';

const PADRAO = {
  tema: 'moderno',
  qualidade: globalThis.matchMedia?.('(pointer: coarse)').matches ? 'baixa' : 'alta', // alta | baixa (celular: baixa)
  camera: 'seguir',       // livre | seguir | cinema
  som: false,
  jukeboxSom: false,      // "ligar som" da jukebox (config.som e dos avisos de interface)
  fixar: false,           // janela sempre por cima
  compacto: false,
  painelMin: false,       // painel do contexto minimizado
  ctxLimite: 200000,
  // skin de cada personagem: 'aleatorio' | id de uma skin pronta | { custom: {...} }
  skins: {
    plan: 'aleatorio',
    build: 'aleatorio',
    subTipos: {},          // tipo do subagente (Explore, general-purpose...) -> skin
    subPadrao: 'aleatorio',
    subIds: {},            // skin escolhida para um subagente especifico, enquanto ele existir
  },
  fixados: {},             // personagem aleatorio que o usuario quis manter: papel -> semente
};

function ler() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}

const merge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' ? merge(a[k], v) : v;
  return out;
};

let atual = merge(PADRAO, ler());
const ouvintes = new Set();

export const config = {
  get: (k) => atual[k],
  todos: () => atual,
  // muda um valor de primeiro nivel (ou um caminho "skins.plan") e avisa quem estiver ouvindo
  set(caminho, valor) {
    const partes = caminho.split('.');
    const novo = structuredClone(atual);
    let o = novo;
    for (const p of partes.slice(0, -1)) o = o[p] = o[p] && typeof o[p] === 'object' ? o[p] : {};
    if (valor === undefined) delete o[partes.at(-1)]; else o[partes.at(-1)] = valor;
    atual = novo;
    try { localStorage.setItem(KEY, JSON.stringify(atual)); } catch {}
    for (const f of ouvintes) f(caminho, valor);
  },
  ouvir(f) { ouvintes.add(f); return () => ouvintes.delete(f); },
};
