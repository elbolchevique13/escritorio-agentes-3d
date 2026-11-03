// Som do HUD: URL do YouTube, fila de 50, "pular"/"limpar" e persistencia.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { app, listen, close, req } = require("./helpers");

test.before(listen);
test.after(close);

const json = { "Content-Type": "application/json" };
const post = (corpo) => req("POST", "/som", json, JSON.stringify(corpo));
const estado = async () => JSON.parse((await req("GET", "/som")).body);
const zerar = () => app._limparSom();
const add = (slug, url, extra = {}) => post({ acao: "add", slug, url, ...extra });
// 11 caracteres, o formato que o servidor aceita como vid
const vid = (n) => String(n).padStart(11, "0");
const VID = "dQw4w9WgXcQ";

test("8. youtu.be vira url canonica; vimeo e @canal -> 400 URL_INVALIDA", async () => {
  zerar();
  const r = await add("forja", `https://youtu.be/${VID}?t=30`);
  assert.strictEqual(r.status, 200);
  const st = JSON.parse(r.body);
  assert.strictEqual(st.atual.vid, VID);
  assert.strictEqual(st.atual.url, `https://www.youtube.com/watch?v=${VID}`);

  for (const url of ["https://vimeo.com/123456789", "https://www.youtube.com/@canal"]) {
    const bad = await add("forja", url);
    assert.strictEqual(bad.status, 400, url);
    assert.strictEqual(JSON.parse(bad.body).erro.codigo, "URL_INVALIDA", url);
  }
  // a recusa nao mexeu no estado
  assert.strictEqual((await estado()).fila.length, 0);
});

test("8b. shorts, embed, live e watch com lista sao aceitos", async () => {
  zerar();
  const urls = [
    "https://www.youtube.com/shorts/" + vid(1),
    "https://www.youtube.com/embed/" + vid(2),
    "https://www.youtube.com/live/" + vid(3),
    "https://www.youtube.com/watch?v=" + vid(4) + "&list=RD",
  ];
  const r = await add("casca", urls[0]);
  assert.strictEqual(r.status, 200);
  for (const u of urls.slice(1)) {
    const x = await add("casca", u);
    assert.strictEqual(x.status, 200, u);
  }
  assert.strictEqual((await estado()).fila.length, 3);
});

test("9. primeiro add vira atual; 50 na fila ok, 51o -> 409 LIMITE_FILA; pular promove; limpar mantem atual", async () => {
  zerar();
  let r = await add("forja", `https://www.youtube.com/watch?v=${VID}`);
  let st = JSON.parse(r.body);
  assert.strictEqual(st.atual.vid, VID, "o primeiro add nao virou atual");
  assert.strictEqual(st.fila.length, 0);

  for (let i = 1; i <= 50; i++) {
    r = await add("forja", `https://www.youtube.com/watch?v=${vid(i)}`);
    assert.strictEqual(r.status, 200, "add " + i);
  }
  st = await estado();
  assert.strictEqual(st.fila.length, 50);
  assert.strictEqual(st.atual.vid, VID);

  r = await add("forja", `https://www.youtube.com/watch?v=${vid(51)}`);
  assert.strictEqual(r.status, 409, "o 51o da fila passou");
  assert.strictEqual(JSON.parse(r.body).erro.codigo, "LIMITE_FILA");
  assert.strictEqual((await estado()).fila.length, 50, "o add recusado mudou a fila");

  r = await post({ acao: "pular" });
  assert.strictEqual(r.status, 200);
  st = JSON.parse(r.body);
  assert.strictEqual(st.atual.vid, vid(1), "pular nao promoveu o primeiro da fila");
  assert.strictEqual(st.fila.length, 49);

  r = await post({ acao: "limpar" });
  st = JSON.parse(r.body);
  assert.strictEqual(st.fila.length, 0, "limpar nao esvaziou a fila");
  assert.strictEqual(st.atual.vid, vid(1), "limpar derrubou o que estava tocando");
});

test("10. som persiste: _gravarSom cria som.json e o arquivo bate com GET /som", async () => {
  zerar();
  await add("forja", `https://youtu.be/${VID}?t=30`, { titulo: "Never Gonna Give You Up" });
  await add("casca", `https://www.youtube.com/watch?v=${vid(7)}`);

  assert.strictEqual(app._gravarSom(), true);
  const file = path.join(app._dados(), "som.json");
  assert.ok(fs.existsSync(file), "som.json nao foi criado");
  const salvo = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(salvo.versao, 1);

  const st = await estado();
  assert.deepStrictEqual(salvo.atual, st.atual);
  assert.deepStrictEqual(salvo.fila, st.fila);
  assert.strictEqual(salvo.fila[0].vid, vid(7));
});

test("som: slug invalido e acao invalida -> 400", async () => {
  const r = await add("Forja", `https://youtu.be/${VID}`);
  assert.strictEqual(r.status, 400);
  assert.strictEqual(JSON.parse(r.body).erro.codigo, "SLUG_INVALIDO");
  const a = await post({ acao: "tocar" });
  assert.strictEqual(a.status, 400);
  assert.strictEqual(JSON.parse(a.body).erro.codigo, "ACAO_INVALIDA");
});