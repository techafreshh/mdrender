# PRD — mdrender

## Background

We need a tiny, dependency-free HTML rendering endpoint to experiment with
untrusted-markdown pipelines. The service is a single Node process: it never
spawns anything, never touches the filesystem, and must be safe to expose on
a local network. Security posture matters more than feature breadth: any
input that is not part of the supported subset comes out inert (escaped),
never rendered.

## Product

`mdrender` is an HTTP service exposing `POST /render`.
Single file (`server.js`), plain `node:http`, no frameworks, no npm
dependencies. Starts with `node server.js`, listens on `PORT` from the
environment.

## Contract (machine-checked; review walks these line by line)

### Health
- `GET /health` → `200` with JSON body containing `"ok":true`.

### Render
- `POST /render` with JSON `{"md":"<markdown string>"}` → `200` with JSON
  `{"html":"<html string>"}`.
- Request body larger than 100,000 characters of markdown → `413` with JSON
  `{"error":"payload too large"}`. A malformed JSON body or a missing `md`
  field → `400` with JSON `{"error":"…"}` and a JSON error body. The process
  must always survive invalid input and keep serving.

### Supported subset (exact golden pairs — implement to match literally)

1. ATX headings:
   - In: `# Alpha` → Out: `<h1>Alpha</h1>`
   - In: `## Beta` → Out: `<h2>Beta</h2>`
   - In: `### Gamma` → Out: `<h3>Gamma</h3>`
   (Up to 3 levels; `####` and deeper is not a supported heading and renders
   as an escaped paragraph.)
2. Bold: `**text**` → `<strong>text</strong>`
3. Italic: `*text*` → `<em>text</em>`
4. Inline code: `` `code` `` → `<code>code</code>` — content inside backticks
   is escaped and no further inline rules apply inside it.
5. Links: `[text](url)` → `<a href="url">text</a>`
6. Unordered list: every line starting with `- ` (inside one block) becomes
   one `<ul>` of `<li>` items.
7. Fenced code block: ```-fenced lines become one `<pre><code>…</code></pre>`
   with the fence marks removed and the content escaped verbatim.
8. Paragraph: any other non-empty line is wrapped in `<p>…</p>`.
9. Blank lines separate blocks; consecutive non-blank lines of the same
   block type are merged into one block where the type allows it (lists,
   fenced code, paragraphs).
10. **Escaping rule (applies everywhere):** raw text is HTML-escaped before
    any rule sees or emits it: `&` → `&amp;`, `<` → `&lt;`, `>` → `&gt;`,
    `"` → `&quot;`, `'` → `&#39;`. Supported syntax markers (`#`, `**`,
    `` ` ``, `[`, `]`, `(`, `)`, `- ` at line start, fences) are consumed by
    their rule; anything that looks like syntax but does not match a rule
    exactly is passed through as escaped text.
11. All other Markdown constructs (tables, images, blockquotes, nested
    lists, setext headings, references) are NOT supported — their literal
    characters flow through as escaped text.

### Examples (golden)
- In: `# Hi\n\nVisit [our site](https://example.com) today, **please**.`
  Out: `<h1>Hi</h1><p>Visit <a href="https://example.com">our site</a> today, <strong>please</strong>.</p>`
- In: `Use \`npm test\`.\n\n<script>alert(1)</script>`
  Out: `<p>Use <code>npm test</code>.</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>`

## Delivery requirements (part of the contract, not optional)

1. **First issue ships the CI workflow**: `.github/workflows/ci.yml` running
   `node --test` on `pull_request` and `push` to the default branch, on Node
   ≥ 22 (e.g. `actions/setup-node` `node-version: 22`). The repo keeps a
   real test suite under `test/` (built-in `node:test`) covering the
   contract's golden pairs.
2. **First issue ships the container**: `docker-compose.yml` at the repo
   root with a service named exactly `worker`, image with Node.js ≥ 22
   preinstalled (e.g. `node:22-slim` or similar), publishing the scenario
   port on `127.0.0.1`. All stages of the factory run inside this worker.
3. Both of the above are ordinary issue deliverables — the reviewing layer
   treats a missing or non-functional CI/compose file the same as a missing
   feature.

## Non-goals

Tables, images, blockquotes, nested lists, task lists, reference links,
footnotes, syntax highlighting, themes, HTML sanitization policy beyond
total escaping, streaming/chunked responses, multi-document rendering.

## Out of scope for this product

Persistence, authentication, rate limiting, multi-tenancy, metrics. This is
a stateless renderer.

## Suggested build order (advisory — the slicer decides)

Skeleton (health + compose + CI + `/render` shell with full escaping) →
block parsing (headings/paragraphs/fences/lists) → inline rules (bold/
italic/code/links) → golden-parity audit incl. adversarial escaping.
