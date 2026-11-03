// Diretor: transforma o estado dos agentes (vindo do servidor) em comportamento na sala.
//  - agentes principais (Auditor/Plan e Construtor/Build) sentam na mesa redonda para trabalhar;
//    parados, vao beber agua, tomar cafe, sentar no sofa, jogar basquete...
//  - cada subagente entra pela porta, ganha uma salinha (ou um lugar na mesa), trabalha e,
//    ao terminar, leva o resultado ao agente principal e vai embora
//  - figurantes e um robo aspirador circulam para a sala nao ficar vazia
import * as THREE from 'three';
import { Ator } from './ator.js';
import { Kit } from './geo.js';
import { resolver, nomeAleatorio, aleatoria, SKINS } from './skins.js';
import { ASSENTOS, LUGAR_PRINCIPAL, PODS, PORTA, SPOTS, QUADRA, TV } from './layout.js';
import { caminho, livre } from './nav.js';
import { config } from '../app/config.js';

const COR_PAPEL = { plan: '#ffb454', build: '#5aa9ff', sub: '#3ddc97', npc: '#9097a8' };
const NOME_PAPEL = { plan: 'Auditor', build: 'Construtor' };
const TELA = { read: 0x5aa9ff, edit: 0x4ade80, bash: 0x2bd67b, search: 0xfbbf24, web: 0x2bf6ff, think: 0xb48cff, wait: 0xfbbf24, skill: 0xff7ad9 };
const POSE_TIPO = { read: 'ler', search: 'ler', think: 'pensar', edit: 'digitar', bash: 'digitar', web: 'digitar', wait: 'digitar', skill: 'ler' };
// o que quem esta ajudando faz enquanto o agente trabalha (modo foco)
const APOIO = {
  read: 'lendo junto 📖', search: 'procurando também 🔎', edit: 'revisando o código 👀', bash: 'de olho no terminal',
  web: 'pesquisando junto 🌐', think: 'pensando junto 💭', wait: 'esperando sua resposta', skill: 'estudando a skill 📘',
};
const sorteio = (lista) => lista[Math.floor(Math.random() * lista.length)];
const entre = (a, b) => a + Math.random() * (b - a);

// coisas para fazer quando nao ha trabalho
const ATIVIDADES = [
  { id: 'agua', peso: 3, spots: SPOTS.agua.slice(0, 1), pose: 'beber', objeto: 'copo', dur: [4, 6], texto: 'bebendo água 💧', indo: 'indo beber água' },
  { id: 'cafe', peso: 3, spots: SPOTS.cafe, pose: 'beber', objeto: 'xicara', dur: [5, 8], texto: 'tomando um café ☕', indo: 'indo pegar um café' },
  { id: 'sofa', peso: 3, spots: SPOTS.sofa, sentar: 'sofa', dur: [8, 14], texto: 'descansando no sofá', indo: 'indo pro sofá' },
  { id: 'janela', peso: 2, spots: SPOTS.janela, pose: 'janela', dur: [6, 10], texto: 'olhando a vista', indo: 'indo ver a vista' },
  { id: 'quadra', peso: 3, spots: SPOTS.quadra, basquete: true, dur: [9, 15], texto: 'jogando basquete 🏀', indo: 'indo jogar basquete' },
  { id: 'conversa', peso: 2, spots: SPOTS.conversa, pose: 'conversar', dur: [6, 10], texto: 'batendo papo', indo: 'indo bater papo' },
  { id: 'regar', peso: 1, spots: SPOTS.plantas, pose: 'regar', objeto: 'regador', dur: [4, 6], texto: 'regando as plantas 🌱', indo: 'indo regar as plantas' },
];

export class Diretor {
  constructor(escritorio) {
    this.esc = escritorio;
    this.engine = escritorio.engine;
    this.grupo = new THREE.Group();
    this.grupo.name = 'atores';
    this.engine.scene.add(this.grupo);
    this.kit = new Kit(this.grupo);
    this.atores = new Map();      // id -> Ator
    this.reservas = new Map();    // "atividade:i" -> id do ator
    this.lugares = new Map();     // "pod3" | "mesa4" -> id do subagente
    this.ultimo = {};             // ultimo estado visto de cada agente principal
    this.bolas = [];
    this.estado = null;
    this.foco = false;            // alguem trabalhando: todo mundo senta e trabalha junto
    this.tipoFoco = 'think';
    this.relogioTv = 0;
    this.criarFigurantes();
    this.criarAspirador();
    config.ouvir((c) => { if (c.startsWith('skins') || c.startsWith('fixados')) this.reaplicarSkins(); });
  }

