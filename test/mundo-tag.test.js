// O verbo "tag" do mundo.js: grava o agentes.tsv de forma atomica e avisa o painel.
const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const child = require("child_process");
const { app, listen, close, port } = require("./helpers");

// o mundo vive ao lado do repo; no container ele nao existe e o teste e pulado
const CLI = path.join(__dirname, "..", "..", "mundo", "mundo.js");
const temCli = fs.existsSync(CLI);

test.before(listen);
test.after(close);

function copia() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mundo-tag-"));
  const tsv = path.join(dir, "agentes.tsv");
  fs.copyFileSync(path.join(__dirname, "..", "..", "mundo", "agentes.tsv"), tsv);
  return tsv;
}

// spawnSync bloquearia o event loop e o servidor (no mesmo processo) nao responderia ao /tag
function rodar(tsv, args) {
  return new Promise((ok) => {
    const p = child.spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, MUNDO_AGENTES: tsv, MUNDO_URL: `http://127.0.0.1:${port()}` },
    });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (status) => ok({ status, stdout: out, stderr: err }));
  });
}

const linhas = (tsv) => fs.readFileSync(tsv, "utf8").trim().split(/\r?\n/).map((l) => l.split("\t"));
const linha = (tsv, slug) => {
  const l = linhas(tsv);
  const cols = l[0];
  const v = l.find((x) => x[0] === slug);
  return Object.fromEntries(cols.map((c, i) => [c, v[i] || ""]));
};

test("tag grava a coluna certa e mantem as outras linhas", { skip: !temCli }, async () => {
  const tsv = copia();
  const original = fs.readFileSync(tsv, "utf8");
  const r = await rodar(tsv, ["tag", "nervura", "backend-novo"]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Nervura: backend-novo/);
  const l = linhas(tsv);
  assert.strictEqual(l[0].join("\t"), "slug\tnome\tcasa\tpapel\ttag\tlivre\tnao_faz");
  assert.strictEqual(linha(tsv, "nervura").tag, "backend-novo");
  assert.strictEqual(linha(tsv, "nervura").nome, "Nervura");
  assert.strictEqual(linha(tsv, "casca").tag, "frontend");
  // o resto do arquivo continua igual (mesmo numero de linhas e mesmo papel)
  assert.strictEqual(linhas(tsv).length, original.trim().split(/\r?\n/).length);
  assert.strictEqual(app.tags().nervura, "backend-novo", "o painel nao recebeu a tag");
});

test("tag tem uma por morador: gravar de novo troca, nao duplica", { skip: !temCli }, async () => {
  const tsv = copia();
  await rodar(tsv, ["tag", "atlas", "mundo"]);
  const r = await rodar(tsv, ["tag", "atlas", "design"]);
  assert.strictEqual(r.status, 0, r.stderr);
  const tags = linhas(tsv).filter((l) => l[0] === "atlas");
  assert.strictEqual(tags.length, 1);
  assert.strictEqual(linha(tsv, "atlas").tag, "design");
});

test("tag recusa valor invalido e morador desconhecido", { skip: !temCli }, async () => {
  const tsv = copia();
  const antes = fs.readFileSync(tsv, "utf8");
  for (const valor of ["Backend", "dois lugares", "x".repeat(17)]) {
    const r = await rodar(tsv, ["tag", "leme", valor]);
    assert.notStrictEqual(r.status, 0, `aceitou ${JSON.stringify(valor)}`);
    assert.match(r.stderr, /tag invalida/);
  }
  const r = await rodar(tsv, ["tag", "ninguem", "backend"]);
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /morador desconhecido/);
  assert.strictEqual(fs.readFileSync(tsv, "utf8"), antes, "o tsv mudou mesmo com erro");
});

test("quatro tags ao mesmo tempo nao perdem escrita", { skip: !temCli }, async () => {
  const tsv = copia();
  const alvos = [["leme", "lead"], ["prumo", "arquitetura"], ["nervura", "backend"], ["casca", "frontend"]];
  const rodadas = alvos.map(([slug, tag]) => new Promise((ok) => {
    const p = child.spawn(process.execPath, [CLI, "tag", slug, tag], {
      env: { ...process.env, MUNDO_AGENTES: tsv, MUNDO_URL: `http://127.0.0.1:${port()}` },
    });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => ok({ code, err, slug }));
  }));
  const rs = await Promise.all(rodadas);
  for (const r of rs) assert.strictEqual(r.code, 0, `${r.slug}: ${r.err}`);
  for (const [slug, tag] of alvos) assert.strictEqual(linha(tsv, slug).tag, tag, slug);
  assert.ok(!fs.existsSync(tsv + ".lock"), "a trava ficou para tras");
});
