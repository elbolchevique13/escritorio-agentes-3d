# Contrato do HUD — Kanban, Som (jukebox) e Stream

Versão 1 · 2026-11-03 · dono: Prumo · fonte da verdade para Nervura (servidor + CLI) e Casca (HUD).

Base lida: `server.js` (S, DADOS, `gravarJson`/`lerJson`, `push()`, `snapshot()`, `route()`, `allowed()`, `readBody()`, `REMOTE_PATHS`, `handle()`, `handleClaude()`), `mundo.js`, `mundo-vivo.js`, `test/helpers.js`, `test/http.test.js`, `test/chat-tag.test.js`, `Shared/mundo/PROTOCOLO.md` (linhas 87–169) e `MUNDO.md`.

Este documento fecha tudo que os dois devs precisam. Nada de "a definir". Onde o protocolo estava ambíguo, a decisão está aqui e a linha do protocolo a corrigir está na seção 7.

Convenções que herdam do que já existe:

- Node puro, CommonJS, sem dependência nova.
- Estado único em `S`; o HUD só lê snapshot do `/events` (`data: {...}\n\n`, debounce de 120 ms em `push()`).
- Todo dado que sobrevive ao restart fica em `DADOS` (`process.env.ESCRITORIO_DADOS`, no container `/app/dados`), gravado por `gravarJson()` (tmp + `rename`) e lido por `lerJson()`.
- Toda rota passa por `allowed()` (só `localhost`/`127.0.0.1`, mesmo `Origin`, `Sec-Fetch-Site` local). Nada de header CORS novo.
- POST novo usa `readBody()` com o limite global de 10 MB.
- Resposta de erro nova em JSON: `{"erro":{"codigo":"...","mensagem":"..."}}`. `/set`, `/sub` e `/tag` continuam em texto puro (não mexer).

Escopo de nomes:

| Slug | Mora em | Tag |
| --- | --- | --- |
| `plan` | mesa | `auditor` |
| `build` | mesa | `construtor` |
| `leme`, `prumo`, `nervura`, `casca`, `teco`, … | pods/mesas do `agentes.tsv` | coluna `tag` do `agentes.tsv` |

---

# 1. Kanban

## 1.1 Card

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `id` | string | sim | card automático: `"auto-" + slug`; card manual: `"k" + n` (`k1`, `k2`, …). Único e estável enquanto o card existir. |
| `slug` | string | sim | `SLUG_OK` = `/^[a-z0-9][a-z0-9-]{0,31}$/` (o mesmo do `server.js`) |
| `nome` | string | sim | até 40 ch após `cut()`; vazio vira o próprio `slug` |
| `tag` | string | sim | `TAG_OK` = `/^[a-z0-9][a-z0-9-]{0,15}$/`; sem tag válida, `""` |
| `titulo` | string | sim | 1 a 80 ch após `cut()`; vazio → erro (card manual) ou não nasce card (auto) |
| `col` | string | sim | `"fila"` \| `"fazendo"` \| `"revisao"` \| `"feito"` |
| `auto` | boolean | sim | `true` = nasceu do estado real; `false` = criado por `mundo.js card add` |
| `t` | integer | sim | epoch em ms da criação; **não muda** quando o card anda de coluna |
| `hora` | string | sim | `HH:MM:SS` local, de `new Date(t).toTimeString().slice(0,8)` |

Exemplo real (card automático do Leme):

```json
{
  "id": "auto-leme",
  "slug": "leme",
  "nome": "Leme",
  "tag": "techlead",
  "titulo": "dividir o contrato do hud entre nervura e casca",
  "col": "fazendo",
  "auto": true,
  "t": 1793685127000,
  "hora": "02:52:07"
}
```

Exemplo real (card manual do mesmo quadro):

```json
{
  "id": "k7",
  "slug": "casca",
  "nome": "Casca",
  "tag": "frontend",
  "titulo": "overlay do kanban responsivo no celular",
  "col": "fila",
  "auto": false,
  "t": 1793685199000,
  "hora": "02:53:19"
}
```

## 1.2 GET /kanban

Query opcional:

| Param | Tipo | Padrão | Regra |
| --- | --- | --- | --- |
| `slug` | string | — | filtra por dono do card; fora de `SLUG_OK` → `400 SLUG_INVALIDO` |

Resposta `200`:

```json
{
  "cards": [
    { "id": "k7", "slug": "casca", "nome": "Casca", "tag": "frontend", "titulo": "overlay do kanban responsivo no celular", "col": "fila", "auto": false, "t": 1793685199000, "hora": "02:53:19" },
    { "id": "auto-leme", "slug": "leme", "nome": "Leme", "tag": "techlead", "titulo": "dividir o contrato do hud entre nervura e casca", "col": "fazendo", "auto": true, "t": 1793685127000, "hora": "02:52:07" }
  ]
}
```

- Ordem: `col` na sequência `fila`, `fazendo`, `revisao`, `feito`; dentro da coluna, `t` crescente (mais antigo primeiro).
- Quadro vazio: `200` com `{"cards":[]}`. Nunca `404`.
- `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-store`.

## 1.3 POST /kanban

Envelope único com `acao`. Justificativa em uma linha: uma rota = um ponto só de validação, de limite e de gravação atômica, e o `mundo.js` já conversa por GET/POST curtos, sem REST decorado para quatro operações de um mesmo recurso.

Corpo: `{"acao":"add"|"mover"|"fechar"|"limpar", ...campos da ação}`.

Resposta de sucesso de **toda** ação: `200` (ou `201` no `add`) com o mesmo envelope:

```json
{
  "card": { "id": "k7", "slug": "casca", "nome": "Casca", "tag": "frontend", "titulo": "overlay do kanban responsivo no celular", "col": "fila", "auto": false, "t": 1793685199000, "hora": "02:53:19" },
  "cards": [
    { "id": "k7", "slug": "casca", "nome": "Casca", "tag": "frontend", "titulo": "overlay do kanban responsivo no celular", "col": "fila", "auto": false, "t": 1793685199000, "hora": "02:53:19" },
    { "id": "auto-leme", "slug": "leme", "nome": "Leme", "tag": "techlead", "titulo": "dividir o contrato do hud entre nervura e casca", "col": "fazendo", "auto": true, "t": 1793685127000, "hora": "02:52:07" }
  ]
}
```

`card` é o card afetado; em `limpar` é `null`.

### add

```json
{ "acao": "add", "slug": "casca", "titulo": "overlay do kanban responsivo no celular", "col": "fila", "nome": "Casca", "tag": "frontend" }
```

| Campo | Obrigatório | Regra |
| --- | --- | --- |
| `slug` | sim | `SLUG_OK` |
| `titulo` | sim | 1–80 ch após `cut()` |
| `col` | não | padrão `fila`; se vier, uma das 4 |
| `nome` | não | até 40 ch; padrão = `slug` |
| `tag` | não | se vier, `TAG_OK`; padrão = `TAGS[slug]` ou `""` |

`auto: false`. `id` = próximo `k<n>` livre. Resposta `201`.

### mover

```json
{ "acao": "mover", "id": "k7", "col": "fazendo" }
```

`col` aceita **somente** as 4 colunas (não aceita `fechar`; fechar é ação própria). Card `auto` pode ser movido, e o próximo status real do agente sobrescreve `col` — o estado real manda. Resposta `200`.

### fechar

```json
{ "acao": "fechar", "id": "k7" }
```

Remove o card do quadro, `auto` inclusive. Resposta `200` com o quadro já sem o card. Se o morador continuar trabalhando depois do `fechar`, o próximo `working`/`passo` recria o card — mesma regra do `limpar`.

### limpar

```json
{ "acao": "limpar" }
```

Remove todos os cards de `col: "feito"` (automáticos inclusive). Cards em `fila`/`fazendo`/`revisao` ficam. Se o agente de um card automático removido continuar trabalhando, o próximo `passo`/`working` recria o card — o quadro reflete o estado real, não o histórico. Resposta `200` com `card: null`.

### Limites do quadro

| Limite | Regra |
| --- | --- |
| 200 cards no quadro | `add` recusa com `409 LIMITE_CARDS`; o quadro não muda |
| 20 cards em `feito` | ao entrar o 21º (por `mover`, `add` com `col: "feito"`, `done` ou `sair`), o card mais antigo de `feito` sai do quadro. FIFO, não é erro e não devolve código. |

### Erros

| HTTP | `codigo` | Quando |
| --- | --- | --- |
| 400 | `CORPO_INVALIDO` | corpo não é JSON ou `acao` ausente |
| 400 | `ACAO_INVALIDA` | `acao` fora de `add`/`mover`/`fechar`/`limpar` |
| 400 | `COLUNA_INVALIDA` | `col` fora das 4 colunas |
| 400 | `SLUG_INVALIDO` | `slug` fora de `SLUG_OK` |
| 400 | `TITULO_INVALIDO` | `titulo` ausente, não-string ou vazio após `cut()` |
| 400 | `TAG_INVALIDA` | `tag` presente e fora de `TAG_OK` |
| 400 | `ID_INVALIDO` | `id` ausente ou não-string |
| 404 | `CARD_NAO_ENCONTRADO` | `id` não existe no quadro |
| 409 | `LIMITE_CARDS` | `add` com 200 cards no quadro |

Exemplo de erro:

```json
{ "erro": { "codigo": "CARD_NAO_ENCONTRADO", "mensagem": "card k99 nao existe" } }
```

### Ordem de validação (determinística)

1. JSON válido e `acao` conhecida.
2. Campos da ação, na ordem da tabela da ação.
3. Existência do `id` (`mover`, `fechar`).
4. Limite de 200 (`add`).
5. Aplica, grava (debounce 400 ms) e responde.

## 1.4 Transições automáticas

Ponto único no servidor: uma função `kanbanEstado(slug, nome, tag, status, titulo, origem)` chamada de dois lugares, com `origem` = `"mesa"` ou `"sub"`:

- dentro de `setA()` (cobre `/set`, `/state`, eventos reais do opencode e `finish()`), `origem: "mesa"`, para `plan`/`build`;
- no handler `/sub`, depois de `touchChild`/`endChild`, `origem: "sub"`, para moradores e subagentes.

| Evento | `status` | Efeito no card |
| --- | --- | --- |
| `mundo.js entrar <slug> "<tarefa>"` (`/sub` com `task`) | `working` | cria `auto-<slug>` em `fazendo` se não existe; se existe, move para `fazendo` e atualiza `titulo`/`nome`/`tag` |
| `mundo.js passo <slug> "<texto>"` (`/sub` com `text`, sem `task`) | `working` | move para `fazendo`; **não** troca `titulo`; recria o card se ele foi fechado |
| `POST /set?agent=plan&status=working&text=...` | `working` | idem, com `slug` = `plan`/`build` |
| `status=waiting` (pedido de permissão) | `waiting` | move para `revisao`; cria o card se ainda não existe e há título real |
| `mundo.js sair` e `mundo-vivo` (`/sub?status=done`, `origem: "sub"`) | `done` | card em `fazendo`/`revisao` → `feito`; card **já** em `feito` → sai do quadro (arquivado) |
| `setA(..., "done")`: fim do turno de `plan`/`build` (`origem: "mesa"`) | `done` | move para `feito`; se já está em `feito`, fica |
| `status=idle`, `error` | — | nada muda no quadro |

