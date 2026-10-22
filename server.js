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

// Skeleton render: total escaping, no markdown rules yet.
function render(md) {
  return escapeHtml(md);
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
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return sendJson(res, 400, { error: 'invalid JSON' });
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
      });
    }

    return sendJson(res, 404, { error: 'not found' });
  } catch {
    // Unexpected failure must never crash the process mid-connection.
    return sendJson(res, 500, { error: 'internal error' });
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

module.exports = { createServer, escapeHtml, render };