  // ---------- estado do servidor ----------
  aplicar(s) {
    const anterior = this.estado;
    this.estado = s;
    if (!anterior || anterior.session !== s.session) this.reaplicarSkins();
    const foco = this.calcularFoco(s), mudouFoco = foco !== this.foco, tipoAntes = this.tipoFoco;
    this.foco = foco;
    this.tipoFoco = this.tipoDoFoco(s);
    for (const who of ['plan', 'build']) this.principal(who, s.agents[who]);
    this.subagentes(s.subs || []);
    if (mudouFoco) {
      // comecou ou acabou o trabalho: quem esta livre senta para ajudar (ou volta para a rotina)
      for (const a of this.atores.values()) if (a.papel === 'npc' || this.livre(a)) this.rotina(a);
    } else if (foco && tipoAntes !== this.tipoFoco) this.ajustarApoio();
    this.desenharTv();
  }

  // ---------- modo foco: alguem trabalhando -> o escritorio inteiro trabalha junto ----------
  calcularFoco(s) {
    return ['plan', 'build'].some((w) => ['working', 'waiting'].includes(s.agents[w].status)) || (s.subs || []).some((x) => x.status === 'working');
  }
  tipoDoFoco(s) {
    const w = ['build', 'plan'].find((k) => ['working', 'waiting'].includes(s.agents[k].status));
    if (w) return s.agents[w].kind || 'think';
    const sub = (s.subs || []).find((x) => x.status === 'working');
    return (sub && sub.kind) || 'think';
  }
  // agente principal sem trabalho proprio (o "pronto" termina a comemoracao e chama a rotina sozinho)
  livre(a) { return (a.papel === 'plan' || a.papel === 'build') && a.estado && a.estado.status === 'idle'; }

  poseApoio(a) {
    const k = POSE_TIPO[this.tipoFoco] || 'digitar';
    if (a.papel === 'npc') return ['digitar', k, 'ler'][+a.id.slice(3) % 3];
    return this.tipoFoco === 'edit' || this.tipoFoco === 'bash' ? 'ler' : k; // o outro principal revisa
  }

  // senta na mesa redonda e trabalha junto (principal no proprio lugar, figurante num lugar livre)
  apoiar(a) {
    this.liberarReservas(a);
    a.atividade = '';
    a.apoio = true;
    const fazer = { tipo: 'fazer', pose: this.poseApoio(a), dur: Infinity, objeto: null };
    let lugar;
    if (a.papel === 'plan' || a.papel === 'build') { const s = ASSENTOS[LUGAR_PRINCIPAL[a.papel]]; lugar = { id: s.id, x: s.x, z: s.z, ang: s.ang, aprox: s.aprox }; }
    else lugar = a.lugar || (a.lugar = this.assentoLivre(a));
    if (!lugar) {
      // mesa cheia: discute o trabalho em pe no lounge
      const s = SPOTS.conversa[+a.id.slice(3) % SPOTS.conversa.length];
      a.agir([{ tipo: 'ir', destino: s.aprox || s }, { tipo: 'fazer', pose: 'conversar', dur: Infinity, objeto: null }]);
      return;
    }
    if (a.sentado && a.sentado.id === lugar.id) { a.fila = []; a.passo = null; a.depois([fazer]); return; }
    a.agir([{ tipo: 'ir', destino: lugar.aprox, correr: true }, { tipo: 'sentar', lugar: { x: lugar.x, z: lugar.z, ang: lugar.ang, id: lugar.id } }, fazer]);
  }

  assentoLivre(a) {
    for (let i = 0; i < ASSENTOS.length; i++) {
      if (i === LUGAR_PRINCIPAL.plan || i === LUGAR_PRINCIPAL.build) continue;
      const s = ASSENTOS[i];
      if (this.lugares.has(s.id)) continue;
      this.lugares.set(s.id, a.id);
      return { id: s.id, tipo: 'mesa', i, x: s.x, z: s.z, ang: s.ang, aprox: s.aprox };
    }
    return null;
  }

  // o agente mudou de tipo de trabalho: quem ajuda acompanha (le, digita, pensa...)
  ajustarApoio() {
    for (const a of this.atores.values()) {
      if (!a.apoio || !a.sentado || !a.passo || a.passo.tipo !== 'fazer') continue;
      const pose = this.poseApoio(a);
      if (a.passo.pose !== pose) { a.fila = []; a.passo = null; a.depois([{ tipo: 'fazer', pose, dur: Infinity, objeto: null }]); }
    }
  }
  textoApoio(a) { return a.sentado ? APOIO[this.tipoFoco] || 'ajudando 💻' : 'indo ajudar 🏃'; }