Regra dura: **sem tarefa ou texto real, não nasce card**. `titulo` vazio depois de `cut()` não cria nada. Também não criam card os títulos genéricos `"trabalhando"` (padrão do `entrar` sem texto) e `"teste manual"` (padrão do `/set`).

`fechar` e `limpar` nunca são bloqueados por transição: o próximo `working`/`passo` com título real recria o card automático.

## 1.5 Persistência

Arquivo: `path.join(DADOS, "kanban.json")` (no container `/app/dados/kanban.json`, volume `mundo-dados`). Sem `DADOS`, o quadro vive só em memória (testes sem `ESCRITORIO_DADOS`).

```json
{
  "versao": 1,
  "cards": []
}
```

Card gravado tem exatamente os campos do GET.

- Gravação: `gravarJson()` (tmp + `rename`) com debounce de 400 ms, igual ao `chat.json`; função `_gravarKanban()` exportada para teste.
- Sem arquivo no boot: `{"versao":1,"cards":[]}`.
- Arquivo corrompido no boot: renomeia para `kanban.json.corrompido` (não apaga dado de ninguém), começa vazio e anota com `note()`. Nunca derruba o processo.
- `versao` diferente de `1`: carrega o que der (`cards` que passarem na validação campo a campo), sem migração automática.
- Sequência dos ids manuais no boot: `seq = maior n de id "k<n>" encontrado`, então o próximo `add` nunca colide.

---

# 2. Som (jukebox)

## 2.1 Item e estado

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `id` | string | sim | `"s" + n`, `s1`, `s2`, …; único no arquivo |
| `slug` | string | sim | `SLUG_OK` |
| `nome` | string | sim | até 40 ch |
| `tag` | string | sim | `TAG_OK` ou `""` |
| `vid` | string | sim | `^[A-Za-z0-9_-]{11}$` |
| `titulo` | string | sim | até 80 ch; pode ser `""` |
| `url` | string | sim | canônica, sempre `https://www.youtube.com/watch?v=<vid>` |
| `t` | integer | sim | epoch ms do pedido |
| `hora` | string | sim | `HH:MM:SS` local |

Estado: `{"atual": Item|null, "fila": [Item, ...]}`.

```json
{
  "atual": {
    "id": "s4", "slug": "forja", "nome": "Forja", "tag": "ia-local",
    "vid": "dQw4w9WgXcQ", "titulo": "Never Gonna Give You Up",
    "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "t": 1793685127000, "hora": "02:52:07"
  },
  "fila": [
    {
      "id": "s5", "slug": "casca", "nome": "Casca", "tag": "frontend",
      "vid": "9bZkp7q19f0", "titulo": "",
      "url": "https://www.youtube.com/watch?v=9bZkp7q19f0",
      "t": 1793685180000, "hora": "02:53:00"
    }
  ]
}
```

## 2.2 Regras de URL

Aceitar só `http`/`https` com estes dois padrões (regex exatas, caixa alta permitida no host):

```js
const YT = /^https?:\/\/(?:www\.|m\.|music\.)?youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/|live\/)([A-Za-z0-9_-]{11})(?:[?&#].*)?$/i;
const YT_BE = /^https?:\/\/youtu\.be\/([A-Za-z0-9_-]{11})(?:[?&#].*)?$/i;
```

- URL com espaços nas pontas: `trim()` antes.
- Parâmetros extras (`&list=`, `&t=90`, `&si=`, `?feature=share`) e fragmento: ignorados. Guarda-se só `vid` e a `url` canônica `https://www.youtube.com/watch?v=<vid>`.
- `youtube.com/watch` sem `v`, `youtube.com/@canal`, `youtu.be/<10 ou 12 ch>`, `vimeo.com`, `javascript:` → `400 URL_INVALIDA`.
- URL com mais de 2048 ch → `400 URL_INVALIDA`.
- Mesmo `vid` pode entrar de novo (repetir música é permitido); não há deduplicação.

## 2.3 GET /som

`200`, sem query:

```json
{
  "atual": { "id": "s4", "slug": "forja", "nome": "Forja", "tag": "ia-local", "vid": "dQw4w9WgXcQ", "titulo": "Never Gonna Give You Up", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "t": 1793685127000, "hora": "02:52:07" },
  "fila": [ { "id": "s5", "slug": "casca", "nome": "Casca", "tag": "frontend", "vid": "9bZkp7q19f0", "titulo": "", "url": "https://www.youtube.com/watch?v=9bZkp7q19f0", "t": 1793685180000, "hora": "02:53:00" } ]
}
```

Sem música: `{"atual":null,"fila":[]}`.

`Cache-Control: no-store`.

## 2.4 POST /som

Envelope `{"acao":"add"|"pular"|"limpar", ...}`. Toda ação responde `200` com o estado novo:

```json
{
  "atual": { "id": "s4", "slug": "forja", "nome": "Forja", "tag": "ia-local", "vid": "dQw4w9WgXcQ", "titulo": "Never Gonna Give You Up", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "t": 1793685127000, "hora": "02:52:07" },
  "fila": []
}
```

### add

```json
{ "acao": "add", "slug": "casca", "url": "https://youtu.be/dQw4w9WgXcQ?t=30", "titulo": "Never Gonna Give You Up", "nome": "Casca", "tag": "frontend" }
```

| Campo | Obrigatório | Regra |
| --- | --- | --- |
| `slug` | sim | `SLUG_OK` |
| `url` | sim | seção 2.2 |
| `titulo` | não | até 80 ch após `cut()`; padrão `""` |
| `nome` | não | até 40 ch; padrão = `slug` |
| `tag` | não | se vier, `TAG_OK`; padrão = `TAGS[slug]` ou `""` |

