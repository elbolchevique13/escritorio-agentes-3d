// A pagina de verdade, num Chrome headless, ligada ao servidor de teste.
// Pulado se nao houver Chrome/Edge na maquina (CHROME_PATH aponta outro).
// ESCRITORIO_PRINTS=<pasta> salva capturas de tela de cada teste nessa pasta.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { app, listen, close, req, sse, janelaCmds } = require("./helpers");
const browser = require("./browser");

const skip = !browser.available && "Chrome/Edge nao encontrado";
let page, url;
const print = (nome) => process.env.ESCRITORIO_PRINTS && page.screenshot(path.join(process.env.ESCRITORIO_PRINTS, nome + ".png"));
// sem capturas de tela, os testes usam a qualidade baixa (o Chrome de teste desenha sem placa de video)
const QUAL = process.env.ESCRITORIO_PRINTS ? "alta" : "baixa";
const abrir = (extra = "") => page.open(url, `if (window.top === window) { try { const c = JSON.parse(localStorage.getItem('escritorio.config') || '{}'); c.qualidade = '${QUAL}'; localStorage.setItem('escritorio.config', JSON.stringify(c)); } catch {} ${extra} }`);
const limpo = () => page.errors.filter((e) => !/WebGL|GPU stall|GL Driver/i.test(e));

test.before(async () => {
  if (skip) return;
  url = `http://localhost:${await listen()}/`;
  page = await browser.launch();
});
test.after(async () => { if (page) await page.close(); await close(); });

test("a pagina conecta, mostra o estado e liga o 3D sem erros", { skip }, async () => {
  await req("GET", "/set?agent=build&status=working&kind=read&text=lendo%20teste.js");
  await abrir();
  await page.until(`window.ESC && ESC.estado && ESC.estado.agents.build.text === 'lendo teste.js'`);
  await page.until(`ESC.pronto === true`, 15000);
  assert.match(await page.eval(`document.getElementById('conn').textContent`), /aguardando|conectado/);
  await print("01-inicio");
  assert.deepStrictEqual(limpo(), []);
  await req("GET", "/set?agent=build&status=idle");
});

test("uma conexao /events por aba", { skip }, async () => {
  await req("GET", "/sub?id=nav1&name=explore&text=procurando");
  await abrir();
  await page.until(`document.getElementById('cSub').textContent === '1'`);
  await new Promise((r) => setTimeout(r, 500));
  assert.strictEqual(page.requests.filter((p) => p === "/events").length, 1, page.requests.join(" "));
  await req("GET", "/sub?id=nav1&status=done");
});

test("botoes da janela: ocultar e sempre por cima", { skip }, async () => {
  await abrir("try { const c = JSON.parse(localStorage.getItem('escritorio.config')); delete c.fixar; localStorage.setItem('escritorio.config', JSON.stringify(c)); } catch {}");
  await page.until(`!document.getElementById('bHide').hidden === ${process.platform === "win32"}`);
  if (process.platform !== "win32") return;
  janelaCmds.length = 0;
  await page.eval(`document.getElementById('bPin').click()`);
  await page.until(`document.getElementById('bPin').classList.contains('on')`);
  await page.eval(`document.getElementById('bHide').click()`);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepStrictEqual(janelaCmds, ["pin", "minimize"]);
  assert.strictEqual(app.S.janela.hidden, true);
  await page.eval(`document.getElementById('bPin').click()`);
  await new Promise((r) => setTimeout(r, 300));
  assert.strictEqual(app.S.janela.pinned, false);
  app.handleClaude({ hook_event_name: "UserPromptSubmit", session_id: "nav" }); // desfaz o ocultar
  app.handleClaude({ hook_event_name: "Stop", session_id: "nav" });
});

test("demo mostra estados de mentira e volta ao estado real", { skip }, async () => {
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bDemo').click()`);
  await page.until(`ESC.estado.project === 'demo'`);
  assert.strictEqual(await page.eval(`ESC.estado.agents.plan.status`), "working");
  assert.strictEqual(app.S.agents.plan.status, "idle", "o demo nao pode mexer no servidor");
  assert.deepStrictEqual(limpo(), []);
});

test("os 5 temas montam sem erro (e liberam a GPU ao trocar)", { skip }, async () => {
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  const ids = await page.eval(`import('/js/office3d/temas/index.js').then(m => m.TEMAS.map(t => t.id))`);
  assert.strictEqual(ids.length, 5);
  // vazamento: da 3 voltas pelos temas; se a troca deixasse lixo, a memoria cresceria a cada volta.
  // (A 1a volta ainda enche os caches dos personagens; comparamos o fim da 2a com o fim da 3a.)
  // O diretor fica parado para os personagens nao mudarem no meio da medicao.
  await page.eval(`void (ESC.escritorio.diretor.tick = () => {})`);
  const voltas = [];
  for (let volta = 0; volta < 3; volta++) {
    for (const id of [...ids.slice(1), ids[0]]) {
      await page.eval(`ESC.escritorio.trocarTema('${id}')`);
      if (volta === 0) { await new Promise((r) => setTimeout(r, 600)); await print("tema-" + id); }
    }
    // desenha um quadro antes de medir (a contagem so inclui o que ja foi enviado a GPU)
    voltas.push(await page.eval(`(() => { const e = ESC.escritorio.engine; e.renderer.render(e.scene, e.camera); return JSON.stringify(e.renderer.info.memory); })()`));
  }
  assert.strictEqual(voltas[2], voltas[1], "trocar de tema deixou lixo na GPU: " + voltas.join(" -> "));
  assert.deepStrictEqual(limpo(), []);
});