  // ---------- agentes principais ----------
  skinPrincipal(who) {
    const fixo = config.get('fixados')[who];
    return resolver(config.get('skins')[who], fixo ?? `${(this.estado && this.estado.session) || 'sessao'}:${who}`);
  }

  ator(who) {
    let a = this.atores.get(who);
    if (!a) {
      const lugar = ASSENTOS[LUGAR_PRINCIPAL[who]];
      a = new Ator(this.kit, this.skinPrincipal(who), { id: who, nome: NOME_PAPEL[who], papel: who, cor: COR_PAPEL[who], x: lugar.aprox.x, z: lugar.aprox.z, ang: lugar.ang });
      this.grupo.add(a.raiz);
      this.atores.set(who, a);
      this.rotina(a);
    }
    return a;
  }

  principal(who, st) {
    const a = this.ator(who), velho = this.ultimo[who] || {};
    this.ultimo[who] = { ...st };
    a.estado = st;
    const mudou = velho.status !== st.status, mudouTipo = velho.kind !== st.kind;
    if (!mudou && !(st.status === 'working' && mudouTipo)) return;
    const lugar = ASSENTOS[LUGAR_PRINCIPAL[who]];
    const naCadeira = a.sentado && a.sentado.id === lugar.id;
    this.liberarReservas(a);
    a.atividade = '';
    a.apoio = false;
    a.p.setExpr('normal');
    if (st.status === 'working') {
      const fazer = { tipo: 'fazer', pose: POSE_TIPO[st.kind] || 'digitar', dur: Infinity, objeto: null };
      if (naCadeira) { a.fila = []; a.passo = null; a.depois([fazer]); }
      else a.agir([{ tipo: 'ir', destino: lugar.aprox, correr: true }, { tipo: 'sentar', lugar: { x: lugar.x, z: lugar.z, ang: lugar.ang, id: lugar.id } }, fazer]);
    } else if (st.status === 'waiting') {
      // levanta e acena para voce (a camera fica na frente: angulo 0)
      a.agir([{ tipo: 'virar', ang: 0 }, { tipo: 'fazer', pose: 'acenar', dur: Infinity, ang: 0, objeto: null }]);
    } else if (st.status === 'error') {
      const fazer = { tipo: 'fazer', pose: 'desespero', dur: Infinity, expr: 'susto', objeto: null };
      if (naCadeira) { a.fila = []; a.passo = null; a.depois([fazer]); } else a.agir([fazer]);
    } else if (st.status === 'done') {
      a.agir([{ tipo: 'virar', ang: 0 }, { tipo: 'fazer', pose: 'comemorar', dur: 3.5, ang: 0, objeto: null }, { tipo: 'func', f: (x) => this.rotina(x) }]);
    } else {
      this.rotina(a);
    }
  }

  // ---------- rotina de quem esta livre ----------
  rotina(a) {
    if (a.papel !== 'npc' && a.estado && a.estado.status !== 'idle' && a.estado.status !== 'done') return;
    if (this.foco) { this.apoiar(a); return; }
    a.apoio = false;
    if (a.papel === 'npc') this.liberarLugar(a);
    this.liberarReservas(a);
    const opcoes = [];
    for (const at of ATIVIDADES) {
      const i = at.spots.findIndex((_, k) => !this.reservas.has(at.id + ':' + k));
      if (i >= 0 && at.id !== a.ultimaAtividade) opcoes.push({ at, i });
    }
    if (!opcoes.length) { a.agir([{ tipo: 'fazer', pose: 'em pe', dur: 3 }, { tipo: 'func', f: (x) => this.rotina(x) }]); return; }
    const total = opcoes.reduce((s, o) => s + o.at.peso, 0);
    let r = Math.random() * total, escolha = opcoes[0];
    for (const o of opcoes) { r -= o.at.peso; if (r <= 0) { escolha = o; break; } }
    a.agir([...this.passosAtividade(a, escolha.at, escolha.i), { tipo: 'func', f: (x) => this.rotina(x) }]);
  }

