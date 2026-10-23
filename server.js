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

// Backslash escapes (CommonMark): a backslash before an ASCII punctuation
// character makes that character literal and is itself consumed. The PRD
// lists no backslash marker, so this is a content-level rule applied only
// when block content is emitted — never before classification (an escaped
// `\-`/`\#` must not conjure a list/heading at the line start) and never
// inside fences, whose content is verbatim by rule 7. It runs on the
// already-escaped text, so the five HTML-escapable characters arrive as
// whole entities and are passed through in that escaped form; every other
// escaped punctuation character is inert in HTML, so the output stays
// fully escaped. A backslash before anything else (letters, the newline
// joining paragraph lines, end of input) is not an escape and is kept.
const HTML_ENTITY_RE = /^&(?:amp|lt|gt|quot|#39);/;
const PUNCTUATION = '!#$%()*+,-./:;=?@[]\\^_`{|}~';

function stripBackslashEscapes(escaped) {
  let out = '';
  let i = 0;
  while (i < escaped.length) {
    if (escaped[i] === '\\' && i + 1 < escaped.length) {
      const entity = escaped.slice(i + 1).match(HTML_ENTITY_RE);
      if (entity) {
        out += entity[0];
        i += 1 + entity[0].length;
        continue;
      }
      if (PUNCTUATION.includes(escaped[i + 1])) {
        out += escaped[i + 1];
        i += 2;
        continue;
      }
    }
    out += escaped[i];
    i++;
  }
  return out;
}

// Whitespace normalization for emitted block content (CommonMark collapses
// runs of whitespace inside paragraphs, headings, and list items to one
// space; fences stay verbatim by rule 7). The class is every whitespace
// character except the joining `\n`: space/tab runs, but also NBSP, form
// feed, vertical tab, and the other Unicode whitespace — all must come out
// as one plain ASCII space, because on the wire JSON.stringify escapes
// control characters (`\f`, `\u000b`), leaving no whitespace for a consumer
// that matches marker + one space + text. It runs on the already-escaped
// text: the five HTML-escapable characters arrive as whole entities (`&amp;`
// `&lt;` `&gt;` `&quot;` `&#39;`) which contain no whitespace, so collapsing
// can never split or corrupt an entity. The newline joining paragraph lines
// is untouched — bullet 5 pins `\n` between merged lines.
function collapseWhitespace(escaped) {
  return escaped.replace(/[^\S\n]+/g, ' ');
}

// Prepass for the inline scanner: one linear walk records the position of
// every delimiter that a rule ever searches for after an opener — `*`
// (as singles and derived `**` pair-starts), `` ` ``, `]`, `)`. `[` needs no
// array: openers are met by the scan itself while walking. With positions
// recorded, each closer lookup during the scan is an advancing-cursor check
// instead of an indexOf from the current offset — a fresh indexOf per opener
// is quadratic (100,000 legal `[` with no `]` re-scans the whole tail every
// time) and would stall the single server process on a legal-size body.
function delimiterPositions(escaped) {
  const stars = [];
  const doubleStars = []; // start of a `**` run: a `*` whose successor is `*`
  const ticks = [];
  const closeBrackets = [];
  const closeParens = [];
  for (let i = 0; i < escaped.length; i++) {
    const c = escaped[i];
    if (c === '*') {
      stars.push(i);
      if (escaped[i + 1] === '*') doubleStars.push(i);
    } else if (c === '`') {
      ticks.push(i);
    } else if (c === ']') {
      closeBrackets.push(i);
    } else if (c === ')') {
      closeParens.push(i);
    }
  }
  return { stars, doubleStars, ticks, closeBrackets, closeParens };
}

// A monotone cursor over one delimiter-position array: returns the first
// recorded position strictly greater than i, or -1. The cursor index only
// moves forward — the scan index is monotonically increasing and every
// search wants a position after it, so a position once passed can never
// satisfy a later search either. Amortized O(1) per lookup, O(n) overall.
function cursorOver(positions) {
  let index = 0;
  return function nextAfter(i) {
    while (index < positions.length && positions[index] <= i) index++;
    return index < positions.length ? positions[index] : -1;
  };
}

// Inline rules over already-escaped block content (PRD rules 2-5), applied
// to paragraph, heading, and list-item text — never to fence content, which
// stays verbatim by rule 7. One flat left-to-right walk: at each position a
// backslash escape pair, a code span, bold, italic, or a link either matches
// and consumes through its close, or the single opener character is emitted
// verbatim and the scan advances one position. Matching is first-close-wins
// with no recursion into rule text: emphasis and link content is emitted
// as-is, so unconsumed markers inside degrade to literal text (rule 10),
// and the emitted tags are the only raw `<` in the result — an input `<`
// always arrived as `&lt;`, so no input can inject markup. Code-span
// content is copied verbatim: already escaped (stays inert), and no other
// inline rule runs inside it (rule 4 immunity is structural — the scan
// jumps past the close). A backslash before an entity or punctuation is
// copied together with the characters it covers, so an escaped marker
// (`\*`, `` \` ``, `\[`) can never open a rule — stripBackslashEscapes
// consumes the pair afterwards. Closer lookups ride monotone cursors over
// the delimiterPositions arrays, so the scan stays O(n) under the 100,000
// character cap even when it is full of unmatched openers.
function renderInline(escaped) {
  const pos = delimiterPositions(escaped);
  const afterTick = cursorOver(pos.ticks);
  const afterDoubleStar = cursorOver(pos.doubleStars);
  const afterStar = cursorOver(pos.stars);
  const afterCloseBracket = cursorOver(pos.closeBrackets);
  const afterCloseParen = cursorOver(pos.closeParens);
  let out = '';
  let i = 0;
  while (i < escaped.length) {
    if (escaped[i] === '\\') {
      // Copy exactly what stripBackslashEscapes will consume later: the
      // backslash plus its entity or plus one punctuation character. The
      // lookahead is bounded (the longest entity is 6 chars) so this stays
      // O(1) per backslash instead of copying the string tail.
      const entity = escaped.slice(i + 1, i + 7).match(HTML_ENTITY_RE);
      if (entity) {
        out += escaped.slice(i, i + 1 + entity[0].length);
        i += 1 + entity[0].length;
        continue;
      }
      if (i + 1 < escaped.length && PUNCTUATION.includes(escaped[i + 1])) {
        out += escaped.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += escaped[i];
      i++;
      continue;
    }
    if (escaped[i] === '`') {
      // Code span: content between the first closing backtick is
      // backtick-free by construction and must be non-empty (an adjacent
      // empty `` `` pair stays literal). No rule runs inside the span.
      const close = afterTick(i);
      const content = close !== -1 ? escaped.slice(i + 1, close) : '';
      if (content !== '') {
        out += `<code>${content}</code>`;
        i = close + 1;
        continue;
      }
    } else if (escaped[i] === '*') {
      if (escaped[i + 1] === '*') {
        // Bold: next `**` pair-start strictly after i+1, so the close can
        // never overlap the opener; empty content (`****`) stays literal.
        // Flanking: an opener followed by whitespace (or a closer preceded
        // by it) takes no part in emphasis — `** still **` falls through to
        // the one-char verbatim emit, so both stars stay inert text. A
        // rejected candidate degrades to escaped literal text, which is
        // always the safe direction.
        const close = afterDoubleStar(i + 1);
        const content = close !== -1 ? escaped.slice(i + 2, close) : '';
        if (content !== '' && !/^\s/.test(content) && !/\s$/.test(content)) {
          out += `<strong>${content}</strong>`;
          i = close + 2;
          continue;
        }
      } else {
        // Italic: next `*` after the opener. A failed bold emits one `*`,
        // so `**a` stays literal while `**a*` can still close as italic.
        // Flanking mirrors the bold rule: whitespace at either edge of the
        // matched content rejects the match (single-line or not), so
        // `* unmatched` can never open and stays escaped literal text. The
        // newline joining paragraph lines is not an edge: `x*y\nz*w` emits
        // `<em>y\nz</em>` — flanking is the only newline restriction.
        const close = afterStar(i);
        const content = close !== -1 ? escaped.slice(i + 1, close) : '';
        if (content !== '' && !/^\s/.test(content) && !/\s$/.test(content)) {
          out += `<em>${content}</em>`;
          i = close + 1;
          continue;
        }
      }
    } else if (escaped[i] === '[' && escaped[i - 1] !== '!') {
      // Link: `[` + non-empty text + `]` immediately followed by `(` +
      // non-empty whitespace-free URL up to the first `)`. The URL is
      // already escaped (`&amp;`, `&quot;`), so the href attribute cannot
      // be broken out of; any whitespace (including the joining `\n`)
      // rejects the match, so link titles and multiline URLs stay literal.
      // A `!` immediately before the opener makes this an image-bang
      // (`![alt](url)`) — images are unsupported (PRD rule 11), so the
      // whole run must stay literal; letting the inner `[text](url)` close
      // would leak a raw `<a href>` out of an inert construct. The guard is
      // exact: scan offsets track the input 1:1 (opener characters are
      // emitted verbatim, never consumed) and escapeHtml leaves `!`
      // untouched, so `escaped[i - 1]` is the input character before this
      // `[`. A backslash-escaped `\!` lands here too (the escape branch
      // copies `!` verbatim), so `\![a](b)` stays literal as well.
      const close = afterCloseBracket(i);
      if (close !== -1 && escaped[close + 1] === '(') {
        const text = escaped.slice(i + 1, close);
        const urlEnd = afterCloseParen(close + 1);
        const url = urlEnd !== -1 ? escaped.slice(close + 2, urlEnd) : '';
        if (text !== '' && url !== '' && !/\s/.test(url)) {
          out += `<a href="${url}">${text}</a>`;
          i = urlEnd + 1;
          continue;
        }
      }
    }
    // No rule matched at this position: the opener character is inert.
    out += escaped[i];
    i++;
  }
  return out;
}

// Content pipeline for every rule-carrying block (paragraph, heading, list
// item). The order is load-bearing:
// 1. collapseWhitespace first — rule and link text arrive collapsed; the
//    emitted tags contain no whitespace so collapsing before the inline
//    pass can never split one, and URL whitespace rejection sees the
//    collapsed reality (the joining `\n` survives collapse but still
//    counts as whitespace, so no URL spans lines).
// 2. renderInline second — markers are still verbatim and backslash pairs
//    intact, so escaped markers cannot open a rule.
// 3. stripBackslashEscapes last — the single escape-consumer; it only
//    consumes `\`+entity/punctuation pairs, so the emitted tags (which
//    contain no backslash) pass through untouched.
function renderContent(escaped) {
  return stripBackslashEscapes(renderInline(collapseWhitespace(escaped)));
}

// Fence marker: a line of exactly three backticks. Info strings (`​```js`)
// are not fences and pass through as escaped paragraph text.
const FENCE = '```';

// Block rules run over already-escaped text (PRD rule 10): none of the
// block markers (`#`, `- `, ```) contain escapable characters, so
// classification on escaped text is exact and `escapeHtml` stays the
// single escaping point. One pass over the lines: a blank line flushes
// the paragraph run; a heading line emits its own tag (headings never
// merge); consecutive `- ` lines accumulate into one `<ul>`; a fence line
// opens a run whose content is emitted verbatim (already escaped; no inline
// rules, no collapse — rule 7) to the closing fence or end of input —
// fence pairing outranks blank-line splitting, so a fenced block is always
// exactly one `<pre><code>`. Any other non-empty line joins the paragraph
// run, flushed as one `<p>` with its lines joined by `\n`; emitted content
// goes through renderContent (whitespace collapse, inline rules,
// backslash-escape stripping — see there for the stage order).
function parseBlocks(escaped) {
  const lines = escaped.split('\n');
  const out = [];
  let para = [];
  const flushPara = () => {
    if (para.length) {
      // The content pipeline runs after the join: a backslash at a line's
      // end sits before the joining newline (not punctuation) and survives
      // the inline pass verbatim and the strip as inert text.
      out.push(`<p>${renderContent(para.join('\n'))}</p>`);
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
      const content = renderContent(heading[2]);
      out.push(`<h${heading[1].length}>${content}</h${heading[1].length}>`);
      i++;
      continue;
    }
    if (line.startsWith('- ')) {
      flushPara();
      const items = [];
      while (i < lines.length && lines[i].startsWith('- ')) {
        items.push(`<li>${renderContent(lines[i].slice(2))}</li>`);
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

module.exports = { createServer, escapeHtml, parseBlocks, render, renderInline };