test("vitrine: todas as skins prontas e algumas aleatorias, em varias poses", { skip }, async () => {
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  const n = await page.eval(`(async () => {
    const THREE = await import('three');
    const { Personagem } = await import('/js/office3d/personagem.js');
    const { SKINS, aleatoria } = await import('/js/office3d/skins.js');
    const { Kit } = await import('/js/office3d/geo.js');
    const e = ESC.escritorio.engine, g = new THREE.Group(); e.scene.add(g);
    const kit = new Kit(g);
    const lista = [...Object.values(SKINS), aleatoria('a'), aleatoria('b'), aleatoria('c')];
    const poses = ['em pe', 'acenar', 'comemorar', 'pensar', 'conversar', 'desespero', 'beber', 'janela', 'em pe', 'acenar', 'regar', 'comemorar', 'em pe', 'conversar', 'pensar', 'em pe'];
    const ps = lista.map((s, i) => { const p = new Personagem(kit, s); p.raiz.position.set(-6.3 + (i % 8) * 1.8, 0, -1 + Math.floor(i / 8) * 2.4); p.setPose(poses[i]); g.add(p.raiz); return p; });
    e.onTick((dt) => ps.forEach((p) => p.atualizar(dt)));
    e.setCamera('livre'); e.mexeu = performance.now() + 1e9;
    ESC.escritorio.sala.raiz.visible = false; // so os personagens na foto
    e.controles.target.set(0, 0.9, 0.2); e.camera.position.set(0, 3.2, 10.5);
    window.__vitrine = { g, kit };
    return ps.length;
  })()`);
  assert.strictEqual(n, 16);
  await new Promise((r) => setTimeout(r, 1500));
  await print("vitrine");
  // close no primeiro (Ronaldinho), de frente e de costas
  await page.eval(`(() => { const e = ESC.escritorio.engine; e.controles.minDistance = 0.5; e.controles.target.set(-6.3, 1.15, -1); e.camera.position.set(-6.3, 1.45, 0.9); })()`);
  await new Promise((r) => setTimeout(r, 400));
  await print("vitrine-ronaldinho");
  await page.eval(`(() => { const e = ESC.escritorio.engine; e.camera.position.set(-6.3, 1.5, -3.6); })()`);
  await new Promise((r) => setTimeout(r, 400));
  await print("vitrine-ronaldinho-costas");
  await page.eval(`ESC.escritorio.sala.raiz.visible = true`);
  assert.deepStrictEqual(limpo(), []);
});