  passosAtividade(a, at, i) {
    const s = at.spots[i], chave = at.id + ':' + i;
    this.reservas.set(chave, a.id);
    a.reserva = chave;
    a.ultimaAtividade = at.id;
    const dur = entre(...at.dur);
    const passos = [{ tipo: 'func', f: (x) => { x.atividade = at.indo; } }, { tipo: 'ir', destino: s.aprox || s }];
    if (at.sentar) passos.push({ tipo: 'sentar', lugar: { x: s.x, z: s.z, ang: s.ang, id: chave }, pose: 'sofa' }, { tipo: 'fazer', pose: 'sofa', dur, texto: at.texto });
    else if (at.basquete) passos.push({ tipo: 'virar', ang: s.ang }, { tipo: 'fazer', pose: 'arremessar', dur, ang: s.ang, texto: at.texto, cada: (dt, ps) => this.basquete(a, ps) });
    else passos.push({ tipo: 'virar', ang: s.ang }, { tipo: 'fazer', pose: at.pose, objeto: at.objeto, dur, ang: s.ang, texto: at.texto });
    passos.push({ tipo: 'func', f: (x) => { this.liberarReservas(x); if (at.basquete) x.p.segurar(null); x.atividade = ''; } });
    return passos;
  }

  liberarReservas(a) {
    if (a.reserva && this.reservas.get(a.reserva) === a.id) this.reservas.delete(a.reserva);
    a.reserva = null;
  }

  // ---------- basquete: a bola sai da mao, vai ate o aro e cai (ou bate no aro) ----------
  basquete(a, ps) {
    const ciclo = 1.9, c = (ps.t % ciclo) / ciclo, volta = Math.floor(ps.t / ciclo);
    a.p.setPose('arremessar', { p: c });
    if (c < 0.55) { a.p.segurar('bola'); ps.lancou = false; }
    else if (!ps.lancou && volta === (ps.volta ?? volta)) {
      ps.lancou = true; ps.volta = volta + 1;
      a.p.segurar(null);
      const de = new THREE.Vector3();
      a.p.maoD.getWorldPosition(de);
      this.lancarBola(de, Math.random() < 0.65);
    }
  }

  lancarBola(de, cesta) {
    const bola = this.kit.esf(0.12, this.kit.mat(0xe8742a, { rough: 0.7 }), de.x, de.y, de.z, this.grupo);
    const aro = new THREE.Vector3(QUADRA.aro.x, QUADRA.aro.y + 0.12, QUADRA.aro.z);
    const erro = cesta ? new THREE.Vector3() : new THREE.Vector3(0, 0.05, (Math.random() < 0.5 ? -1 : 1) * 0.28);
    this.bolas.push({ m: bola, de: de.clone(), ate: aro.add(erro), t: 0, dur: 0.85, cesta, fase: 'voo', v: new THREE.Vector3() });
  }

  moverBolas(dt) {
    for (let i = this.bolas.length - 1; i >= 0; i--) {
      const b = this.bolas[i];
      b.t += dt;
      if (b.fase === 'voo') {
        const k = Math.min(1, b.t / b.dur);
        b.m.position.lerpVectors(b.de, b.ate, k);
        b.m.position.y += Math.sin(k * Math.PI) * 1.4;
        if (k >= 1) {
          b.fase = 'queda'; b.t = 0;
          // cesta: cai pela rede; erro: bate no aro e espirra para o lado
          b.v.set(b.cesta ? -0.3 : -1.2 - Math.random(), b.cesta ? -0.5 : 1.2, b.cesta ? 0 : (b.ate.z - QUADRA.aro.z) * 5);
          if (b.cesta) this.cestas = (this.cestas || 0) + 1;
        }
      } else {
        b.v.y -= 9.8 * dt;
        b.m.position.addScaledVector(b.v, dt);
        if (b.m.position.y < 0.12) { b.m.position.y = 0.12; b.v.y = Math.abs(b.v.y) * 0.55; b.v.x *= 0.7; b.v.z *= 0.7; }
        b.m.rotation.x += dt * 6;
        if (b.t > 2.2) { this.grupo.remove(b.m); this.bolas.splice(i, 1); }
      }
    }
  }

  // ---------- subagentes ----------
  skinSub(sub) {
    const s = config.get('skins');
    return resolver(s.subIds[sub.id] || s.subTipos[sub.name] || s.subPadrao, 'sub:' + sub.id);
  }

  subagentes(lista) {
    const vivos = new Set();
    for (const sub of lista) {
      vivos.add(sub.id);
      let a = this.atores.get('sub:' + sub.id);
      if (!a && sub.status === 'done') continue; // ja terminou antes de entrar: nem aparece
      if (!a) a = this.novoSub(sub);
      a.sub = sub;
      if (sub.status === 'done') this.terminarSub(a);
      else if (a.lugar && a.sentado && !a.saindo) {
        const pose = POSE_TIPO[sub.kind] || 'digitar';
        if (a.passo && a.passo.tipo === 'fazer' && a.passo.pose !== pose) { a.fila = []; a.passo = null; a.depois([{ tipo: 'fazer', pose, dur: Infinity }]); }
      }
    }
    for (const a of this.atores.values()) if (a.papel === 'sub' && !vivos.has(a.subId)) this.terminarSub(a);
  }

