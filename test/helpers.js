// Utilitarios dos testes: sobe o servidor numa porta livre e faz requests "crus".
process.env.OPEN_BROWSER = "0";
// o chat e as tags gravam num diretorio temporario, nunca no repo
const os = require("os");
const fs = require("fs");
const path = require("path");
process.env.ESCRITORIO_DADOS = process.env.ESCRITORIO_DADOS || fs.mkdtempSync(path.join(os.tmpdir(), "escritorio-dados-"));
const net = require("net");
const app = require("../server.js");

// os testes nunca mexem na janela de verdade: os comandos ficam gravados em janelaCmds
const janelaCmds = [];
require("../janela").setRunner((cmd) => { janelaCmds.push(cmd); return Promise.resolve("ok"); });

let port = 0;
function listen() {
  if (port) return Promise.resolve(port);
  return new Promise((ok) => app.server.listen(0, "127.0.0.1", () => { port = app.server.address().port; ok(port); }));
}
function close() {
  return new Promise((ok) => { app.server.closeAllConnections(); app.server.close(() => ok()); });
}

// request HTTP escrito a mao, para poder mandar cabecalhos invalidos
// devolve { status, headers, body } ou { error }
function raw(lines, body = "") {
  return new Promise((ok) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(lines.join("\r\n") + "\r\n\r\n" + body));
    let data = "";
    c.setTimeout(1500, () => c.destroy());
    c.on("data", (d) => (data += d));
    c.on("error", (e) => ok({ error: e.code }));
    c.on("close", () => {
      if (!data) return ok({ error: "sem resposta" });
      const [head, ...rest] = data.split("\r\n\r\n");
      const [first, ...hs] = head.split("\r\n");
      const headers = {};
      for (const h of hs) { const i = h.indexOf(":"); headers[h.slice(0, i).toLowerCase()] = h.slice(i + 1).trim(); }
      ok({ status: Number(first.split(" ")[1]), headers, body: rest.join("\r\n\r\n") });
    });
  });
}
function req(method, path, headers = {}, body = "") {
  const h = { Host: `localhost:${port}`, Connection: "close", ...headers };
  if (body) h["Content-Length"] = Buffer.byteLength(body);
  return raw([`${method} ${path} HTTP/1.1`, ...Object.entries(h).map(([k, v]) => `${k}: ${v}`)], body);
}

const reset = () => { for (const w of ["plan", "build"]) app.setA(w, "idle"); };

// abre uma conexao /events e a deixa aberta (como uma aba do escritorio)
function sse() {
  return new Promise((ok) => {
    const c = net.connect(port, "127.0.0.1", () => c.write(`GET /events HTTP/1.1\r\nHost: localhost:${port}\r\n\r\n`));
    c.once("data", (d) => { if (!String(d).startsWith("HTTP/1.1 200")) throw new Error("SSE recusado: " + d); ok(c); });
  });
}

module.exports = { app, listen, close, raw, req, reset, sse, janelaCmds, port: () => port };
