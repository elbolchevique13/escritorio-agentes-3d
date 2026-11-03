// Kanban do HUD: card automatico (setA e /sub), limite, FIFO de "feito" e arquivo.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { app, listen, close, req, port } = require("./helpers");

test.before(listen);
test.after(close);

const json = { "Content-Type": "application/json" };
const post = (p, corpo, headers = {}) => req("POST", p, { ...json, ...headers }, JSON.stringify(corpo));
const card = (id) => app.kanban().find((c) => c.id === id);
const cards = () => app.kanban();
const zerar = () => { app._limparKanban(); };

function semear(n, col = "fila", t0 = Date.now()) {
  for (let i = 0; i < n; i++) {
    app._kanban().cards.push({
      id: "seed-" + i, slug: "casca", nome: "Casca", tag: "frontend",
      titulo: "semente " + i, col, auto: false, t: t0 + i, hora: "00:00:00",
    });
  }
}

test("1. /sub com texto cria auto-prumo em fazendo e nao duplica", async () => {
  zerar();
  await req("GET", "/sub?id=prumo&name=Prumo&text=revisando%20o%20schema");
  const c = card("auto-prumo");
  assert.ok(c, "card auto-prumo nao nasceu");
  assert.strictEqual(c.col, "fazendo");
  assert.strictEqual(c.titulo, "revisando o schema");
  assert.strictEqual(c.auto, true);
  assert.strictEqual(cards().length, 1);
  await req("GET", "/sub?id=prumo&name=Prumo&text=revisando%20o%20schema");
  assert.strictEqual(cards().length, 1, "o mesmo morador virou dois cards");
});

test("2. /sub sem texto e sem task nao cria card", async () => {
  zerar();
  await req("GET", "/sub?id=visita&name=visita");
  assert.strictEqual(cards().length, 0, "card sem tarefa real");
  await req("GET", "/sub?id=visita&name=visita&text=trabalhando");
  assert.strictEqual(cards().length, 0, "'trabalhando' e titulo generico");
  await req("GET", "/set?agent=build&status=working");
  assert.strictEqual(cards().length, 0, "'teste manual' e titulo generico");
});

test("3. waiting -> revisao; sair de fazendo -> feito; sair de feito arquiva; setA(done) fica", async () => {
  zerar();
  await req("GET", "/sub?id=casca&name=Casca&task=overlay%20do%20kanban");
  assert.strictEqual(card("auto-casca").col, "fazendo");

  await req("GET", "/sub?id=casca&name=Casca&status=waiting");
  assert.strictEqual(card("auto-casca").col, "revisao", "waiting nao foi para revisao");

  await req("GET", "/sub?id=casca&name=Casca&text=voltando%20ao%20trabalho");
  assert.strictEqual(card("auto-casca").col, "fazendo", "passo nao voltou para fazendo");

  await req("GET", "/sub?id=casca&status=done");
  assert.strictEqual(card("auto-casca").col, "feito", "sair nao foi para feito");
  await req("GET", "/sub?id=casca&status=done");
  assert.strictEqual(card("auto-casca"), undefined, "segundo sair nao arquivou");

  // mesa: fim de turno move para feito e nao remove
  await req("GET", "/set?agent=plan&status=working&text=montando%20o%20contrato");
  assert.strictEqual(card("auto-plan").col, "fazendo");
  await req("GET", "/set?agent=plan&status=done");
  assert.strictEqual(card("auto-plan").col, "feito");
  await req("GET", "/set?agent=plan&status=done");
  assert.strictEqual(card("auto-plan")?.col, "feito", "fim de turno da mesa arquivou o card");
  await req("GET", "/set?agent=plan&status=idle");
});

test("4. /set working cria auto-plan com tag auditor", async () => {
  zerar();
  await req("GET", "/set?agent=plan&status=working&text=y");
  const c = card("auto-plan");
  assert.ok(c);
  assert.strictEqual(c.tag, "auditor");
  assert.strictEqual(c.col, "fazendo");
  await req("GET", "/set?agent=plan&status=idle");
});

test("5. card add: 201, auto false, k1; limite de 200; feito guarda 20 (FIFO)", async () => {
  zerar();
  let r = await post("/kanban", { acao: "add", slug: "casca", titulo: "overlay do kanban", col: "fila", tag: "frontend" });
  assert.strictEqual(r.status, 201);
  const c = JSON.parse(r.body).card;
  assert.strictEqual(c.id, "k1");
  assert.strictEqual(c.auto, false);
  assert.strictEqual(c.col, "fila");

  zerar();
  semear(200);
  r = await post("/kanban", { acao: "add", slug: "casca", titulo: "o card 201" });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(JSON.parse(r.body).erro.codigo, "LIMITE_CARDS");
  assert.strictEqual(cards().length, 200, "o quadro mudou num add recusado");

  zerar();
  const t0 = Date.now() - 100000;
  semear(20, "feito", t0);
  r = await post("/kanban", { acao: "add", slug: "casca", titulo: "o 21o de feito", col: "feito" });
  assert.strictEqual(r.status, 201);
  const feito = cards().filter((x) => x.col === "feito");
  assert.strictEqual(feito.length, 20, "feito passou de 20");
  assert.strictEqual(feito.find((x) => x.id === "seed-0"), undefined, "o mais antigo de feito nao saiu");
  assert.ok(feito.find((x) => x.id === "k1"), "o card novo nao entrou");
});