  novoSub(sub) {
    const a = new Ator(this.kit, this.skinSub(sub), {
      id: 'sub:' + sub.id, subId: sub.id, nome: this.nomeLivre(sub.id), papel: 'sub', cor: COR_PAPEL.sub,
      x: PORTA.fora.x, z: PORTA.fora.z, ang: Math.PI / 2,
    });
    this.grupo.add(a.raiz);
    this.atores.set(a.id, a);
    const lugar = a.lugar = this.alocar(a);
    const passos = [{ tipo: 'direto', destino: PORTA.dentro }];
    if (lugar) {
      passos.push({ tipo: 'ir', destino: lugar.via }, { tipo: 'ir', destino: lugar.aprox },
        { tipo: 'sentar', lugar: { x: lugar.x, z: lugar.z, ang: lugar.ang, id: lugar.id } },
        { tipo: 'fazer', pose: POSE_TIPO[sub.kind] || 'digitar', dur: Infinity });
    } else {
      // sem lugar: espera em pe no lounge
      const s = SPOTS.conversa[Math.floor(Math.random() * SPOTS.conversa.length)];
      passos.push({ tipo: 'ir', destino: s }, { tipo: 'fazer', pose: 'pensar', dur: Infinity, texto: 'esperando uma mesa livre' });
    }
    a.agir(passos);
    return a;
  }

  // nome sorteado pela semente, sem repetir o de alguem que ja esta na sala
  nomeLivre(semente) {
    const usados = new Set([...this.atores.values()].map((a) => a.nome));
    for (let i = 0; i < 40; i++) { const n = nomeAleatorio(i ? semente + '#' + i : semente); if (!usados.has(n)) return n; }
    return nomeAleatorio(semente);
  }

  // primeira salinha livre; depois os lugares livres da mesa redonda
  alocar(a) {
    for (let i = 0; i < PODS.length; i++) {
      const id = 'pod' + i;
      if (this.lugares.has(id)) continue;
      this.lugares.set(id, a.id);
      this.esc.sala.mostrarPod(i);
      const p = PODS[i];
      return { id, tipo: 'pod', i, x: p.cadeira.x, z: p.cadeira.z, ang: p.cadeira.ang, via: p.porta, aprox: p.dentro };
    }
    for (let i = 0; i < ASSENTOS.length; i++) {
      if (i === LUGAR_PRINCIPAL.plan || i === LUGAR_PRINCIPAL.build) continue;
      const id = 'mesa' + i;
      if (this.lugares.has(id)) continue;
      this.lugares.set(id, a.id);
      const s = ASSENTOS[i];
      return { id, tipo: 'mesa', i, x: s.x, z: s.z, ang: s.ang, via: s.aprox, aprox: s.aprox };
    }
    // mesa cheia de figurantes ajudando: o subagente tem prioridade e o figurante vai para o lounge
    for (const [id, dono] of this.lugares) {
      if (!id.startsWith('mesa') || !dono.startsWith('npc')) continue;
      const npc = this.atores.get(dono);
      this.lugares.set(id, a.id); // antes do figurante procurar outro lugar
      if (npc) { npc.lugar = null; this.apoiar(npc); }
      const i = +id.slice(4), s = ASSENTOS[i];
      return { id, tipo: 'mesa', i, x: s.x, z: s.z, ang: s.ang, via: s.aprox, aprox: s.aprox };
    }
    return null;
  }

  liberarLugar(a) {
    if (!a.lugar) return;
    if (this.lugares.get(a.lugar.id) === a.id) this.lugares.delete(a.lugar.id);
    const mesa = a.lugar.tipo === 'mesa';
    if (mesa) this.esc.sala.telaMesa(a.lugar.i, null); else this.esc.sala.telaPod(a.lugar.i, null);
    a.lugar = null;
    // abriu um lugar na mesa: um figurante que ficou em pe no lounge volta a sentar
    if (mesa && this.foco) {
      const npc = [...this.atores.values()].find((n) => n.papel === 'npc' && n.apoio && !n.lugar);
      if (npc) this.apoiar(npc);
    }
  }

