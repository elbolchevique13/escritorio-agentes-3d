// Baloes em HTML sobre cada personagem (texto nitido em qualquer zoom) e o clique para ver detalhes.
import * as THREE from 'three';

const v = new THREE.Vector3();

export class Baloes {
  constructor(camada, engine, aoClicar) {
    this.camada = camada;
    this.engine = engine;
    this.aoClicar = aoClicar;
    this.itens = new Map(); // id do ator -> { el, txt, nome }
  }

  // garante um balao para o ator; info: { texto, nome, tag, classe ('working'|'idle'...), cor }
  definir(ator, info) {
    let b = this.itens.get(ator.id);
    if (!b) {
      const el = document.createElement('div');
      el.className = 'balao';
      el.dataset.id = ator.id;
      const txt = document.createElement('span'); txt.className = 'txt';
      const nome = document.createElement('span'); nome.className = 'nome';
      const tag = document.createElement('span'); tag.className = 'tag';
      el.append(txt, nome, tag);
      el.addEventListener('click', () => this.aoClicar(ator.id));
      this.camada.appendChild(el);
      b = { el, txt, nome, tag, ator };
      this.itens.set(ator.id, b);
    }
    b.ator = ator;
    if (b.txt.textContent !== info.texto) { b.txt.textContent = info.texto; b.txt.title = info.texto; }
    if (b.nome.textContent !== info.nome) b.nome.textContent = info.nome;
    // badge de funcao: fica sob o nome, nunca dentro do balao
    const t = info.tag || '';
    if (b.tag.textContent !== t) b.tag.textContent = t;
    b.tag.hidden = !t;
    const cls = 'balao ' + (info.classe || 'idle') + (info.texto ? '' : ' mini');
    if (b.el.className !== cls) b.el.className = cls;
    if (info.cor && b.el.style.getPropertyValue('--c') !== info.cor) b.el.style.setProperty('--c', info.cor);
  }

  remover(id) {
    const b = this.itens.get(id);
    if (b) { b.el.remove(); this.itens.delete(id); }
  }

  // reposiciona todos (chamado a cada quadro)
  atualizar() {
    const cam = this.engine.camera, w = this.camada.clientWidth, h = this.camada.clientHeight;
    const vis = [];
    for (const b of this.itens.values()) {
      b.ator.topo(v);
      const dist = v.distanceTo(cam.position);
      v.project(cam);
      const visivel = v.z < 1 && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2 && b.ator.raiz.visible !== false;
      b.el.style.display = visivel ? '' : 'none';
      if (!visivel) continue;
      // longe da camera os baloes encolhem um pouco (sem sumir)
      const s = Math.max(0.85, Math.min(1.15, 18 / dist));
      if (!b.w || b.mediuTxt !== b.txt.textContent + b.el.className + b.tag.textContent + (b.tag.hidden ? 'h' : '')) {
        b.w = b.el.offsetWidth; b.h = b.el.offsetHeight;
        b.mediuTxt = b.txt.textContent + b.el.className + b.tag.textContent + (b.tag.hidden ? 'h' : '');
      }
      vis.push({ b, x: (v.x * 0.5 + 0.5) * w, y: (-v.y * 0.5 + 0.5) * h, s, dist, w: b.w * s, h: b.h * s });
    }
    // empilha: quem esta mais perto da camera fica no lugar; quem cruzar com ele sobe
    // (distancia arredondada + id no desempate: a ordem nao fica trocando de um quadro para o outro)
    vis.sort((a, c) => Math.round(a.dist * 2) - Math.round(c.dist * 2) || (a.b.ator.id < c.b.ator.id ? -1 : 1));
    const postos = [];
    for (const q of vis) {
      for (let tentativa = 0; tentativa < 8; tentativa++) {
        const cruza = postos.find((p) => Math.abs(p.x - q.x) < (p.w + q.w) / 2 - 4 && Math.abs(p.y - q.y) < (p.h + q.h) / 2 - 2);
        if (!cruza) break;
        q.y = cruza.y - (cruza.h + q.h) / 2 - 2;
      }
      postos.push(q);
      // desliza ate a posicao nova (sem "pular" de um quadro para o outro)
      q.b.yy = q.b.yy === undefined || Math.abs(q.b.yy - q.y) > 200 ? q.y : q.b.yy + (q.y - q.b.yy) * 0.35;
      q.b.el.style.transform = `translate(${q.x.toFixed(1)}px, ${q.b.yy.toFixed(1)}px) translate(-50%, -100%) scale(${q.s.toFixed(3)})`;
      q.b.el.style.zIndex = String(1000 - Math.round(q.dist * 10));
    }
  }

  limpar() { for (const id of [...this.itens.keys()]) this.remover(id); }
}