Regra de fila: se `atual` é `null`, o item vira `atual`; senão entra no fim de `fila`. Limite: `fila` com 50 itens; o 51º → `409 LIMITE_FILA`. `atual` não conta no limite.

### pular

```json
{ "acao": "pular" }
```

Descarta `atual`, promove `fila[0]` (ou `null` se vazia). Com fila vazia e `atual: null` responde `200` com o mesmo estado — idempotente, não é erro.

### limpar

```json
{ "acao": "limpar" }
```

Esvazia `fila` e **mantém** `atual` tocando. Para parar o que toca: `pular`.

### Erros

| HTTP | `codigo` | Quando |
| --- | --- | --- |
| 400 | `CORPO_INVALIDO` | JSON inválido ou `acao` ausente |
| 400 | `ACAO_INVALIDA` | `acao` fora de `add`/`pular`/`limpar` |
| 400 | `SLUG_INVALIDO` | `slug` fora de `SLUG_OK` |
| 400 | `URL_INVALIDA` | URL não casa com 2.2, ou `vid` fora de 11 ch |
| 400 | `TAG_INVALIDA` | `tag` presente e fora de `TAG_OK` |
| 409 | `LIMITE_FILA` | `add` com 50 itens já na fila |

Ordem de validação: JSON/`acao` → `slug` → `url` → `tag` → limite → aplica/grava.

## 2.5 Volume, play/pause e iframe (cliente)

- `volume`, `mudo` e "ligar som" são **do cliente**, em `localStorage` (`js/app/config.js`). O servidor não guarda nem expõe nada disso; não existe campo de volume em `som.json` nem no snapshot.
- Sem "ligar som", o HUD mostra `atual`, quem pediu e a fila, e **não** monta o `iframe`.
- Com som ligado, o HUD monta `https://www.youtube.com/embed/<vid>?autoplay=1&rel=0` num `iframe` (atributos `allow="autoplay; encrypted-media"`, `title` com o `titulo` ou o `vid`). Nada de `<script>` de API do YouTube, nada de download, nada de `innerHTML` com dado de agente.
- Trocar de música = trocar `src` do mesmo `iframe` (ou recriar o elemento).

## 2.6 Persistência

`path.join(DADOS, "som.json")`:

```json
{
  "versao": 1,
  "atual": null,
  "fila": []
}
```

No disco, `atual` e cada item da `fila` têm os campos de 2.1.

- Mesma escrita atômica, debounce 400 ms, `_gravarSom()` exportado para teste.
- Sem arquivo: `{"versao":1,"atual":null,"fila":[]}`.
- Corrompido: renomeia para `som.json.corrompido`, começa vazio, `note()`, processo segue.
- Boot com `atual` preenchido: o item volta como `atual` (a tela mostra; o áudio só toca se "ligar som" estiver ativo). A posição do vídeo não é salva.
- Sequência de `id` no boot: `seq = maior n de id "s<n>"`, próximo `add` usa `seq + 1`.

---

# 3. Stream de pensamento

## 3.1 Trecho

| Campo | Tipo | Obrigatório | Regra |
| --- | --- | --- | --- |
| `id` | string | sim | `^[A-Za-z0-9:._-]{1,64}$`; gerado pelo servidor (`<slug>:<n>`) se o cliente não mandar |
| `t` | integer | sim | epoch ms do último conteúdo |
| `hora` | string | sim | `HH:MM:SS` local |
| `slug` | string | sim | `SLUG_OK` |
| `nome` | string | sim | até 40 ch; padrão = `slug` |
| `tag` | string | sim | `TAG_OK` ou `""` |
| `tipo` | string | sim | `"reasoning"` \| `"tool"` \| `"decision"` |
| `kind` | string | sim | um de `think read edit bash search web wait skill`; em `decision` é sempre `think` |
| `texto` | string | sim | até 600 ch após `cut()`; nunca vazio |
| `res` | string | sim | até 600 ch após `cut()`; `""` quando não há resultado; sempre `""` em `reasoning` e em `decision` |

Os três tipos, e o que cada um significa na tela:

| `tipo` | Significado | Fonte | `kind` | `res` |
| --- | --- | --- | --- | --- |
| `reasoning` | raciocínio em andamento | opencode `part.type === "reasoning"`, `commentary` do OpenBot | `think` | `""` |
| `tool` | ação de ferramenta | opencode `part.type === "tool"`, hooks `PreToolUse`/`PostToolUse` | o real (`read`, `bash`, `edit`…) | resumo do resultado |
| `decision` | conclusão/anúncio do agente | `final_answer` do OpenBot (`mundo-vivo.js`) | `think` | `""` |

```json
{
  "id": "prumo:41",
  "t": 1793685127000,
  "hora": "02:52:07",
  "slug": "prumo",
  "nome": "Prumo",
  "tag": "arquitetura",
  "tipo": "reasoning",
  "kind": "think",
  "texto": "preciso ver o push() antes de fechar o contrato do kanban",
  "res": ""
}
```

```json
{
  "id": "prumo:42",
  "t": 1793685128000,
  "hora": "02:52:08",
  "slug": "prumo",
  "nome": "Prumo",
  "tag": "arquitetura",
  "tipo": "tool",
  "kind": "read",
  "texto": "lendo server.js",
  "res": "1961 linhas"
}
```

```json
{
  "id": "mv:turn_8812:417",
  "t": 1793685129000,
  "hora": "02:52:09",
  "slug": "prumo",
  "nome": "Prumo",
  "tag": "arquitetura",
  "tipo": "decision",
  "kind": "think",
  "texto": "implementei o kanban; falta o som e o stream",
  "res": ""
}
```