  // terminou: leva o papel ao agente principal, as vezes passa na agua ou na quadra, e vai embora
  terminarSub(a) {
    if (a.saindo) return;
    a.saindo = true;
    a.atividade = 'entregando o resultado';
    const dono = this.atores.get((a.sub && a.sub.parent) || 'build') || this.atores.get('build');
    const passos = [{ tipo: 'func', f: (x) => { this.liberarLugar(x); x.p.segurar('papel'); } }];
    if (a.lugar && a.lugar.tipo === 'pod') passos.push({ tipo: 'ir', destino: PODS[a.lugar.i].porta });
    if (dono) {
      const alvo = this.pertoDe(dono);
      passos.push({ tipo: 'ir', destino: alvo, pose: 'carregar' },
        { tipo: 'func', f: (x) => x.fila.unshift({ tipo: 'virar', ang: Math.atan2(dono.x - x.x, dono.z - x.z) }) },
        { tipo: 'fazer', pose: 'entregar', dur: 1.3, texto: 'aqui está! ✔' },
        { tipo: 'func', f: (x) => x.p.segurar(null) });
    }
    const extra = Math.random();
    const at = extra < 0.45 ? ATIVIDADES[0] : extra < 0.65 ? ATIVIDADES[4] : null;
    if (at) {
      const i = at.spots.findIndex((_, k) => !this.reservas.has(at.id + ':' + k));
      if (i >= 0) passos.push(...this.passosAtividade(a, at, i).map((p) => (p.tipo === 'fazer' ? { ...p, dur: Math.min(p.dur, 5) } : p)));
    }
    passos.push({ tipo: 'func', f: (x) => { x.atividade = 'indo embora 👋'; } }, { tipo: 'ir', destino: PORTA.dentro },
      { tipo: 'direto', destino: PORTA.fora }, { tipo: 'func', f: (x) => this.remover(x) });
    a.agir(passos);
  }

  // um ponto livre do lado de quem vai receber
  pertoDe(dono) {
    for (const [dx, dz] of [[0.9, 0.5], [-0.9, 0.5], [0, 1.0], [0.9, -0.5], [-0.9, -0.5]]) {
      const p = { x: dono.x + dx, z: dono.z + dz };
      if (livre(p.x, p.z)) return p;
    }
    return { x: dono.x, z: dono.z + 1 };
  }

  remover(a) {
    this.liberarReservas(a);
    this.liberarLugar(a);
    this.grupo.remove(a.raiz);
    a.p.liberar();
    this.atores.delete(a.id);
    this.esc.baloes.remover(a.id);
  }

  // ---------- figurantes e o robo aspirador ----------
  criarFigurantes() {
    for (let i = 0; i < 3; i++) {
      const s = SPOTS.janela[i] || SPOTS.conversa[i];
      const a = new Ator(this.kit, this.skinFigurante(i), { id: 'npc' + i, nome: this.nomeLivre('npc' + i), papel: 'npc', cor: COR_PAPEL.npc, x: s.x + 1, z: s.z, ang: 0 });
      this.grupo.add(a.raiz);
      this.atores.set(a.id, a);
      a.agir([{ tipo: 'fazer', pose: 'em pe', dur: i * 1.5 }, { tipo: 'func', f: (x) => this.rotina(x) }]);
    }
  }
  skinFigurante(i) {
    const pref = this.esc.tema.figurantes;
    return pref && pref[i] && SKINS[pref[i]] ? SKINS[pref[i]] : aleatoria('figurante:' + this.esc.tema.id + ':' + i);
  }

  criarAspirador() {
    const k = this.kit, g = new THREE.Group();
    k.cil(0.2, 0.21, 0.08, k.mat(0x2b2f3a, { rough: 0.4, metal: 0.3 }), 0, 0.05, 0, g);
    k.cil(0.12, 0.12, 0.02, k.mat(0x3a4252, { rough: 0.3 }), 0, 0.1, 0, g);
    this.luzAspirador = k.esf(0.025, k.mat(0x111111, { emis: 0x4ade80, ei: 2 }), 0, 0.11, 0.13, g);
    g.position.set(-2, 0, 4);
    this.grupo.add(g);
    this.aspirador = { g, pts: [], x: -2, z: 4 };
  }
  moverAspirador(dt, t) {
    const a = this.aspirador;
    if (!a.pts.length) {
      for (let k = 0; k < 20; k++) { const p = { x: entre(-11, 11), z: entre(-4.5, 7.5) }; if (livre(p.x, p.z)) { a.pts = caminho({ x: a.x, z: a.z }, p); break; } }
      return;
    }
    const p = a.pts[0], dx = p.x - a.x, dz = p.z - a.z, d = Math.hypot(dx, dz), v = 0.55 * dt;
    if (d <= v) { a.x = p.x; a.z = p.z; a.pts.shift(); } else { a.x += (dx / d) * v; a.z += (dz / d) * v; a.g.rotation.y += (Math.atan2(dx, dz) - a.g.rotation.y) * Math.min(1, dt * 3); }
    a.g.position.set(a.x, 0, a.z);
    this.luzAspirador.material.emissiveIntensity = 1 + Math.sin(t * 5);
  }