test("vida no escritorio: senta para trabalhar, subagentes nas salinhas, acena e vai embora", { skip }, async () => {
  const d = "ESC.escritorio.diretor";
  await req("GET", "/set?agent=build&status=working&kind=read&text=lendo%20app.js");
  await req("GET", "/sub?id=v1&name=Explore&text=procurando%20rotas&kind=search");
  await req("GET", "/sub?id=v2&name=general-purpose&text=rodando%20testes&kind=bash");
  await abrir();
  await page.until(`ESC.pronto === true`);
  await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 3, passoMax: 0.4 })`);
  // o Construtor senta no lugar dele e os dois subagentes, nas salinhas 01 e 02
  await page.until(`${d}.atores.get('build')?.sentado?.id === 'mesa1'`, 30000);
  await page.until(`${d}.atores.get('sub:v1')?.sentado && ${d}.atores.get('sub:v2')?.sentado`, 40000);
  const lugares = await page.eval(`[${d}.atores.get('sub:v1').lugar.id, ${d}.atores.get('sub:v2').lugar.id].sort().join()`);
  assert.strictEqual(lugares, "pod0,pod1");
  // o balao mostra o que o agente esta fazendo
  assert.match(await page.eval(`document.querySelector('.balao[data-id="build"] .txt').textContent`), /lendo app\.js/);
  await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 1, passoMax: 0.1 })`);
  await print("vida-trabalhando");

  // um terceiro subagente ganha a salinha 03, que "brota" na sala
  await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 3, passoMax: 0.4 })`);
  await req("GET", "/sub?id=v3&name=Plan&text=pensando&kind=think");
  await page.until(`${d}.atores.get('sub:v3')?.lugar?.id === 'pod2' && ESC.escritorio.sala.podVisivel(2)`);

  // pedir permissao: o Auditor fica em pe acenando
  await req("GET", "/set?agent=plan&status=waiting&text=pedindo%20permiss%C3%A3o");
  await page.until(`${d}.atores.get('plan').p.pose === 'acenar'`, 20000);
  assert.ok(await page.eval(`document.querySelector('.balao[data-id="plan"]').classList.contains('waiting')`));

  // o subagente termina: entrega o resultado e sai pela porta
  await req("GET", "/sub?id=v1&status=done");
  await page.until(`${d}.atores.get('sub:v1')?.saindo === true`);
  await page.until(`!${d}.atores.has('sub:v1')`, 90000);
  assert.strictEqual(await page.eval(`${d}.lugares.has('pod0')`), false, "a salinha ficou presa");
  assert.deepStrictEqual(limpo(), []);

  for (const id of ["v2", "v3"]) await req("GET", `/sub?id=${id}&status=done`);
  await req("GET", "/set?agent=plan&status=idle");
  await req("GET", "/set?agent=build&status=idle");
});

test("aparencia: troca o tema e a skin pela gaveta, e o editor salva um personalizado", { skip }, async () => {
  await req("GET", "/set?agent=build&status=working&kind=edit&text=editando");
  await abrir("try { localStorage.removeItem('escritorio.config'); } catch {}");
  await page.until(`ESC.pronto === true`);
  await page.eval(`document.getElementById('bLook').click()`);
  await page.until(`!document.getElementById('aparencia').hidden && document.querySelectorAll('#aparencia .tema').length === 5`);
  // tema pelo cartao
  await page.eval(`[...document.querySelectorAll('#aparencia .tema')].find(b => b.textContent.includes('Cyberpunk')).click()`);
  await page.until(`ESC.escritorio.tema.id === 'cyberpunk' && ESC.config.get('tema') === 'cyberpunk'`);
  // skin do Construtor: Ronaldinho
  await page.eval(`[...document.querySelectorAll('#aparencia .abas button')][1].click()`);
  await page.until(`document.querySelectorAll('#aparencia .quem').length >= 6`);
  await page.eval(`[...document.querySelectorAll('#aparencia .quem')].find(q => q.textContent.includes('Construtor')).querySelector('button').click()`);
  await page.until(`document.querySelectorAll('#aparencia .skin').length >= 14`);
  await page.until(`(() => { const c = [...document.querySelectorAll("#aparencia .skin canvas")].at(-2); const d = c.getContext("2d").getImageData(64, 64, 1, 1).data; return d[3] > 0; })()`, 40000); // miniaturas prontas (a penultima tem pixel desenhado)
  await print("aparencia-skins");
  await page.eval(`[...document.querySelectorAll('#aparencia .skin')].find(b => b.textContent === 'Ronaldinho').click()`);
  await page.until(`ESC.escritorio.diretor.atores.get('build').skin.nome === 'Ronaldinho'`);
  // editor: personalizado para o Auditor
  await page.eval(`[...document.querySelectorAll('#aparencia .quem')].find(q => q.textContent.includes('Auditor')).querySelector('button').click()`);
  await page.until(`[...document.querySelectorAll('#aparencia .skin')].some(b => b.textContent.includes('Personalizado'))`);
  await page.eval(`[...document.querySelectorAll('#aparencia .skin')].find(b => b.textContent.includes('Personalizado')).click()`);
  await page.until(`document.querySelector('#aparencia canvas.previa')`);
  await page.eval(`(() => { const i = document.querySelector('#aparencia .editor input[type=text]'); i.value = 'Meu agente'; i.dispatchEvent(new Event('input')); })()`);
  await page.eval(`[...document.querySelectorAll('#aparencia .editor button')].find(b => b.textContent === 'coroa').click()`);
  await new Promise((r) => setTimeout(r, 1200));
  await print("aparencia-editor");
  await page.eval(`[...document.querySelectorAll('#aparencia button')].find(b => b.textContent.includes('salvar')).click()`);
  await page.until(`ESC.escritorio.diretor.atores.get('plan').skin.nome === 'Meu agente'`);
  assert.ok(await page.eval(`ESC.escritorio.diretor.atores.get('plan').skin.acessorios.includes('coroa')`));
  // a escolha fica salva no navegador
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('escritorio.config')).skins.build`), "ronaldinho");
  await page.eval(`ESC.escritorio.engine.escala = 1`);
  await print("aparencia-sala");
  assert.deepStrictEqual(limpo(), []);
  await page.eval(`localStorage.removeItem('escritorio.config')`);
  await req("GET", "/set?agent=build&status=idle");
});

test("baloes nao se sobrepoem e subagentes tem nomes diferentes", { skip }, async () => {
  for (let i = 0; i < 4; i++) await req("GET", `/sub?id=n${i}&name=Explore&text=x&kind=read`);
  await abrir();
  await page.until(`ESC.pronto === true`);
  await page.until(`[...ESC.escritorio.diretor.atores.values()].filter(a => a.papel === 'sub').length === 4`);
  const nomes = await page.eval(`[...ESC.escritorio.diretor.atores.values()].filter(a => a.papel !== 'plan' && a.papel !== 'build').map(a => a.nome)`);
  assert.strictEqual(new Set(nomes).size, nomes.length, "nomes repetidos: " + nomes.join(", "));
  // Auditor e Construtor no mesmo lugar: os baloes tem que se separar
  await page.eval(`(() => { const d = ESC.escritorio.diretor; d.tick = ((t) => (dt, tt) => { for (const w of ['plan', 'build']) { const a = d.atores.get(w); a.fila = []; a.passo = null; a.x = 0; a.z = 3; } t.call(d, dt, tt); })(d.tick); })()`);
  await new Promise((r) => setTimeout(r, 2500));
  const cruzam = await page.eval(`(() => { const r = (id) => document.querySelector('.balao[data-id="' + id + '"] .txt').getBoundingClientRect(); const a = r('plan'), b = r('build'); return !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top); })()`);
  const info = await page.eval(`JSON.stringify(["plan", "build"].map((id) => { const e = document.querySelector('.balao[data-id="' + id + '"]'); const r = e.querySelector(".txt").getBoundingClientRect(); return { id, t: e.style.transform, top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: ESC.escritorio.baloes.itens.get(id).w }; }))`);
  assert.strictEqual(cruzam, false, "os baloes do Auditor e do Construtor estao um em cima do outro: " + info);
  for (let i = 0; i < 4; i++) await req("GET", `/sub?id=n${i}&status=done`);
});

test("a pagina se recarrega sozinha quando o servidor muda de versao", { skip }, async () => {
  await abrir();
  await page.until(`ESC.pronto === true`);
  await page.eval(`window.__marca = 1`);
  const antiga = app.S.versao;
  app.S.versao = "nova-" + Date.now();
  await req("GET", "/set?agent=plan&status=idle"); // provoca um envio do estado
  await page.until(`window.__marca === undefined && window.ESC && ESC.conexao.versao === ${JSON.stringify(app.S.versao)}`);
  app.S.versao = antiga;
});

