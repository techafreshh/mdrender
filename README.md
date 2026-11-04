# mdrender

> Render untrusted Markdown to inert HTML — one process, two endpoints, zero dependencies.

[![CI](https://github.com/techafreshh/mdrender/actions/workflows/ci.yml/badge.svg)](https://github.com/techafreshh/mdrender/actions/workflows/ci.yml)
![Node.js >=22](https://img.shields.io/badge/Node.js-%3E%3D22-3c873a?style=flat-square)

## What it is

`mdrender` is a small HTTP service that renders a deliberately narrow Markdown
subset to HTML and returns it as JSON from `POST /render`. Everything outside
that subset is HTML-escaped before any rule runs, so untrusted input can only
ever produce inert markup; the whole server is one file —
[`server.js`](./server.js) — built on `node:http`, with no runtime
dependencies, no filesystem access and no child processes.

## Why it exists

It is a testbed for pipelines that must handle untrusted Markdown, where the
security posture matters more than feature breadth. Its behaviour is pinned by
golden input→output pairs rather than prose, so the contract is checkable
instead of aspirational. [`PRD.md`](./PRD.md) is the authoritative statement of
the rendering rules and non-goals.

## Quickstart

Requirements: Node.js 22 or newer. Nothing else for the plain-Node path —
there is no `package.json` and no dependency install step. The optional
container path below also needs Docker with the Compose v2 plugin.

Get the code and start the server:

```bash
git clone https://github.com/techafreshh/mdrender.git
cd mdrender
node server.js
# mdrender listening on port 3000
```

Check that it is alive:

```bash
curl -s http://127.0.0.1:3000/health
# {"ok":true}
```

Render some Markdown:

```bash
curl -s -X POST http://127.0.0.1:3000/render \
  -H 'content-type: application/json' \
  -d '{"md":"# Hi\n\nVisit [our site](https://example.com) today, **please**."}'
# {"html":"<h1>Hi</h1><p>Visit <a href=\"https://example.com\">our site</a> today, <strong>please</strong>.</p>"}
```

Listen on another port with the `PORT` environment variable:

```bash
PORT=8080 node server.js
```

### Run in the worker container

`docker-compose.yml` runs the app in the repo's `worker` container
(`node:22-slim`, app on `PORT=3000`), reachable from the host at
`127.0.0.1:3000`:

```bash
docker compose up -d
curl -s http://127.0.0.1:3000/health
docker compose logs -f worker   # Ctrl+C to stop following
docker compose down
```

> [!NOTE]
> The container needs no `Dockerfile`: the stock `node:22-slim` image runs with
> the repo bind-mounted at `/app`. Compose also publishes `127.0.0.1:8108` and
> `127.0.0.1:8110` for the build factory's scenario handlers, so no other
> process may hold those host ports or `3000`.

## Usage

### Endpoints

| Method and path | Success | Body |
| --- | --- | --- |
| `GET /health` | `200` | `{"ok":true}` |
| `POST /render` with `{"md":"<markdown>"}` | `200` | `{"html":"<html>"}` |
| any other method + path | `404` | `{"error":"not found"}` |

The request `Content-Type` is not checked: the body is always parsed as JSON.

### Errors

Every failure is a JSON body, never a crash: the process survives any invalid
input and keeps serving. Responses always carry `Content-Type:
application/json` and are framed by `Content-Length` in a single write — never
chunked.

| Case | Status | Body |
| --- | --- | --- |
| Request body is not valid JSON | `400` | `{"error":"invalid JSON"}` |
| Body is valid JSON but not an object, or has no `md` | `400` | `{"error":"missing md"}` |
| `md` is not a string | `400` | `{"error":"md must be a string"}` |
| `md` is longer than 100,000 characters | `413` | `{"error":"payload too large"}` |
| Raw request body is over 1,000,000 bytes | `413` | `{"error":"payload too large"}` |

Exactly 100,000 characters of `md` is accepted; only *larger* input is
rejected.

### Supported syntax

Each row is a whole document: an inline-only input is still wrapped in `<p>`,
so the paragraph wrappers below are expected.

| Input | Output |
| --- | --- |
| `# H1` | `<h1>H1</h1>` |
| `## H2` | `<h2>H2</h2>` |
| `### H3` | `<h3>H3</h3>` |
| `**bold**` | `<p><strong>bold</strong></p>` |
| `*italic*` | `<p><em>italic</em></p>` |
| `` `code` `` | `<p><code>code</code></p>` |
| `[text](url)` | `<p><a href="url">text</a></p>` |
| `- one`, then `- two` on the next line | `<ul><li>one</li><li>two</li></ul>` |
| a line of exactly three backticks, `code`, another three-backtick line | `<pre><code>code</code></pre>` |
| `plain line` | `<p>plain line</p>` |

Blank lines separate blocks (except inside a fence); consecutive non-blank
lines of the same type are merged into one block (paragraph lines are joined by
`\n`, list items share one `<ul>`, fenced content stays verbatim). Headings
never merge.

> [!NOTE]
> Escaping runs first and everywhere: `&` → `&amp;`, `<` → `&lt;`, `>` →
> `&gt;`, `"` → `&quot;`, `'` → `&#39;`. Raw HTML is never passed through, and
> anything that looks like syntax but does not match a rule exactly comes out
> as escaped literal text.

CommonMark backslash escapes for ASCII punctuation are honoured in paragraphs,
headings and list items (never inside fenced code), and CRLF and lone CR are
treated as line breaks.

## Configuration

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `PORT` | `server.js` | `3000` | TCP port the process listens on |
| `E2E_BASE_URL` | `e2e.mjs` | `http://127.0.0.1:3000` | Base URL the delivery probe polls and replays against |

The renderer reads no other environment variables and writes no files.

## Limitations

- Headings are ATX levels 1–3 only: `####` and deeper render as paragraph
  text, as does a `#` without a following space.
- Flat, single-level lists only: `- ` must start at column 0; an indented `- `
  line is paragraph text. There are no ordered lists, nested lists, tables,
  images, blockquotes, setext headings, reference links, footnotes, task lists
  or strikethrough.
- No fence info strings: a fence is a line of exactly three backticks, so an
  opener with an info string (three backticks followed by `js`, say) stays
  paragraph text, and its own closing line then starts a fence of its own. An
  unterminated fence consumes the rest of the input as code-block content.
- No syntax highlighting, themes or formatting options.
- No sanitizer or allow-list mode: raw HTML is always escaped and there is no
  opt-out.
- Input `md` is capped at 100,000 characters per request; the raw request body
  is capped at 1,000,000 bytes.
- One process, one document per request: no streaming or chunked responses, no
  persistence, authentication, rate limiting, metrics or multi-tenancy.
- Environment variables are the only configuration surface — no config files,
  no CLI flags.
- No `package.json`, build step or `Dockerfile`; the worker runs the stock
  `node:22-slim` image.

## Architecture

```
server.js                 HTTP server and the renderer
e2e.mjs                   Delivery probe: poll /health, replay exact contract bodies
test/                     node:test suites (golden, block, inline, adversarial, server, readme)
docker-compose.yml        Worker container (node:22-slim, PORT=3000)
.github/workflows/ci.yml  CI: unit suite plus container delivery gate
PRD.md                    Authoritative render contract and non-goals
```

The render pipeline is one direction: `escapeHtml` → `parseBlocks` (headings,
lists, fences, paragraphs) → `renderContent` (whitespace collapse → inline
rules → backslash-escape stripping).

## Development

Run the test suite with the built-in runner (no dependencies, no install step):

```bash
node --test
```

Exercise the real container end to end — bring the worker up, then wait for
`/health` and replay the contract bytes:

```bash
docker compose up -d
node e2e.mjs            # wait for /health, then replay the contract
docker compose down
```

The probe modes are separate too: `node e2e.mjs wait` only polls `/health`,
`node e2e.mjs replay` only replays the contract, and
`E2E_BASE_URL=http://host:port node e2e.mjs replay` points it at another
instance.

`test/readme.test.js` keeps this document honest: it fails when a required
section disappears, when `server.js` or `e2e.mjs` starts reading an
undocumented environment variable, or when a documented command loses the file
that backs it.

CI runs the unit suite on Node 22, then a delivery job that starts the worker
container, waits for `/health`, replays the contract and runs the suite inside
the container. The project is built issue-by-issue by pi-dark-factory; every
change is verified black-box over HTTP before merge, and the verifier's probe
contract lives outside this repo by design.

## Documents

- [`PRD.md`](./PRD.md) — the authoritative render contract, golden examples and
  non-goals.
