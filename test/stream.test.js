// Stream do HUD: dedupe por id, ring buffer, tipos, hooks do opencode e leitura do mundo-vivo.
const test = require("node:test");
const assert = require("node:assert");
const net = require("net");
const path = require("path");
const { app, listen, close, req, port } = require("./helpers");

test.before(listen);
test.after(close);

const json = { "Content-Type": "application/json" };
const post = (corpo) => req("POST", "/stream", json, JSON.stringify(corpo));
const kanban = (corpo) => req("POST", "/kanban", json, JSON.stringify(corpo));
const trechos = async (slug) => JSON.parse((await req("GET", "/stream?slug=" + slug)).body).streams[slug];
const zerar = () => { app._limparStream(); app._limparKanban(); };

// abre /events e junta os frames: o helper sse() so confere o 200, aqui preciso do corpo
function eventos() {
  return new Promise((ok) => {
    const c = net.connect(port(), "127.0.0.1", () => c.write(`GET /events HTTP/1.1\r\nHost: localhost:${port()}\r\n\r\n`));
    const frames = [];
    let buf = "";
    let primeira = "";
    c.on("data", (d) => {
      buf += d;
      if (!primeira) {
        const sep = buf.indexOf("\r\n\r\n");
        if (sep < 0) return;
        primeira = buf.slice(0, sep);
        buf = buf.slice(sep + 4);
      }
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const f = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (f.startsWith("data: ")) frames.push(JSON.parse(f.slice(6)));
      }
      if (frames.length) ok({ c, frames, primeira });
    });
  });
}

async function esperar(fn, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return { valor: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > ms) return null;
    await new Promise((r) => setTimeout(r, 10));
  }
}

test("11. POST /stream com o mesmo id atualiza o trecho, nao duplica", async () => {
  zerar();
  let r = await post({ slug: "prumo", tipo: "reasoning", texto: "lendo o schema", id: "mv:t1:5" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).id, "mv:t1:5");

  r = await post({ slug: "prumo", tipo: "reasoning", texto: "lendo o schema atualizado", id: "mv:t1:5" });
  assert.strictEqual(r.status, 200);

  const lista = await trechos("prumo");
  assert.strictEqual(lista.length, 1, "o mesmo id virou dois trechos");
  assert.strictEqual(lista[0].texto, "lendo o schema atualizado");
});

test("12. 201 trechos no mesmo slug mantem 200 e o mais antigo sai", async () => {
  zerar();
  for (let i = 1; i <= 201; i++) {
    const r = await post({ slug: "prumo", tipo: "reasoning", texto: "trecho " + i, id: "mv:t1:" + i });
    assert.strictEqual(r.status, 200, "post " + i);
  }
  const lista = await trechos("prumo");
  assert.strictEqual(lista.length, 200, "o ring buffer nao parou em 200");
  assert.strictEqual(lista[0].texto, "trecho 2", "o mais antigo nao saiu");
  assert.strictEqual(lista[199].texto, "trecho 201");
});

test("13. texto em branco responde ignorado e nao cria trecho", async () => {
  zerar();
  const r = await post({ slug: "prumo", tipo: "reasoning", texto: "  " });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(JSON.parse(r.body), { ok: true, ignorado: true });
  assert.deepStrictEqual(await trechos("prumo"), []);
});

test("14. hook do opencode: reasoning cria trecho com o texto real da parte", async () => {
  zerar();
  app.handle({
    type: "message.part.updated",
    properties: { part: { type: "reasoning", text: "pensando no schema", id: "r1", sessionID: "s1" } },
  });
  const todos = [];
  for (const lista of Object.values(app.snapshot().stream)) todos.push(...lista);
  const t = todos.find((x) => x.texto === "pensando no schema");
  assert.ok(t, "o reasoning nao chegou no stream");
  assert.strictEqual(t.tipo, "reasoning");
  assert.strictEqual(t.kind, "think");
  assert.strictEqual(t.id, "r1");

  // tool: entra com o kind e o resumo da saida
  app.handle({
    type: "message.part.updated",
    properties: { part: { type: "tool", tool: "read", callID: "c1", state: { status: "completed", input: { filePath: "server.js" }, output: "ok" }, sessionID: "s1" } },
  });
  const todos2 = [];
  for (const lista of Object.values(app.snapshot().stream)) todos2.push(...lista);
  const tool = todos2.find((x) => x.id === "c1");
  assert.ok(tool, "a tool nao chegou no stream");
  assert.strictEqual(tool.tipo, "tool");
  assert.strictEqual(tool.kind, "read");
  assert.match(tool.texto, /server\.js/);
  assert.strictEqual(tool.res, "ok");
});