test("6. mover/fechar inexistente -> 404; fechar auto e recriado pelo working", async () => {
  zerar();
  for (const corpo of [{ acao: "mover", id: "k99", col: "fila" }, { acao: "fechar", id: "k99" }]) {
    const r = await post("/kanban", corpo);
    assert.strictEqual(r.status, 404, JSON.stringify(corpo));
    assert.strictEqual(JSON.parse(r.body).erro.codigo, "CARD_NAO_ENCONTRADO");
  }
  await req("GET", "/sub?id=leme&name=Leme&task=dividir%20o%20contrato");
  assert.ok(card("auto-leme"));
  let r = await post("/kanban", { acao: "fechar", id: "auto-leme" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(card("auto-leme"), undefined);
  await req("GET", "/sub?id=leme&name=Leme&text=dividindo%20de%20novo");
  assert.ok(card("auto-leme"), "o working nao recriou o card fechado");
});

test("7. arquivo: _gravarKanban grava em DADOS e arquivo invalido vira .corrompido no boot", async () => {
  zerar();
  await post("/kanban", { acao: "add", slug: "casca", titulo: "gravado no disco" });
  assert.strictEqual(app._gravarKanban(), true);
  const file = path.join(app._dados(), "kanban.json");
  assert.ok(fs.existsSync(file), "kanban.json nao foi criado");
  const salvo = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.strictEqual(salvo.versao, 1);
  assert.strictEqual(salvo.cards.length, 1);
  assert.strictEqual(salvo.cards[0].titulo, "gravado no disco");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "escritorio-kanban-"));
  fs.writeFileSync(path.join(dir, "kanban.json"), "{ isso nao e json");
  const script = `
    process.env.ESCRITORIO_JANELA = "0";
    const app = require(${JSON.stringify(path.join(__dirname, "..", "server.js"))});
    process.stdout.write(JSON.stringify(app.kanban()));
  `;
  const r = spawnSync(process.execPath, ["-e", script], {
    cwd: path.join(__dirname, ".."), encoding: "utf8",
    env: { ...process.env, ESCRITORIO_DADOS: dir, ESCRITORIO_JANELA: "0" },
  });
  assert.strictEqual(r.status, 0, "o boot morreu com kanban.json invalido: " + r.stderr);
  assert.strictEqual(r.stdout, "[]");
  assert.ok(fs.existsSync(path.join(dir, "kanban.json.corrompido")), "nao guardou o arquivo corrompido");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("16. POST /kanban de outro site -> 403 e quadro inalterado", async () => {
  zerar();
  await post("/kanban", { acao: "add", slug: "casca", titulo: "antes do ataque" });
  const r = await post("/kanban", { acao: "add", slug: "casca", titulo: "do site malicioso" }, { Origin: "https://site-malicioso.com" });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(cards().length, 1);
  assert.strictEqual(cards()[0].titulo, "antes do ataque");
});

test("17. limpar remove so os cards de feito", async () => {
  zerar();
  await post("/kanban", { acao: "add", slug: "casca", titulo: "na fila", col: "fila" });
  await post("/kanban", { acao: "add", slug: "casca", titulo: "fazendo", col: "fazendo" });
  await post("/kanban", { acao: "add", slug: "casca", titulo: "revisao", col: "revisao" });
  await post("/kanban", { acao: "add", slug: "casca", titulo: "ja feito", col: "feito" });
  await req("GET", "/sub?id=prumo&name=Prumo&task=um%20card%20automatico");
  await req("GET", "/sub?id=prumo&status=done"); // auto-prumo vai para feito
  assert.strictEqual(cards().filter((c) => c.col === "feito").length, 2);

  const r = await post("/kanban", { acao: "limpar" });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(JSON.parse(r.body).card, null);
  assert.deepStrictEqual(cards().map((c) => c.col).sort(), ["fazendo", "fila", "revisao"]);
});

test("18. GET /kanban?slug filtra e recusa slug invalido", async () => {
  zerar();
  await post("/kanban", { acao: "add", slug: "leme", titulo: "do leme" });
  await post("/kanban", { acao: "add", slug: "casca", titulo: "da casca" });
  const r = await req("GET", "/kanban?slug=leme");
  assert.strictEqual(r.status, 200);
  const lista = JSON.parse(r.body).cards;
  assert.strictEqual(lista.length, 1);
  assert.strictEqual(lista[0].slug, "leme");
  const bad = await req("GET", "/kanban?slug=Prumo");
  assert.strictEqual(bad.status, 400);
  assert.strictEqual(JSON.parse(bad.body).erro.codigo, "SLUG_INVALIDO");
});

test("kanban responde JSON com no-store", async () => {
  const r = await req("GET", "/kanban");
  assert.match(r.headers["content-type"], /application\/json/);
  assert.strictEqual(r.headers["cache-control"], "no-store");
  assert.strictEqual(port() > 0, true);
});