## 3.2 POST /stream

### reasoning

```json
{ "slug": "prumo", "tipo": "reasoning", "texto": "preciso ver o push() antes de fechar o contrato", "id": "prumo:41", "nome": "Prumo", "tag": "arquitetura" }
```

`kind` opcional; ausente → `think`. `res` é ignorado (forçado a `""`).

### tool

```json
{ "slug": "prumo", "tipo": "tool", "kind": "read", "texto": "lendo server.js", "res": "1961 linhas", "id": "prumo:42" }
```

`kind` obrigatório em `tool`. `res` opcional (`""`).

### decision

```json
{ "slug": "prumo", "tipo": "decision", "texto": "implementei o kanban; falta o som e o stream", "id": "mv:turn_8812:417", "nome": "Prumo", "tag": "arquitetura" }
```

`kind` ausente ou `"think"`; qualquer outro valor → `400 KIND_INVALIDO`. `res` é ignorado (forçado a `""`). `decision` é o único tipo que o HUD destaca como conclusão: é o anúncio do agente, o mesmo texto que vira balão e `final_answer`.

### Regras

- `slug` e `tipo` obrigatórios. `texto` obrigatório, mas **texto vazio após `trim()` não cria trecho e não é erro**: responde `200 {"ok":true,"ignorado":true}` (o streaming manda muito vazio/branco; não pode quebrar).
- Deduplicação/atualização por `id`: se o **último** trecho do `slug` tem o mesmo `id` e o mesmo `tipo`, atualiza `texto`, `res`, `t` e `hora` no lugar; não anexa. É o que faz um `tool` em streaming crescer em um único item. `id` que já saiu da janela entra como trecho novo.
- `id` do cliente fora do regex → `400 ID_INVALIDO`. Sem `id` → `<slug>:<n>` com `n` global crescente.
- Ring buffer: 200 trechos por `slug`; ao passar, descarta o mais antigo. Máximo de 40 `slug`s simultâneos; ao passar, descarta o `slug` com trecho mais antigo.
- Resposta de sucesso: `200 {"ok":true,"id":"prumo:42"}`. Não devolve o stream (evento é frequente; o cliente recebe pelo snapshot).

| HTTP | `codigo` | Quando |
| --- | --- | --- |
| 400 | `CORPO_INVALIDO` | JSON inválido, `slug`/`tipo`/`texto` ausentes ou não-string |
| 400 | `SLUG_INVALIDO` | `slug` fora de `SLUG_OK` |
| 400 | `TIPO_INVALIDO` | `tipo` fora de `reasoning`/`tool`/`decision` |
| 400 | `KIND_INVALIDO` | `kind` fora dos 8; ausente em `tool`; diferente de `think` em `decision` |
| 400 | `ID_INVALIDO` | `id` presente e fora do regex |

## 3.3 GET /stream

| Param | Tipo | Regra |
| --- | --- | --- |
| `slug` | string | opcional; fora de `SLUG_OK` → `400 SLUG_INVALIDO` |

```json
{
  "streams": {
    "prumo": [
      { "id": "prumo:41", "t": 1793685127000, "hora": "02:52:07", "slug": "prumo", "nome": "Prumo", "tag": "arquitetura", "tipo": "reasoning", "kind": "think", "texto": "preciso ver o push() antes de fechar o contrato", "res": "" },
      { "id": "prumo:42", "t": 1793685128000, "hora": "02:52:08", "slug": "prumo", "nome": "Prumo", "tag": "arquitetura", "tipo": "tool", "kind": "read", "texto": "lendo server.js", "res": "1961 linhas" }
    ]
  }
}
```

- Sem `slug`: todos os `slug`s com pelo menos um trecho.
- Com `slug` desconhecido: `200 {"streams":{"fantasma":[]}}`.
- Ordem: cronológica (mais antigo primeiro), máximo 200 por `slug`, texto completo (até 600 ch).
- `Cache-Control: no-store`.

## 3.4 Só memória

- Nada de `stream.json`, nada em `DADOS`, nada em `events.log`.
- Reinício do processo (ou do container): todas as colunas nascem vazias. O HUD mostra `"sem atividade"` até chegar trecho novo. Isso é intencional: raciocínio é efêmero e não deve vazar em disco.
- Estrutura: `STREAM = { seq: 0, porSlug: new Map() }` no `server.js`, com `_limparStream()` exportado para teste. Nunca entra em `snapshot()` inteiro (ver seção 4).

## 3.5 Fontes

### opencode (`handle()`, `message.part.updated`)

- `part.type === "reasoning"`: `POST`/chamada direta de `streamAdd({ slug: <agente: plan|build ou id do subagente>, tipo: "reasoning", kind: "think", texto: part.text || "pensando…", id: part.id })`.
- `part.type === "tool"`: `tipo: "tool"`, `kind` = o `kind` que `describe(part)` já devolve, `texto` = `describe(part)[0]`, `res` = resumo de `part.state`: `state.output` (texto, cortado em 600) ou `state.error` ou `"status: " + state.status` quando não há saída ainda; `id` = `part.id || part.callID`.
- Enquanto o `tool` não terminou, o mesmo `id` é reenviado e o trecho é atualizado (regra de dedupe).
- Subagente usa `child`/`childInfo` como dono do trecho: `slug` = id do subagente, `nome` = `childInfo.name`, `tag` = `TAGS[id] || ""`.
- opencode não produz `tipo: "decision"`: o anúncio real do turno vem do `final_answer` do OpenBot (abaixo) ou do texto de resposta que já vira balão.

### Claude Code (`handleClaude()`)