test("15. snapshot tem as 3 chaves e o quadro novo chega por /events em menos de 500 ms", async () => {
  zerar();
  const snap = app.snapshot();
  for (const k of ["kanban", "som", "stream"]) assert.ok(k in snap, "snapshot sem " + k);

  const { c, frames, primeira } = await eventos();
  try {
    assert.match(primeira, /^HTTP\/1\.1 200/);
    assert.ok(frames.length >= 1, "o primeiro frame nao chegou");
    assert.ok(frames[0].kanban, "o frame nao tem kanban");

    const t0 = Date.now();
    const r = await kanban({ acao: "add", slug: "casca", titulo: "chega pelo evento" });
    assert.strictEqual(r.status, 201);
    const achou = await esperar(() => frames.find((f) => (f.kanban && f.kanban.cards || []).some((x) => x.titulo === "chega pelo evento")), 2000);
    assert.ok(achou, "o frame com o card novo nao chegou");
    const ms = Date.now() - t0;
    assert.ok(ms < 500, "o quadro novo demorou " + ms + " ms (debounce de 120 ms + folga)");
  } finally {
    c.destroy();
  }
});

test("19. tipo/kind invalidos -> 400; decision sem kind vira think sem res", async () => {
  zerar();
  let r = await post({ slug: "prumo", tipo: "decisao", texto: "x" });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).erro.codigo, "TIPO_INVALIDO");

  r = await post({ slug: "prumo", tipo: "decision", kind: "edit", texto: "x" });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).erro.codigo, "KIND_INVALIDO");

  r = await post({ slug: "prumo", tipo: "decision", texto: "contrato fechado" });
  assert.strictEqual(r.status, 200);
  const lista = await trechos("prumo");
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].tipo, "decision");
  assert.strictEqual(lista[0].kind, "think");
  assert.strictEqual(lista[0].res, "");
});

test("20. mundo-vivo: final_answer vira decision e commentary vira reasoning, os dois think", () => {
  const { trechoDe } = require(path.join(__dirname, "..", "..", "mundo", "mundo-vivo.js"));
  const morador = { slug: "prumo", nome: "Prumo", tag: "arquitetura" };
  const dec = trechoDe({ turn_id: "t1", item_type: "final_answer", last_event_sequence: 9, text: "fechado o contrato do hud" }, morador);
  const rea = trechoDe({ turn_id: "t1", item_type: "commentary", last_event_sequence: 8, text: "conferindo o indice do banco" }, morador);

  assert.strictEqual(dec.tipo, "decision");
  assert.strictEqual(dec.kind, "think");
  assert.strictEqual(dec.slug, "prumo");
  assert.strictEqual(dec.id, "mv:t1:9");

  assert.strictEqual(rea.tipo, "reasoning");
  assert.strictEqual(rea.kind, "think");
  assert.strictEqual(rea.id, "mv:t1:8");

  // o cursor e por turno: a mesma leitura nao muda o id
  assert.strictEqual(dec.id, rea.id.replace(":8", ":9"));
});

test("21. GET /stream?slug preserva o tipo de cada trecho", async () => {
  zerar();
  await post({ slug: "prumo", tipo: "reasoning", texto: "pensando", id: "r1" });
  await post({ slug: "prumo", tipo: "tool", kind: "read", texto: "lendo server.js", res: "ok", id: "t1" });
  await post({ slug: "prumo", tipo: "decision", texto: "concluido", id: "d1" });

  const lista = await trechos("prumo");
  assert.deepStrictEqual(lista.map((x) => x.tipo), ["reasoning", "tool", "decision"]);
  assert.deepStrictEqual(lista.map((x) => x.id), ["r1", "t1", "d1"]);
  assert.strictEqual(lista[1].kind, "read");
  assert.strictEqual(lista[1].res, "ok");
});

test("21b. GET /stream sem slug devolve todas as colunas; slug invalido -> 400", async () => {
  zerar();
  await post({ slug: "prumo", tipo: "reasoning", texto: "a" });
  await post({ slug: "casca", tipo: "decision", texto: "b" });
  const all = JSON.parse((await req("GET", "/stream")).body).streams;
  assert.deepStrictEqual(Object.keys(all).sort(), ["casca", "prumo"]);
  const bad = await req("GET", "/stream?slug=Prumo");
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(JSON.parse(bad.body).erro.codigo, "SLUG_INVALIDO");
});