test("modo foco: com o agente trabalhando todos sentam e trabalham; painel minimiza e lista subagentes e skills", { skip }, async () => {
  const d = "ESC.escritorio.diretor";
  await abrir("try { const c = JSON.parse(localStorage.getItem('escritorio.config')); delete c.painelMin; localStorage.setItem('escritorio.config', JSON.stringify(c)); } catch {}");
  await page.until(`ESC.pronto === true`);
  await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 3, passoMax: 0.4 })`);
  app.handleClaude({ hook_event_name: "UserPromptSubmit", session_id: "foco" });
  app.handleClaude({ hook_event_name: "PreToolUse", session_id: "foco", tool_name: "Skill", tool_input: { skill: "frontend-design" } });
  app.handleClaude({ hook_event_name: "PreToolUse", session_id: "foco", tool_name: "Agent", tool_use_id: "f1", tool_input: { subagent_type: "Explore", description: "achar estilos" } });
  app.handleClaude({ hook_event_name: "PreToolUse", session_id: "foco", agent_id: "ag-f1", agent_type: "Explore", tool_name: "Grep", tool_input: { pattern: "painel" } });
  // o Auditor (livre) e os 3 figurantes sentam na mesa redonda para ajudar
  await page.until(`${d}.foco === true`);
  await page.until(`(() => { const as = ['plan', 'npc0', 'npc1', 'npc2'].map(id => ${d}.atores.get(id)); return as.every(a => a.apoio && a.sentado && String(a.sentado.id).startsWith('mesa')); })()`, 60000);
  assert.match(await page.eval(`document.querySelector('.balao[data-id="npc0"] .txt').textContent`), /junto|revisando|terminal|skill|ajudando/);
  // painel: subagente com o que esta fazendo, skill acesa
  await page.until(`document.querySelector('#subsList li span')?.textContent === 'procurando painel'`);
  assert.match(await page.eval(`document.querySelector('#skillsList .skill.ativa').textContent`), /frontend-design/);
  await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 1, passoMax: 0.1 })`);
  await print("foco-todos-trabalhando");
  // minimizar: so a pilula do contexto fica; volta ao clicar de novo (e a escolha fica salva)
  await page.eval(`document.getElementById('bMin').click()`);
  assert.strictEqual(await page.eval(`document.body.classList.contains('painel-min') && getComputedStyle(document.getElementById('corpo')).display`), "none");
  assert.ok(await page.eval(`document.getElementById('painel').getBoundingClientRect().height < 50`));
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('escritorio.config')).painelMin`), true);
  await print("foco-painel-minimizado");
  await page.eval(`document.getElementById('bMin').click()`);
  assert.strictEqual(await page.eval(`document.body.classList.contains('painel-min')`), false);
  // acabou o trabalho: os figurantes levantam e liberam a mesa
  await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 3, passoMax: 0.4 })`);
  app.handleClaude({ hook_event_name: "PostToolUse", session_id: "foco", tool_name: "Agent", tool_use_id: "f1", tool_response: { content: "ok" } });
  app.handleClaude({ hook_event_name: "Stop", session_id: "foco" });
  await page.until(`${d}.foco === false && !${d}.atores.get('npc0').apoio`);
  await page.until(`![...${d}.lugares.values()].some(v => v.startsWith('npc'))`);
  assert.deepStrictEqual(limpo(), []);
  await req("GET", "/set?agent=build&status=idle");
});

test("modo foco: subagente tem prioridade na mesa cheia e os 5 temas funcionam com todos trabalhando", { skip }, async () => {
  const d = "ESC.escritorio.diretor";
  await req("GET", "/set?agent=build&status=working&kind=edit&text=editando%20app.js");
  await abrir();
  await page.until(`ESC.pronto === true`);
  await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 3, passoMax: 0.4 })`);
  await page.until(`['npc0', 'npc1', 'npc2'].every(id => ${d}.atores.get(id).lugar?.tipo === 'mesa')`, 30000);
  // 8 salinhas + 3 lugares livres da mesa (os figurantes estao em 3 dos 6): os 2 ultimos tiram figurantes
  for (let i = 0; i < 13; i++) await req("GET", `/sub?id=m${i}&name=Explore&text=lendo&kind=read`);
  await page.until(`[...${d}.atores.values()].filter(a => a.papel === 'sub' && a.lugar).length === 13`, 30000);
  const npcs = await page.eval(`['npc0', 'npc1', 'npc2'].map(id => ${d}.atores.get(id).lugar ? 'mesa' : 'lounge').sort().join()`);
  assert.strictEqual(npcs, "lounge,lounge,mesa");
  const donos = await page.eval(`JSON.stringify([...${d}.lugares.entries()])`);
  assert.strictEqual(new Set(JSON.parse(donos).map(([, v]) => v)).size, JSON.parse(donos).length, "lugar com dois donos: " + donos);
  for (let i = 0; i < 13; i++) await req("GET", `/sub?id=m${i}&status=done`);
  // os 5 temas com o escritorio em foco
  const ids = await page.eval(`import('/js/office3d/temas/index.js').then(m => m.TEMAS.map(t => t.id))`);
  for (const id of ids) {
    await page.eval(`ESC.escritorio.trocarTema('${id}')`);
    await page.until(`ESC.escritorio.tema.id === '${id}'`);
    await page.until(`['plan', 'npc0', 'npc1', 'npc2'].every(id => ${d}.atores.get(id).apoio && ${d}.atores.get(id).sentado)`, 90000);
    await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 1, passoMax: 0.1 })`);
    await new Promise((r) => setTimeout(r, 600));
    await print("foco-tema-" + id);
    await page.eval(`void Object.assign(ESC.escritorio.engine, { escala: 3, passoMax: 0.4 })`);
  }
  await page.eval(`ESC.escritorio.trocarTema(ESC.config.get('tema'))`);
  assert.deepStrictEqual(limpo(), []);
  await req("GET", "/set?agent=build&status=idle");
});