- `PreToolUse`: `tipo: "tool"`, `kind` = `ccDescribe(p.tool_name, p.tool_input)[1]`, `texto` = `ccDescribe(...)[0]`, `res: ""`, `id` = `p.tool_use_id`.
- `PostToolUse` / `PostToolUseFailure`: mesmo `id`, `res` = resumo de `p.tool_response` (string JSON cortada em 600; em falha, prefixo `"falhou: "`).
- `Notification`/`PermissionRequest` não geram trecho. Claude não gera `decision` (os hooks não dão o texto final).

### OpenBot (`mundo-vivo.js`, banco em somente leitura)

- `item_type === "commentary"` → `tipo: "reasoning"`, `kind: "think"`.
- `item_type === "final_answer"` → `tipo: "decision"`, `kind: "think"`, `res: ""`. É a conclusão do agente; o mesmo texto já vai no balão e no `/sub`.
- `id` determinístico pelo cursor de sequência: `"mv:" + turn_id + ":" + last_event_sequence` — o mesmo evento lido duas vezes atualiza o mesmo trecho, e a sequência crescente ordena.
- Uma `POST /stream` por trecho novo, depois do `POST /sub` já existente; falha de `/stream` não pode derrubar o laço (try/catch e segue).
- Continua proibido escrever no banco do OpenBot.

---

# 4. SSE

- **Não existe evento novo.** O frame continua `data: <snapshot JSON>\n\n`, com o mesmo debounce de 120 ms em `push()` e `: ping` a cada 20 s. O cliente não precisa de outro canal; `js/app/conexao.js` já entrega o snapshot inteiro para cada ouvinte.
- Ao conectar (`GET /events`), o servidor escreve um snapshot completo imediatamente; é o primeiro frame.
- Chaves novas em `snapshot()` (além de `tags`, `chat`, etc.):

| Chave | Conteúdo | Tamanho máximo |
| --- | --- | --- |
| `kanban` | `{ "cards": [...] }` (o quadro inteiro, mesmo formato do GET) | 200 cards |
| `som` | `{ "atual": Item\|null, "fila": [...] }` | 1 + 50 itens |
| `stream` | `{ "<slug>": [ até 5 trechos ] }` — janela do fim, com `texto` e `res` cortados em **240 ch** | 40 slugs × 5 |

- `GET /stream` (sem slice de 240) é a fonte do histórico completo quando o overlay abre; o snapshot só empurra o rabo da fila. Regra para o cliente: ao abrir o overlay, `GET /stream` uma vez; depois, para cada trecho do snapshot, ignora `id` já renderizado e anexa o resto.
- No HUD, `tipo` é classe própria e testável: `stream-reasoning` (itálico, cor suave), `stream-decision` (destaque de conclusão), `stream-tool` (ícone do `kind`). Texto sempre por `textContent`.
- `S.versao` continua mudando a cada boot (a página recarrega sozinha). `kanban` e `som` voltam do arquivo; `stream` volta vazio.
- Tamanho do frame: com o corte de 240 e a janela de 5, o pior caso do stream fica em ~48 KB; o quadro inteiro em ~30 KB. Não adicionar campo novo sem revisar esse teto.

---

# 5. CLI `mundo.js`

O parser atual (`args()`) já separa `--chave valor` em `op` e o resto em `resto`. Para `card` e `som`, `resto` é `[grupo, subcomando, ...argumentos]`.

## 5.1 Kanban

```
node C:\Users\Leonardo\OpenBot\Shared\mundo\mundo.js card add <slug> "<titulo>" [--col fila|fazendo|revisao|feito] [--nome "<nome>"] [--tag <tag>]
node C:\Users\Leonardo\OpenBot\Shared\mundo\mundo.js card mover <id> <fila|fazendo|revisao|feito|fechar>
node C:\Users\Leonardo\OpenBot\Shared\mundo\mundo.js card listar [--col <col>] [--slug <slug>]
```

Exemplos reais e saída esperada (stdout, uma linha, sem acento obrigatório):

```
> node mundo.js card add casca "overlay do kanban responsivo no celular" --col fila
card k7 fila "overlay do kanban responsivo no celular" (casca)

> node mundo.js card mover k7 fazendo
card k7 fazendo

> node mundo.js card listar
k7         fazendo   casca    frontend    overlay do kanban responsivo no celular
auto-leme  fazendo   leme     techlead    dividir o contrato do hud entre nervura e casca

> node mundo.js card mover k7 fechar
card k7 fechado

> node mundo.js card listar --col fila
nenhum card
```

- `card add`: valida `slug` no `agentes.tsv` com `achar()` (falha = código 2), `titulo` não vazio, `--col` conhecida, `--tag` no `TAG_OK`. `POST /kanban` e imprime `card <id> <col> "<titulo>" (<slug>)`.
- `card mover`: `fechar` vira `{"acao":"fechar"}`; as outras 4 viram `{"acao":"mover"}`. Imprime `card <id> <col>` ou `card <id> fechado`.
- `card listar`: `GET /kanban` (com `?slug=` quando houver `--slug`, com filtro de `--col` no cliente do CLI). Linha = `id.padEnd(10) + " " + col.padEnd(9) + " " + slug.padEnd(8) + " " + tag.padEnd(11) + " " + título até 60`. Vazio: `nenhum card`.
- Nada de `--kind` nessas ações.

## 5.2 Som

```
node C:\Users\Leonardo\OpenBot\Shared\mundo\mundo.js som add <slug> "<url do youtube>" [--titulo "<texto>"]
node C:\Users\Leonardo\OpenBot\Shared\mundo\mundo.js som pular
node C:\Users\Leonardo\OpenBot\Shared\mundo\mundo.js som limpar
node C:\Users\Leonardo\OpenBot\Shared\mundo\mundo.js som fila
```