  // ---------- skins mudaram (config, sessao nova ou tema) ----------
  reaplicarSkins() {
    for (const a of this.atores.values()) {
      let s;
      if (a.papel === 'plan' || a.papel === 'build') s = this.skinPrincipal(a.papel);
      else if (a.papel === 'sub' && a.sub) s = this.skinSub(a.sub);
      else if (a.papel === 'npc') s = this.skinFigurante(+a.id.slice(3));
      if (s && JSON.stringify(s) !== JSON.stringify(a.skin)) a.trocarSkin(s);
    }
  }

  // o tema mudou: a sala nova nasce com as salinhas escondidas; mostra as que estao em uso
  reaplicarSala() {
    for (const [id] of this.lugares) if (id.startsWith('pod')) this.esc.sala.mostrarPod(+id.slice(3));
    this.reaplicarSkins();
  }

  // ---------- por quadro ----------
  tick(dt, t) {
    for (const a of this.atores.values()) a.atualizar(dt);
    this.moverBolas(dt);
    this.moverAspirador(dt, t);
    const sala = this.esc.sala;
    // porta abre quando alguem esta perto
    let perto = false;
    for (const a of this.atores.values()) if (Math.hypot(a.x - PORTA.x, a.z - PORTA.z) < 1.7) { perto = true; break; }
    sala.porta.alvo = perto ? 1 : 0;
    // telas: notebook dos principais e monitores das salinhas
    for (const who of ['plan', 'build']) {
      const a = this.atores.get(who), st = a && a.estado;
      const naCadeira = a && a.sentado && a.sentado.id === ASSENTOS[LUGAR_PRINCIPAL[who]].id;
      const ajuda = a && a.apoio && naCadeira && st && st.status === 'idle';
      const cor = ajuda ? TELA[this.tipoFoco] ?? 0xb48cff : !st || st.status === 'idle' || !naCadeira && st.status === 'working' ? null : st.status === 'working' ? TELA[st.kind] ?? 0xb48cff : st.status === 'waiting' ? 0xfbbf24 : st.status === 'error' ? 0xf87171 : 0x4ade80;
      sala.telaMesa(LUGAR_PRINCIPAL[who], cor);
    }
    for (const a of this.atores.values()) {
      if (!a.lugar || !a.sentado) continue;
      if (a.papel === 'npc') { sala.telaMesa(a.lugar.i, a.apoio && a.sentado.id === a.lugar.id ? TELA[this.tipoFoco] ?? 0xb48cff : null); continue; }
      if (a.papel !== 'sub') continue;
      const cor = TELA[a.sub && a.sub.kind] ?? 0x3ddc97;
      if (a.lugar.tipo === 'pod') sala.telaPod(a.lugar.i, cor); else sala.telaMesa(a.lugar.i, cor);
    }
    // a camera "seguir" vai para quem esta trabalhando (ou pedindo algo)
    const st = this.estado && this.estado.agents;
    const ativo = st && (['waiting', 'error', 'working'].map((s) => ['build', 'plan'].find((w) => st[w].status === s)).find(Boolean));
    const foco = ativo ? this.atores.get(ativo) : null;
    this.engine.foco = this.engine.seguirAtor && this.atores.get(this.engine.seguirAtor) || foco || { x: 0, z: 0 };
    // baloes
    for (const a of this.atores.values()) this.esc.baloes.definir(a, this.balao(a));
    this.relogioTv += dt;
    if (this.relogioTv > 1) { this.relogioTv = 0; this.desenharTv(); }
  }

  balao(a) {
    if (a.papel === 'npc') return a.apoio ? { texto: this.textoApoio(a), nome: a.nome, classe: 'working', cor: COR_PAPEL.npc } : { texto: '', nome: a.nome, classe: 'idle', cor: COR_PAPEL.npc };
    if (a.papel === 'sub') {
      const s = a.sub || {};
      const texto = a.saindo || !a.sentado ? (a.atividade || 'chegando…') : (s.text || s.task || 'trabalhando…');
      return { texto, nome: `${a.nome} · ${s.name || 'subagente'}`, tag: s.tag || '', classe: a.saindo ? 'done' : 'working', cor: COR_PAPEL.sub };
    }
    const st = a.estado || { status: 'idle' };
    const nome = `${NOME_PAPEL[a.papel]} · ${a.papel === 'plan' ? 'Plan' : 'Build'}`;
    // a tag de plan/build vem do estado (o mundo nao le o agentes.tsv)
    const tag = (this.estado && this.estado.tags && this.estado.tags[a.papel]) || '';
    if (st.status === 'idle' && a.apoio) return { texto: this.textoApoio(a), nome, tag, classe: 'working', cor: COR_PAPEL[a.papel] };
    const texto = st.status === 'idle' ? (a.atividade || 'descansando…') : (st.text || (st.status === 'done' ? 'pronto!' : 'trabalhando…'));
    return { texto, nome, tag, classe: st.status, cor: COR_PAPEL[a.papel] };
  }