test("pedido de permissao no painel: botoes permitir/negar e o modo fora", { skip }, async () => {
  app._setRemoto({ token: "x".repeat(32), ntfy: "" });
  await abrir("try { const c = JSON.parse(localStorage.getItem('escritorio.config')); c.painelMin = true; localStorage.setItem('escritorio.config', JSON.stringify(c)); } catch {}");
  await page.until(`!document.getElementById('bFora').hidden`);
  await page.eval(`document.getElementById('bFora').click()`);
  await page.until(`document.getElementById('bFora').classList.contains('on')`);
  assert.strictEqual(app.S.fora, true);
  // o hook do Claude Code fica esperando a resposta
  const body = JSON.stringify({ hook_event_name: "PermissionRequest", session_id: "navp", tool_name: "Bash", tool_input: { command: "npm run deploy" } });
  const resposta = new Promise((ok) => {
    const r = require("http").request({ host: "127.0.0.1", port: require("./helpers").port(), path: "/claude", method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => ok(b)); });
    r.end(body);
  });
  // aparece mesmo com o painel minimizado
  await page.until(`!document.getElementById('pedidosBox').hidden && getComputedStyle(document.getElementById('pedidosBox')).display !== 'none'`);
  assert.strictEqual(await page.eval(`document.querySelector('#pedidosList span').textContent`), "Bash: npm run deploy");
  assert.strictEqual(await page.eval(`[...document.querySelectorAll('#pedidosList button')].map(b => b.dataset.decisao).join()`), "sim,nao");
  await print("pedido-permissao");
  await page.eval(`document.querySelector('#pedidosList button.sim').click()`);
  assert.strictEqual(JSON.parse(await resposta).hookSpecificOutput.decision.behavior, "allow");
  await page.until(`document.getElementById('pedidosBox').hidden`);
  await page.eval(`document.getElementById('bFora').click()`);
  await page.until(`!document.getElementById('bFora').classList.contains('on')`);
  assert.strictEqual(app.S.fora, false);
  app._setRemoto(null);
  app.handleClaude({ hook_event_name: "Stop", session_id: "navp" });
  await page.eval(`void localStorage.removeItem('escritorio.config')`);
  assert.deepStrictEqual(limpo(), []);
});

test("tela estreita: so a animacao; o HUD vai para uma gaveta embaixo que abre na seta", { skip }, async () => {
  await abrir();
  await page.until(`window.ESC && ESC.estado`);
  const ve = (id) => `(() => { const e = document.getElementById('${id}'), r = e.getBoundingClientRect(); return getComputedStyle(e).visibility === 'visible' && r.width > 0 && r.top < innerHeight && r.bottom > 0; })()`;
  // tela larga: tudo como antes, sem a seta
  assert.strictEqual(await page.eval(`getComputedStyle(document.getElementById('bGaveta')).display`), "none");
  assert.strictEqual(await page.eval(ve("botoes")) && await page.eval(ve("painel")), true);
  // o Chrome de teste nao avanca as transicoes de CSS: desliga para medir as posicoes finais
  await page.eval(`void document.head.appendChild(Object.assign(document.createElement('style'), { textContent: '* { transition: none !important }' }))`);
  await page.tamanho(700, 800);
  try {
    await page.until(ve("bGaveta"));
    for (const id of ["conexao", "chips", "botoes", "painel"]) assert.strictEqual(await page.eval(ve(id)), false, id + " aparece com a gaveta fechada");
    await page.eval(`document.getElementById('bGaveta').click()`);
    for (const id of ["conexao", "chips", "botoes", "painel"]) assert.strictEqual(await page.eval(ve(id)), true, id + " nao aparece com a gaveta aberta");
    assert.strictEqual(await page.eval(`document.getElementById('bGaveta').getAttribute('aria-expanded')`), "true");
    assert.match(await page.eval(`getComputedStyle(document.getElementById('bSound'), '::after').content`), /Som e avisos/);
    await print("gaveta-aberta");
    // tocar na cena fecha
    await page.eval(`document.getElementById('stage').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))`);
    await page.until(`!document.body.classList.contains('gaveta-aberta')`);
    // abrir a aparencia pela gaveta tambem fecha
    await page.eval(`document.getElementById('bGaveta').click()`);
    await page.eval(`document.getElementById('bLook').click()`);
    await page.until(`!document.body.classList.contains('gaveta-aberta')`);
  } finally { await page.tamanho(1280, 800); }
  assert.deepStrictEqual(limpo(), []);
});

// ---------- HUD: kanban, som (jukebox) e stream ----------
// Contrato: docs/CONTRATO-HUD-KANBAN-SOM-STREAM.md (secoes 4, 5 e 6.2).
// Se o backend ainda nao tiver as rotas, os testes aparecem como skip, nunca como falha do HUD.
let hudPronto = null;
async function temHud() {
  if (hudPronto !== null) return hudPronto;
  const [k, s, st] = await Promise.all([req("GET", "/kanban"), req("GET", "/som"), req("GET", "/stream")]);
  hudPronto = k.status === 200 && s.status === 200 && st.status === 200;
  return hudPronto;
}