```
> node mundo.js som add forja "https://youtu.be/dQw4w9WgXcQ?t=30" --titulo "Never Gonna Give You Up"
som dQw4w9WgXcQ tocando agora (forja)

> node mundo.js som add casca "https://www.youtube.com/watch?v=9bZkp7q19f0&list=RD"
som 9bZkp7q19f0 na fila (posicao 1)

> node mundo.js som fila
agora dQw4w9WgXcQ Never Gonna Give You Up (forja)
1. 9bZkp7q19f0 (casca)

> node mundo.js som pular
som dQw4w9WgXcQ -> 9bZkp7q19f0

> node mundo.js som pular
som 9bZkp7q19f0 -> nada

> node mundo.js som limpar
som fila limpa (0 itens)
```

- `som add`: valida `slug` no tsv e a URL **pelo mesmo regex do servidor** antes de chamar a rota (falha local = código 2). Se o servidor devolver 200, imprime `tocando agora` quando o `vid` virou `atual`, senão `na fila (posicao <n>)` — `n` é o índice 1-based dentro de `fila`.
- `som pular`: imprime `som <vid anterior> -> <vid novo>` ou `som <vid> -> nada`.
- `som limpar`: `som fila limpa (<n> itens)`.
- `som fila`: vazia (sem `atual` e sem `fila`) → `fila vazia`; só `atual` → uma linha `agora ...`; senão `agora` (se houver) e depois `n. <vid> <titulo> (<slug>)`, sem o título quando vazio.

## 5.3 Códigos de saída

| Situação | Código | stderr |
| --- | --- | --- |
| sucesso | 0 | — |
| uso errado, coluna/kind inválido, URL inválida, slug fora do `agentes.tsv` (validação local) | 2 | `mundo: <motivo>` |
| servidor responde 4xx/5xx (`404 CARD_NAO_ENCONTRADO`, `409 LIMITE_CARDS`, `409 LIMITE_FILA`, `400`) | 1 | `mundo: <status> <codigo>` |
| painel fora / timeout de 4 s | 1 | `mundo: <mensagem do fetch>` |

Hoje o `mundo.js` só usa 0/1; o 2 é a única convenção nova e está listada em 7.

---

# 6. Fronteira entre devs

## 6.1 Donos de arquivo

| Arquivo | Dono | Pode mudar | Não pode |
| --- | --- | --- | --- |
| `server.js` | Nervura | rotas `/kanban`, `/som`, `/stream`; `kanbanEstado()`, `streamAdd()`, `snapshot()` com as 3 chaves, hooks em `setA()` e `/sub`, `_gravarKanban`/`_gravarSom` | mudar nome/código de campo deste contrato; mexer em `handle()`/`handleClaude()` fora dos pontos de stream; `REMOTE_PATHS` (é do Atlas) |
| `mundo.js` | Nervura | subcomandos `card` e `som`; helper de URL | mudar `entrar`/`passo`/`sair`/`tag`/`quem`/`mundo`, nem o formato de saída deles |
| `mundo-vivo.js` | Nervura | `POST /stream` por `commentary`/`final_answer`, com `id` de cursor | escrever no banco do OpenBot; mudar a política de subida do painel |
| `js/app/hud.js` | Casca | botões/overlays Kanban, Som e Stream; `EventSource` continua em `conexao.js` | criar segundo `EventSource`; usar `innerHTML` com dado de agente; tocar áudio sem "ligar som" |
| `js/app/config.js` | Casca | `somLigado`, `volume`, filtros de stream (localStorage) | persistir estado de jogo no servidor |
| `index.html` | Casca | estrutura dos 3 overlays e dos botões | import map, ordem dos módulos, ids que o HUD já usa |
| `css/escritorio.css` | Casca | estilos dos overlays e do quadro | mexer em layout da cena 3D |
| `test/kanban.test.js`, `test/som.test.js`, `test/stream.test.js` | Nervura | novos | alterar `helpers.js` sem avisar Casca |
| `test/navegador.test.js` (bloco do HUD) | Casca | asserções novas do HUD | testes de servidor |
| `docs/CONTRATO-HUD-KANBAN-SOM-STREAM.md` | Prumo | correções de contrato | implementar |

## 6.2 Testes obrigatórios

Nervura (`node --test test/kanban.test.js test/som.test.js test/stream.test.js`):

