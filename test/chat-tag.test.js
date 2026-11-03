// Chat (ring buffer, /chat, persistencia) e tags de funcao (/tag, /sub?tag).
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { app, listen, close, req } = require("./helpers");

test.before(listen);
test.after(close);

test("chat comeca como lista e recebe o texto do subagente", async () => {
  const antes = (await req("GET", "/chat?n=50")).body;
  assert.ok(Array.isArray(JSON.parse(antes)));
  const marca = "falando do chat " + Date.now();
  await req("GET", `/sub?id=leme&name=Leme&tag=techlead&text=${encodeURIComponent(marca)}&kind=read`);
  const lista = JSON.parse((await req("GET", "/chat?n=50")).body);
  const fala = lista.at(-1);
  assert.strictEqual(fala.texto, marca);
  assert.strictEqual(fala.slug, "leme");
  assert.strictEqual(fala.nome, "Leme");
  assert.strictEqual(fala.tag, "techlead");
  assert.strictEqual(fala.kind, "read");
  assert.match(fala.hora, /^\d\d:\d\d:\d\d$/);
  assert.strictEqual(typeof fala.id, "number");
});

test("texto vazio nao entra e o mesmo balao repetido nao duplica", async () => {
  const marca = "repetido " + Date.now();
  const contar = async () => JSON.parse((await req("GET", "/chat?n=200")).body).filter((x) => x.texto.startsWith(marca)).length;
  await req("GET", "/sub?id=casca&name=Casca&text=&kind=think");
  assert.strictEqual(await contar(), 0, "texto vazio virou fala");
  await req("GET", `/sub?id=casca&name=Casca&text=${encodeURIComponent(marca)}&kind=edit`);
  await req("GET", `/sub?id=casca&name=Casca&text=${encodeURIComponent(marca)}&kind=edit`);
  assert.strictEqual(await contar(), 1, "o mesmo balao entrou duas vezes");
  // outro morador falando no meio nao faz o mesmo balao do Casca entrar de novo
  await req("GET", "/sub?id=leme&name=Leme&text=outra%20fala%20no%20meio&kind=think");
  await req("GET", `/sub?id=casca&name=Casca&text=${encodeURIComponent(marca)}&kind=edit`);
  assert.strictEqual(await contar(), 1, "o mesmo balao do Casca voltou depois de outro morador falar");
  await req("GET", `/sub?id=casca&name=Casca&text=${encodeURIComponent(marca + " de novo")}&kind=edit`);
  assert.strictEqual(await contar(), 2, "um balao novo tem que entrar");
});

test("o chat guarda so os ultimos 200 e o /chat respeita o n", async () => {
  const antes = app.chat().length;
  for (let i = 0; i < 260; i++) app.fala("atlas", "Atlas", "think", `enchimento ${i}`);
  assert.strictEqual(app.chat().length, 200);
  assert.ok(app.chat().length <= 200 && antes >= 0);
  const uma = JSON.parse((await req("GET", "/chat?n=1")).body);
  assert.strictEqual(uma.length, 1);
  assert.strictEqual(uma[0].texto, "enchimento 259");
  const n = JSON.parse((await req("GET", "/chat?n=9999")).body);
  assert.ok(n.length <= 200, "n grande demais passou do limite");
  const zero = JSON.parse((await req("GET", "/chat?n=0")).body);
  assert.ok(zero.length >= 1, "n=0 deveria cair no padrao");
});

test("o chat persiste em chat.json no diretorio de dados", async () => {
  app.fala("prumo", "Prumo", "edit", "gravando o chat");
  assert.strictEqual(app._gravarChat(), true);
  const file = path.join(app._dados(), "chat.json");
  assert.ok(fs.existsSync(file), "chat.json nao foi criado");
  const salvo = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(Array.isArray(salvo) && salvo.length <= 200);
  assert.strictEqual(salvo.at(-1).texto, "gravando o chat");
  assert.strictEqual(salvo.at(-1).slug, "prumo");
});

test("tags: plan e build nascem preenchidos", () => {
  const t = app.tags();
  assert.strictEqual(t.plan, "auditor");
  assert.strictEqual(t.build, "construtor");
});

test("/tag grava e aparece no snapshot", async () => {
  assert.strictEqual((await req("GET", "/tag?id=nervura&tag=backend")).status, 200);
  assert.strictEqual(app.snapshot().tags.nervura, "backend");
  assert.strictEqual((await req("GET", "/tag?id=plan&tag=auditoria")).status, 200);
  assert.strictEqual(app.snapshot().tags.plan, "auditoria");
  await req("GET", "/tag?id=plan&tag=auditor"); // volta ao padrao para nao afetar outros testes
});

test("/tag recusa formato invalido", async () => {
  for (const tag of ["", "Backend", "dois lugares", "acentuação", "x".repeat(17), "-comeca"]) {
    const r = await req("GET", `/tag?id=leme&tag=${encodeURIComponent(tag)}`);
    assert.strictEqual(r.status, 400, JSON.stringify(tag));
  }
  for (const id of ["", "com espaço", "Maiusculo", "../x"]) {
    const r = await req("GET", `/tag?id=${encodeURIComponent(id)}&tag=backend`);
    assert.strictEqual(r.status, 400, JSON.stringify(id));
  }
});

test("a tag vai no /sub e sai na lista de subagentes", async () => {
  await req("GET", "/sub?id=forja&name=Forja&tag=ia-local&text=subindo%20ollama");
  const sub = app.snapshot().subs.find((x) => x.id === "forja");
  assert.ok(sub, "subagente nao apareceu no snapshot");
  assert.strictEqual(sub.tag, "ia-local");
  // tag invalida no /sub nao quebra o balao: o sub entra sem tag
  await req("GET", "/sub?id=visita&name=visita&tag=Maiuscula&text=teste");
  const v = app.snapshot().subs.find((x) => x.id === "visita");
  assert.strictEqual(v.tag, "");
  await req("GET", "/sub?id=forja&status=done");
  await req("GET", "/sub?id=visita&status=done");
});

test("/chat responde JSON e e negado para outro site", async () => {
  const r = await req("GET", "/chat?n=5");
  assert.strictEqual(r.status, 200);
  assert.match(r.headers["content-type"], /application\/json/);
  const evil = await req("GET", "/chat?n=5", { Origin: "https://site-malicioso.com" });
  assert.strictEqual(evil.status, 403);
});