const jsonDe = (r) => { try { return JSON.parse(r.body); } catch { return null; } };
const postar = (rota, corpo) => req("POST", rota, { "Content-Type": "application/json" }, JSON.stringify(corpo));
const semHud = (t) => t.skip("backend /kanban, /som ou /stream ainda ausente");

// o POST /stream chama push()? Sem isso o trecho novo nao chega pelo SSE e o teste de
// "ao vivo" nao pode passar por culpa do backend (contrato 4), nao do HUD.
let streamPush = null;
async function streamEmpurra() {
  if (streamPush !== null) return streamPush;
  const c = await sse();
  const id = "hudpush:" + Date.now();
  let buf = "";
  const chegou = new Promise((ok) => {
    const t = setTimeout(() => ok(false), 2500);
    c.on("data", (d) => { buf += d; if (buf.includes('"' + id + '"')) { clearTimeout(t); ok(true); } });
    c.on("error", () => { clearTimeout(t); ok(false); });
  });
  await postar("/stream", { slug: "hudpush", nome: "Hud Push", tag: "frontend", tipo: "reasoning", texto: "teste de push", id });
  streamPush = await chegou;
  c.destroy();
  return streamPush;
}

async function fecharCard(id) {
  await postar("/kanban", { acao: "fechar", id });
}

async function esvaziarSom() {
  for (let i = 0; i < 80; i++) {
    const s = jsonDe(await req("GET", "/som"));
    if (s && !s.atual && (!s.fila || !s.fila.length)) return;
    await postar("/som", { acao: "pular" });
  }
}

const colunaDe = (id) => `(() => { const c = document.querySelector('#kanban [data-id="${id}"]'); return c ? c.closest('.kanban-col').dataset.col : ''; })()`;

test("hud kanban: 4 colunas, card manual no snapshot sem recarregar e Esc fecha", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bKanban').click()`);
  await page.until(`!document.getElementById('kanban').hidden`);
  assert.deepStrictEqual(await page.eval(`[...document.querySelectorAll('#kanban .kanban-col')].map((c) => c.dataset.col)`), ["fila", "fazendo", "revisao", "feito"]);
  assert.strictEqual(await page.eval(`document.activeElement.className`), "fechar", "o foco vai para o botao de fechar");
  const r = await postar("/kanban", { acao: "add", slug: "casca", nome: "Casca", tag: "frontend", titulo: "card que chega no snapshot", col: "fila" });
  assert.strictEqual(r.status, 201);
  const card = jsonDe(r).card;
  await page.until(`!!document.querySelector('#kanban [data-id="${card.id}"]')`, 1500);
  assert.match(await page.eval(`document.querySelector('#kanban [data-id="${card.id}"]').textContent`), /card que chega no snapshot/);
  assert.strictEqual(await page.eval(colunaDe(card.id)), "fila");
  await page.eval(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await page.until(`document.getElementById('kanban').hidden`);
  assert.strictEqual(await page.eval(`document.activeElement.id`), "bKanban", "Esc devolve o foco ao botao");
  await fecharCard(card.id);
  assert.deepStrictEqual(limpo(), []);
});

test("hud kanban: card automatico vai para revisao no waiting e volta no working", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  const slug = "hudauto";
  await req("GET", `/sub?id=${slug}&name=Hud%20Auto&tag=frontend&text=primeira%20tarefa&kind=read&status=working`);
  await req("GET", `/sub?id=${slug}&name=Hud%20Auto&tag=frontend&status=waiting`);
  const noQuadro = jsonDe(await req("GET", `/kanban?slug=${slug}`));
  const automatico = noQuadro && noQuadro.cards.find((c) => c.id === `auto-${slug}`);
  if (!automatico || automatico.col !== "revisao") {
    await req("GET", `/sub?id=${slug}&status=done`);
    await req("GET", `/sub?id=${slug}&status=done`);
    await fecharCard(`auto-${slug}`);
    return t.skip("backend: /sub?status=waiting ainda nao move o card para revisao (contrato 1.4)");
  }
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bKanban').click()`);
  await page.until(`document.querySelector('#kanban [data-id="auto-${slug}"]')`);
  assert.strictEqual(await page.eval(colunaDe(`auto-${slug}`)), "revisao");
  await req("GET", `/sub?id=${slug}&name=Hud%20Auto&tag=frontend&text=voltei&kind=read&status=working`);
  await page.until(`document.querySelector('#kanban [data-id="auto-${slug}"]').closest('.kanban-col').dataset.col === 'fazendo'`);
  // agente ativo sem trecho: coluna do stream mostra "sem atividade"
  await page.eval(`document.getElementById('bStream').click()`);
  await page.until(`!document.getElementById('stream').hidden`);
  await page.until(`document.querySelector('#stream .stream-col[data-slug="${slug}"]')`);
  assert.match(await page.eval(`document.querySelector('#stream .stream-col[data-slug="${slug}"]').textContent`), /sem atividade/);
  await req("GET", `/sub?id=${slug}&status=done`);
  await req("GET", `/sub?id=${slug}&status=done`);
  await fecharCard(`auto-${slug}`);
  assert.deepStrictEqual(limpo(), []);
});

