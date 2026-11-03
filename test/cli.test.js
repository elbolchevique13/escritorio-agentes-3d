// CLI do mundo: subcomandos card e som contra o painel de verdade, com os codigos de saida do contrato.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { execFile } = require("child_process");
const { app, listen, close, port } = require("./helpers");

test.before(listen);
test.after(close);

const CLI = path.join(__dirname, "..", "..", "mundo", "mundo.js");
function cli(...args) {
  return new Promise((ok) => {
    execFile(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      timeout: 20000,
      env: { ...process.env, MUNDO_URL: `http://127.0.0.1:${port()}` },
    }, (err, stdout, stderr) => {
      ok({ code: err ? (err.code === undefined ? 1 : err.code) : 0, out: (stdout || "").trim(), err: (stderr || "").trim() });
    });
  });
}

test("5.1 card add, listar, mover e fechar com a saida do contrato", async () => {
  app._limparKanban();

  let r = await cli("card", "add", "casca", "overlay do kanban responsivo no celular", "--col", "fila");
  assert.strictEqual(r.code, 0, r.out + r.err);
  const m = /^card (k\d+) fila "overlay do kanban responsivo no celular" \(casca\)$/.exec(r.out);
  assert.ok(m, "saida inesperada: " + r.out);
  const id = m[1];

  r = await cli("card", "mover", id, "fazendo");
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `card ${id} fazendo`);

  r = await cli("card", "listar", "--col", "fazendo");
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `${id} fazendo casca overlay do kanban responsivo no celular`);

  r = await cli("card", "listar", "--col", "fila");
  assert.strictEqual(r.out, "nenhum card");

  r = await cli("card", "mover", id, "fechar");
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, `card ${id} fechado`);

  // o card saiu do quadro de verdade
  assert.strictEqual(app.kanban().length, 0);
});

test("5.1 --tag e --nome chegam no card e listar filtra por slug", async () => {
  app._limparKanban();
  let r = await cli("card", "add", "prumo", "modelo de dados", "--tag", "backend", "--nome", "Prumo");
  assert.strictEqual(r.code, 0, r.err);
  const id = /^card (k\d+)/.exec(r.out)[1];
  const c = app.kanban().find((x) => x.id === id);
  assert.strictEqual(c.tag, "backend");
  assert.strictEqual(c.nome, "Prumo");

  r = await cli("card", "add", "casca", "overlay", "--tag", "frontend");
  assert.strictEqual(r.code, 0, r.err);

  r = await cli("card", "listar", "--slug", "prumo");
  assert.strictEqual(r.out, `${id} fila prumo backend modelo de dados`);
});

test("5.3 validacao local sai com 2 e mundo: no stderr", async () => {
  const casos = [
    ["card", "add", "casca"],
    ["card", "add", "ninguem", "titulo"],
    ["card", "add", "casca", "titulo", "--col", "nada"],
    ["card", "mover", "k1", "nada"],
    ["som", "add", "forja", "https://vimeo.com/123456"],
    ["som", "add", "forja"],
    ["som", "add", "ninguem", "https://youtu.be/dQw4w9WgXcQ"],
  ];
  for (const args of casos) {
    const r = await cli(...args);
    assert.strictEqual(r.code, 2, args.join(" ") + " -> " + r.code);
    assert.match(r.err, /^mundo: /, args.join(" "));
  }
});

test("5.3 erro do servidor sai com 1 e o status no stderr", async () => {
  const r = await cli("card", "mover", "k999", "fila");
  assert.strictEqual(r.code, 1);
  assert.match(r.err, /404 CARD_NAO_ENCONTRADO/);
});

test("5.2 som add, fila, pular e limpar pela CLI", async () => {
  app._limparSom();

  let r = await cli("som", "add", "forja", "https://youtu.be/dQw4w9WgXcQ?t=30", "--titulo", "Never Gonna Give You Up");
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, "som dQw4w9WgXcQ tocando agora (forja)");
  assert.strictEqual(app.snapshot().som.atual.url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");

  r = await cli("som", "add", "casca", "https://www.youtube.com/watch?v=9bZkp7q19f0&list=RD");
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, "som 9bZkp7q19f0 na fila (posicao 1)");

  r = await cli("som", "fila");
  assert.strictEqual(r.code, 0, r.err);
  assert.strictEqual(r.out, "agora dQw4w9WgXcQ Never Gonna Give You Up (forja)\n1. 9bZkp7q19f0 (casca)");

  r = await cli("som", "pular");
  assert.strictEqual(r.out, "som dQw4w9WgXcQ -> 9bZkp7q19f0");

  r = await cli("som", "pular");
  assert.strictEqual(r.out, "som 9bZkp7q19f0 -> nada");

  r = await cli("som", "limpar");
  assert.strictEqual(r.out, "som fila limpa (0 itens)");

  r = await cli("som", "fila");
  assert.strictEqual(r.out, "fila vazia");
});