1. `/sub?id=prumo&name=Prumo&text=x` cria `auto-prumo` em `fazendo`; chamar de novo não duplica (`cards.length` continua 1).
2. `/sub` sem `text` e sem `task` não cria card.
3. `/sub` `status=waiting` move `auto-<slug>` para `revisao`; `/sub?status=done` (sair) de `fazendo` move para `feito`; novo sair com o card já em `feito` remove do quadro; `POST /set?status=done` move para `feito` e não remove.
4. `/set?agent=plan&status=working&text=y` cria `auto-plan` com `tag: "auditor"`.
5. `card add` responde `201`, `auto: false` e `id`/`k1`; o card 201 → `409 LIMITE_CARDS`; `col: "feito"` com 20 lá dentro descarta o mais antigo.
6. `mover`/`fechar` com `id` inexistente → `404 CARD_NAO_ENCONTRADO`; `fechar` em `auto-leme` remove o card e, com `/sub` `working` de novo, ele volta.
7. `filesystem`: `_gravarKanban()` cria `kanban.json` em `DADOS`; subir com `kanban.json` inválido não derruba e gera `.corrompido`.
8. `som add` de `youtu.be/<vid>?t=30` grava `url` canônica `watch?v=<vid>`; `vimeo.com` e `youtube.com/@canal` → `400 URL_INVALIDA`.
9. Primeiro `som add` vira `atual`; 50 na fila ok, 51º → `409 LIMITE_FILA`; `pular` promove; `limpar` mantém `atual`.
10. `som` persiste: `_gravarSom()` cria `som.json`; reler o arquivo devolve `atual` e `fila` iguais.
11. `POST /stream` duas vezes com o mesmo `id` resulta em 1 trecho atualizado (não 2).
12. 201 `POST /stream` no mesmo `slug` mantém 200 (ring buffer) e o mais antigo sai.
13. `POST /stream` com `texto: "  "` → `200 {"ok":true,"ignorado":true}` e nenhum trecho criado.
14. `handle({type:"message.part.updated", properties:{part:{type:"reasoning", text:"pensando no schema", id:"r1", sessionID:"s1"}}})` cria trecho `tipo: "reasoning"` com o texto real.
15. Snapshot tem `kanban`, `som` e `stream`; o frame de `/events` começa com `data: ` e o quadro novo chega em até ~250 ms (debounce de 120 ms + folga).
16. `POST /kanban` com `Origin: https://site-malicioso.com` → `403` e quadro inalterado.
17. `limpar` remove só os cards de `feito` (inclusive automático) e deixa `fila`/`fazendo`/`revisao` intactos.
18. `GET /kanban?slug=leme` devolve só cards do Leme; `?slug=Prumo` → `400 SLUG_INVALIDO`.
19. `POST /stream` com `tipo: "decisao"` → `400 TIPO_INVALIDO`; com `tipo: "decision"` e `kind: "edit"` → `400 KIND_INVALIDO`; com `tipo: "decision"` sem `kind` → trecho salvo com `kind: "think"` e `res: ""`.
20. `mundo-vivo` (função de leitura exportada ou `streamAdd` chamado com o texto do banco): `final_answer` gera `tipo: "decision"` e `commentary` gera `tipo: "reasoning"`, os dois com `kind: "think"`.
21. `GET /stream?slug=prumo` devolve `tipo` de cada trecho preservado (`reasoning`, `tool`, `decision`).

Casca (`node --test test/navegador.test.js --test-name-pattern="hud"`):

1. Botão Kanban abre overlay com as 4 colunas; card que chega no snapshot aparece sem recarregar.
2. Card `auto` em `revisao` (agente `waiting`) aparece na coluna certa e volta para `fazendo` quando o agente volta a `working`.
3. `card add` pelo CLI aparece no overlay em menos de 1 s.
4. Sem "ligar som" não existe `iframe` no DOM e a fila aparece; depois de ligar, existe `iframe` com `src` `https://www.youtube.com/embed/<vid>?autoplay=1&rel=0`.
5. `pular` troca o `src` do `iframe` para o próximo `vid`.
6. Stream: trecho com `id` repetido no snapshot não duplica a linha.
7. Stream: os 3 tipos têm classe/estilo distintos — `reasoning` em itálico (`stream-reasoning`), `decision` destacado (`stream-decision`), `tool` com ícone do `kind` (`stream-tool`); um trecho de cada tipo renderizado em sequência tem `classList` diferente nos três.
8. Stream: auto-scroll pausa com o mouse sobre a coluna e volta ao sair.
9. Texto de agente com `<img src=x onerror=alert(1)>` aparece literal (nada de `innerHTML`).

---

# 7. Riscos e decisões

1. **SSE inteiro, sem evento por recurso.** O cliente já troca o estado todo a cada frame e não tem ordem nem reconexão por recurso; um canal só custa payload maior, então `stream` no snapshot é janela de 5 trechos cortados em 240 ch e `kanban`/`som` vão completos (pequenos). Histórico completo do stream só em `GET /stream`.
2. **Stream só em memória.** Gravar cada `reasoning` no volume encheria o disco em horas e guardaria raciocínio que não é para durar; restart perde as colunas e o HUD mostra `"sem atividade"`.
3. **Restart do container.** `kanban.json` e `som.json` voltam (inclusive `som.atual`, sem posição); stream nasce vazio; a página recarrega sozinha por `S.versao`.
4. **JSON em arquivo inteiro.** Sem índice nem query, cada mudança reescreve o arquivo todo com debounce de 400 ms: serve para 200 cards e 50 na fila; acima disso o custo de escrita e a latência do POST crescem e aí a decisão muda para SQLite.
5. **Protocolo**: o Atlas fechou duas regras que este documento já reflete — `sair` fecha/arquiva o card automático (de `fazendo`/`revisao` vai para `feito`; já em `feito`, sai do quadro), `fechar` vale para card automático, `feito` guarda 20, e `tipo: "decision"` existe para `final_answer`. Continuam 2 pontos para ele em `Shared/mundo/PROTOCOLO.md`: (a) §Por baixo lista `/kanban`, `/som`, `/stream` sem corpo, limites nem códigos de erro, e §Stream ainda descreve só `reasoning` e `tool` — faltam `decision` e o limite de 20 em `feito`, que este documento fecha (20 = FIFO, descarta o mais antigo, sem erro); (b) celular: `REMOTE_PATHS` precisa ganhar `GET /kanban`, `GET /som` e `GET /stream` para o HUD do celular ler, e os `POST` continuam bloqueados fora de `localhost`.

---

## Anexo — ordem de leitura para implementar

Nervura: 1 (kanban) → 1.5 (arquivo) → 2 (som) → 3 (stream, começando por `streamAdd` puro) → 4 (snapshot) → 5 (CLI) → testes de 6.2.
Casca: 4 (o que chega no snapshot) → 1.2/2.3/3.3 (GETs de abertura) → 6.1 → testes de 6.2.