test("hud kanban: card add pelo CLI aparece no overlay em menos de 1 s", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  const fs = require("fs");
  const { execFile } = require("child_process");
  const cli = "C:/Users/Leonardo/OpenBot/Shared/mundo/mundo.js";
  if (!/cmd === "card"/.test(fs.readFileSync(cli, "utf8"))) return t.skip("mundo.js ainda sem os subcomandos card");
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bKanban').click()`);
  await page.until(`!document.getElementById('kanban').hidden`);
  // o servidor de teste escuta em 127.0.0.1; "localhost" pode cair no IPv6 e estourar o timeout do CLI
  const base = url.replace(/^http:\/\/localhost/, "http://127.0.0.1").replace(/\/$/, "");
  // execFile (nao spawnSync): o servidor de teste roda neste mesmo processo e precisa responder ao CLI
  const r = await new Promise((ok) => {
    execFile(process.execPath, [cli, "card", "add", "casca", "card criado pelo cli", "--col", "fila"], {
      env: { ...process.env, MUNDO_URL: base }, encoding: "utf8", timeout: 8000,
    }, (erro, stdout, stderr) => ok({ status: erro ? 1 : 0, stdout: stdout || "", stderr: stderr || String(erro || "") }));
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const id = (r.stdout.match(/card (k\d+)/) || [])[1];
  assert.ok(id, "o CLI imprime o id do card: " + r.stdout);
  await page.until(`!!document.querySelector('#kanban [data-id="${id}"]')`, 1000);
  await fecharCard(id);
  assert.deepStrictEqual(limpo(), []);
});

test("hud som: sem ligar nao tem iframe; ao ligar monta o embed e persiste o toggle", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  await esvaziarSom();
  const add = await postar("/som", { acao: "add", slug: "casca", nome: "Casca", tag: "frontend", url: "https://youtu.be/dQw4w9WgXcQ?t=30", titulo: "Video Um" });
  assert.strictEqual(add.status, 200);
  await abrir(`try { const c = JSON.parse(localStorage.getItem('escritorio.config') || '{}'); c.jukeboxSom = false; localStorage.setItem('escritorio.config', JSON.stringify(c)); } catch {}`);
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bJukebox').click()`);
  await page.until(`!document.getElementById('jukebox').hidden`);
  assert.strictEqual(await page.eval(`document.querySelectorAll('#jukebox iframe').length`), 0, "desligado nao injeta iframe");
  const texto = await page.eval(`document.getElementById('jukebox').textContent`);
  assert.match(texto, /Video Um/);
  assert.match(texto, /Casca/);
  assert.match(texto, /frontend/);
  assert.match(texto, /Fila \(0\)/);
  // controles de som sao do cliente e nao usam a chave antiga "som" dos avisos
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('escritorio.config') || '{}').som`), undefined);
  await page.eval(`document.getElementById('somLigar').click()`);
  await page.until(`!!document.querySelector('#jukebox iframe')`);
  assert.strictEqual(await page.eval(`document.querySelector('#jukebox iframe').getAttribute('src')`), "https://www.youtube.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0");
  assert.match(await page.eval(`document.querySelector('#jukebox iframe').getAttribute('allow')`), /autoplay/);
  assert.strictEqual(await page.eval(`document.querySelector('#jukebox iframe').title`), "Video Um");
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('escritorio.config')).jukeboxSom`), true);
  await page.eval(`document.getElementById('bJukebox').click()`);
  await page.eval(`document.getElementById('somLigar').click()`);
  assert.strictEqual(await page.eval(`document.querySelectorAll('#jukebox iframe').length`), 0, "desligar remove o iframe");
  assert.strictEqual(await page.eval(`JSON.parse(localStorage.getItem('escritorio.config')).jukeboxSom`), false);
  assert.deepStrictEqual(limpo(), []);
});

test("hud som: pular troca o src do iframe para a proxima musica", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  await esvaziarSom();
  await postar("/som", { acao: "add", slug: "casca", nome: "Casca", tag: "frontend", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", titulo: "Um" });
  await postar("/som", { acao: "add", slug: "prumo", nome: "Prumo", tag: "arquitetura", url: "https://www.youtube.com/shorts/9bZkp7q19f0", titulo: "Dois" });
  await abrir(`try { const c = JSON.parse(localStorage.getItem('escritorio.config') || '{}'); c.jukeboxSom = true; localStorage.setItem('escritorio.config', JSON.stringify(c)); } catch {}`);
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bJukebox').click()`);
  await page.until(`document.querySelector('#jukebox iframe') && document.querySelector('#jukebox iframe').getAttribute('src').includes('dQw4w9WgXcQ')`);
  const pular = await page.eval(`(() => { const b = [...document.querySelectorAll('#jukebox button')].find((x) => x.textContent === 'Pular'); b.click(); return b.textContent; })()`);
  assert.strictEqual(pular, "Pular");
  await page.until(`document.querySelector('#jukebox iframe').getAttribute('src').includes('9bZkp7q19f0')`);
  assert.match(await page.eval(`document.getElementById('jukebox').textContent`), /Prumo/);
  await page.eval(`document.getElementById('bJukebox').click()`);
  await esvaziarSom();
  assert.deepStrictEqual(limpo(), []);
});

test("hud stream: id repetido no snapshot nao duplica linha", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  await postar("/stream", { slug: "hud6", nome: "Hud Seis", tag: "frontend", tipo: "reasoning", texto: "primeira versao", id: "hud6:1" });
  await postar("/stream", { slug: "hud6", nome: "Hud Seis", tag: "frontend", tipo: "reasoning", texto: "segunda versao", id: "hud6:1" });
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bStream').click()`);
  await page.until(`!!document.querySelector('#stream [data-slug="hud6"][data-id="hud6:1"]')`);
  assert.strictEqual(await page.eval(`document.querySelectorAll('#stream [data-slug="hud6"][data-id="hud6:1"]').length`), 1);
  await page.until(`document.querySelector('#stream [data-slug="hud6"][data-id="hud6:1"]').textContent.includes('segunda versao')`);
  if (!(await streamEmpurra())) return t.skip("backend: POST /stream nao chama push(); o trecho novo nao chega pelo SSE (contrato 4)");
  await postar("/stream", { slug: "hud6", nome: "Hud Seis", tag: "frontend", tipo: "reasoning", texto: "terceira versao", id: "hud6:1" });
  await page.until(`document.querySelector('#stream [data-slug="hud6"][data-id="hud6:1"]').textContent.includes('terceira versao')`);
  assert.strictEqual(await page.eval(`document.querySelectorAll('#stream [data-slug="hud6"][data-id="hud6:1"]').length`), 1);
  assert.deepStrictEqual(limpo(), []);
});