  // ---------- telao com o painel ao vivo ----------
  desenharTv() {
    const s = this.estado;
    if (!s || !this.esc.sala) return;
    const corEstado = { idle: '#8a8fa0', working: '#4ade80', waiting: '#fbbf24', error: '#f87171', done: '#4ade80' };
    const nomeEstado = { idle: 'livre', working: 'trabalhando', waiting: 'esperando você', error: 'erro', done: 'pronto' };
    this.esc.sala.tv((c, w, h) => {
      const g = c.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#0d1424'); g.addColorStop(1, '#141a2e');
      c.fillStyle = g; c.fillRect(0, 0, w, h);
      c.fillStyle = '#5aa9ff'; c.fillRect(0, 0, w, 8);
      c.font = 'bold 44px Segoe UI, sans-serif'; c.fillStyle = '#eef0f6'; c.textBaseline = 'top';
      c.fillText('PAINEL DOS AGENTES', 40, 34);
      c.font = '36px Segoe UI, sans-serif'; c.fillStyle = '#9097a8'; c.textAlign = 'right';
      c.fillText(new Date().toTimeString().slice(0, 5), w - 40, 40); c.textAlign = 'left';
      let y = 120;
      for (const who of ['plan', 'build']) {
        const a = s.agents[who];
        c.fillStyle = corEstado[a.status] || '#8a8fa0'; c.beginPath(); c.arc(56, y + 24, 14, 0, 7); c.fill();
        c.font = 'bold 36px Segoe UI, sans-serif'; c.fillStyle = who === 'plan' ? '#ffb454' : '#5aa9ff'; c.fillText(NOME_PAPEL[who], 86, y + 4);
        c.font = '32px Segoe UI, sans-serif'; c.fillStyle = '#c9cfdb';
        const txt = (nomeEstado[a.status] || a.status) + (a.text && a.status !== 'idle' ? ' — ' + a.text : '');
        c.fillText(txt.length > 46 ? txt.slice(0, 45) + '…' : txt, 330, y + 8);
        y += 78;
      }
      const subs = (s.subs || []).filter((x) => x.status !== 'done');
      c.font = 'bold 32px Segoe UI, sans-serif'; c.fillStyle = '#3ddc97'; c.fillText(`🤖 ${subs.length} subagente${subs.length === 1 ? '' : 's'}`, 40, y + 10);
      c.font = '28px Segoe UI, sans-serif'; c.fillStyle = '#9097a8';
      const nome = (x) => (this.atores.get('sub:' + x.id) || {}).nome || nomeAleatorio(x.id); // o mesmo nome do balao
      c.fillText(subs.slice(0, 4).map((x) => nome(x) + ' (' + x.name + ')').join('  ·  ').slice(0, 70), 330, y + 14);
      y += 80;
      const lim = config.get('ctxLimite'), pct = Math.min(1, (s.ctxTokens || 0) / lim);
      c.fillStyle = '#9097a8'; c.font = '28px Segoe UI, sans-serif'; c.fillText('contexto', 40, y);
      c.fillStyle = '#0a0e18'; c.fillRect(200, y + 6, 560, 24);
      c.fillStyle = pct > 0.8 ? '#f87171' : pct > 0.6 ? '#fbbf24' : '#4ade80'; c.fillRect(200, y + 6, 560 * pct, 24);
      c.fillStyle = '#eef0f6'; c.fillText(Math.round(pct * 100) + '%', 780, y);
      y += 60;
      c.fillStyle = '#9097a8';
      c.fillText(`💰 $${(s.cost || 0).toFixed(2)}    📝 ${s.files || 0} arquivos    🏀 ${this.cestas || 0} cestas hoje`, 40, y);
      const skills = (s.skills || []).slice().reverse().map((k) => k.name);
      if (skills.length) { c.fillStyle = '#ff7ad9'; c.fillText(('✨ skills: ' + skills.join('  ·  ')).slice(0, 60), 40, y + 50); }
      if (s.project) { c.textAlign = 'right'; c.fillText(s.project, w - 40, h - 50); c.textAlign = 'left'; }
    });
  }

  liberar() { this.esc.baloes.limpar(); this.engine.scene.remove(this.grupo); this.kit.liberar(); }
}
