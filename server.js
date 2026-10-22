'use strict';

// Single plain-Node process, zero runtime dependencies: only node: builtins.
const http = require('node:http');

// Contract: POST /render rejects bodies with more than 100,000 characters of
// markdown ("larger than", so exactly 100,000 is legal).
const MAX_MD_CHARS = 100_000;
// Raw transport cap as a DoS guard. JSON string escaping expands one md
// character to at most 6 bytes (`\uXXXX`), so a body over 1,000,000 bytes
// must contain md > 100,000 chars — answering 413 for it is always correct.
const MAX_BODY_BYTES = 1_000_000;

// HTML-escape for the skeleton /render shell (PRD rule 10). Replacing `&`
// first guarantees the entities emitted below are never double-escaped.
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Heading marker: 1-3 '#' plus exactly one space; everything after the
// space is the heading content verbatim. `####`+ and `#` without a space
// are not headings and fall through to paragraph text.
const HEADING_RE = /^(#{1,3}) (.*)$/;
// Fence marker: a line of exactly three backticks. Info strings (`​```js`)
// are not fences and pass through as escaped paragraph text.
const FENCE = '```';

// Block rules run over already-escaped text (PRD rule 10): none of the
// block markers (`#`, `- `, ```) contain escapable characters, so
// classification on escaped text is exact and `escapeHtml` stays the
// single escaping point. One pass over the lines: a blank line flushes
// the paragraph run; a heading line emits its own tag (headings never
// merge); consecutive `- ` lines accumulate into one `<ul>`; a fence line
// opens a run whose content is emitted verbatim (already escaped) to the
// closing fence or end of input — fence pairing outranks blank-line
// splitting, so a fenced block is always exactly one `<pre><code>`. Any
// other non-empty line joins the paragraph run, flushed as one `<p>`
// with its lines joined by `\n`.
function parseBlocks(escaped) {
  const lines = escaped.split('\n');
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${para.join('\n')}</p>`);
      para = [];
    }
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      flushPara();
      i++;
      continue;
    }
    const heading = line.match(HEADING_RE);
    if (heading) {
      flushPara();
      out.push(`<h${heading[1].length}>${heading[2]}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (line.startsWith('- ')) {
      flushPara();
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(`<li>${lines[i].slice(2)}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }
    if (line === FENCE) {
      flushPara();
      let end = i + 1;
      while (end < lines.length && lines[end] !== FENCE) end++;
      out.push(`<pre><code>${lines.slice(i + 1, end).join('\n')}</code></pre>`);
      i = end < lines.length ? end + 1 : end;
      continue;
    }
    para.push(line);
    i++;
  }
  flushPara();
  return out.join('');
}

// Block pipeline: escape everything first (PRD rule 10), then apply the
// block rules over the escaped text. Line endings are normalized first:
// CR and CRLF are line boundaries exactly like LF (CommonMark), and a
// stray `\r` left inside a block would leak into the emitted HTML and
// corrupt exact-body output.
function render(md) {
  return parseBlocks(escapeHtml(md.replace(/\r\n?/g, '\n')));
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.setHeader('Content-Type', 'application/json');
  // Explicit length: the body always goes out framed by Content-Length in a
  // single write, never chunked — naive wire-level readers see it verbatim.
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.statusCode = status;
  res.end(body);
}

// Collect the request body with a size cap before any parsing. A single
// guard flag (`tooLarge`) ensures exactly one response is ever sent.
function collectBody(req, res, callback) {
  let chunks = [];
  let total = 0;
  let tooLarge = false;

  // A Content-Length above the cap short-circuits without reading the body.
  const contentLength = Number(req.headers['content-length']);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    return rejectTooLarge(req, res);
  }

  req.on('data', (chunk) => {
    if (tooLarge) return; // ignore data while rejecting; req is resumed
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      tooLarge = true;
      chunks = null;
      rejectTooLarge(req, res);
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) return; // response already sent
    callback(Buffer.concat(chunks).toString('utf8'));
  });
  req.on('error', () => {
    if (!tooLarge) {
      tooLarge = true; // request stream failed; nothing to respond to
      res.destroy();
    }
  });
}

// Respond 413 exactly once, then drain and close so the client's half of the
// connection can never trigger a second response (ECONNRESET / double-reply
// trap on oversized bodies).
function rejectTooLarge(req, res) {
  req.resume(); // drain the rest of the body
  res.setHeader('Connection', 'close');
  res.on('finish', () => req.destroy());
  sendJson(res, 413, { error: 'payload too large' });
}

function handleRequest(req, res) {
  try {
    const pathname = new URL(req.url, 'http://localhost').pathname;

    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/render') {
      return collectBody(req, res, (body) => {
        try {
          let parsed;
          try {
            parsed = JSON.parse(body);
          } catch {
            return sendJson(res, 400, { error: 'invalid JSON' });
          }
          // JSON `null` is a legal document that parses to null; the
          // hasOwnProperty check below would throw on it (ToObject(null)
          // throws) — and this callback runs outside handleRequest's
          // try/catch, so that throw would kill the process.
          if (parsed === null || typeof parsed !== 'object') {
            return sendJson(res, 400, { error: 'missing md' });
          }
          if (!Object.prototype.hasOwnProperty.call(parsed, 'md')) {
            return sendJson(res, 400, { error: 'missing md' });
          }
          if (typeof parsed.md !== 'string') {
            return sendJson(res, 400, { error: 'md must be a string' });
          }
          if (parsed.md.length > MAX_MD_CHARS) {
            return sendJson(res, 413, { error: 'payload too large' });
          }
          return sendJson(res, 200, { html: render(parsed.md) });
        } catch {
          // Last-ditch guard: a throw in this async callback would otherwise
          // be uncaught and crash the process — never let that happen.
          if (!res.headersSent) return sendJson(res, 500, { error: 'internal error' });
          res.destroy();
        }
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch {
    // Unexpected failure must never crash the process mid-connection.
    if (!res.headersSent) return sendJson(res, 500, { error: 'internal error' });
    res.destroy();
  }
}

// Exported for the test suite; each test binds its own instance on an
// ephemeral port. Listening happens only under the entrypoint below.
function createServer() {
  return http.createServer(handleRequest);
}

const server = createServer();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => {
    console.log(`mdrender listening on port ${port}`);
  });
}

module.exports = { createServer, escapeHtml, parseBlocks, render };