test("hud stream: os 3 tipos tem classe e estilo distintos", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  await postar("/stream", { slug: "hud7", nome: "Hud Sete", tag: "arquitetura", tipo: "reasoning", texto: "pensando no schema", id: "hud7:1" });
  await postar("/stream", { slug: "hud7", nome: "Hud Sete", tag: "arquitetura", tipo: "tool", kind: "read", texto: "lendo server.js", res: "1961 linhas", id: "hud7:2" });
  await postar("/stream", { slug: "hud7", nome: "Hud Sete", tag: "arquitetura", tipo: "decision", texto: "implementei o kanban", id: "hud7:3" });
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bStream').click()`);
  await page.until(`document.querySelectorAll('#stream [data-slug="hud7"] .stream-trecho').length === 3`);
  const classes = await page.eval(`[...document.querySelectorAll('#stream [data-slug="hud7"] .stream-trecho')].map((li) => li.className)`);
  assert.match(classes[0], /stream-reasoning/);
  assert.match(classes[1], /stream-tool/);
  assert.match(classes[2], /stream-decision/);
  assert.strictEqual(new Set(classes).size, 3);
  assert.strictEqual(await page.eval(`getComputedStyle(document.querySelector('#stream [data-slug="hud7"] .stream-reasoning')).fontStyle`), "italic");
  assert.ok(Number(await page.eval(`getComputedStyle(document.querySelector('#stream [data-slug="hud7"] .stream-decision')).fontWeight`)) >= 600);
  assert.match(await page.eval(`document.querySelector('#stream [data-slug="hud7"] .stream-tool .stream-icone').title`), /read/);
  assert.deepStrictEqual(limpo(), []);
});

test("hud stream: auto-scroll pausa no hover e volta ao sair", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  if (!(await streamEmpurra())) return t.skip("backend: POST /stream nao chama push(); o teste precisa de trecho ao vivo (contrato 4)");
  for (let i = 1; i <= 30; i++) {
    await postar("/stream", { slug: "hud8", nome: "Hud Oito", tag: "frontend", tipo: "reasoning", texto: "linha " + i + " ".repeat(20), id: "hud8:" + i });
  }
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bStream').click()`);
  await page.until(`document.querySelectorAll('#stream [data-slug="hud8"] .stream-trecho').length === 30`);
  const col = `#stream .stream-col[data-slug="hud8"]`;
  const lista = `${col} .stream-lista`;
  assert.ok(await page.eval(`(() => { const l = document.querySelector('${lista}'); return l.scrollHeight > l.clientHeight + 40; })()`), "a coluna precisa rolar");
  await page.eval(`(() => { const l = document.querySelector('${lista}'); l.scrollTop = 0; document.querySelector('${col}').dispatchEvent(new MouseEvent('mouseenter')); })()`);
  await postar("/stream", { slug: "hud8", nome: "Hud Oito", tag: "frontend", tipo: "reasoning", texto: "linha nova com hover", id: "hud8:31" });
  await page.until(`document.querySelectorAll('#stream [data-slug="hud8"] .stream-trecho').length === 31`);
  assert.ok(await page.eval(`document.querySelector('${lista}').scrollTop`) < 10, "com o mouse na coluna o scroll nao desce");
  await page.eval(`document.querySelector('${col}').dispatchEvent(new MouseEvent('mouseleave'))`);
  await page.until(`(() => { const l = document.querySelector('${lista}'); return l.scrollTop >= l.scrollHeight - l.clientHeight - 4; })()`);
  assert.deepStrictEqual(limpo(), []);
});

test("hud stream: texto de agente com html aparece literal", { skip }, async (t) => {
  if (!(await temHud())) return semHud(t);
  const bruto = '<img src=x onerror=alert(1)> <b>nao e negrito</b>';
  await postar("/stream", { slug: "hud9", nome: "Hud Nove", tag: "frontend", tipo: "decision", texto: bruto, id: "hud9:1" });
  await abrir();
  await page.until(`ESC.pronto === true`, 15000);
  await page.eval(`document.getElementById('bStream').click()`);
  await page.until(`!!document.querySelector('#stream [data-slug="hud9"] [data-id="hud9:1"]')`);
  assert.strictEqual(await page.eval(`document.querySelector('#stream [data-slug="hud9"] [data-id="hud9:1"] .stream-texto').textContent`), bruto);
  assert.strictEqual(await page.eval(`document.querySelectorAll('#stream [data-slug="hud9"] .stream-texto img, #stream [data-slug="hud9"] .stream-texto b').length`), 0);
  assert.deepStrictEqual(limpo(), []);
});
