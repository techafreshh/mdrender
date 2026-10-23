'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createServer, escapeHtml, render, renderInline } = require('../server');

// Track every instance so test.after can close them all — no leaked handles.
const servers = new Set();
async function startServer() {
  const server = createServer();
  servers.add(server);
  await new Promise((resolve) => server.listen(0, resolve));
  return server;
}

test.after(() =>
  Promise.all([...servers].map((server) => new Promise((resolve) => server.close(resolve))))
);

// Minimal node:http client; resolves {status, headers, rawBody} once the
// full response body has been consumed.
function request(server, path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body !== null ? { 'Content-Length': Buffer.byteLength(body) } : {};
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawBody: Buffer.concat(chunks).toString('utf8'),
          })
        );
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

// PRD golden example 1: heading, link, and bold across blocks in one
// document — the canonical end-to-end shape of the inline rules.
test('PRD golden example: heading, link, and bold render across blocks', () => {
  assert.equal(
    render('# Hi\n\nVisit [our site](https://example.com) today, **please**.'),
    '<h1>Hi</h1><p>Visit <a href="https://example.com">our site</a> today, <strong>please</strong>.</p>'
  );
});

// PRD golden example 2: inline code in a paragraph next to a fully escaped
// HTML paragraph — escaping and inline code must compose unchanged.
test('PRD golden example: inline code beside escaped HTML', () => {
  assert.equal(
    render('Use `npm test`.\n\n<script>alert(1)</script>'),
    '<p>Use <code>npm test</code>.</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
  );
});

test('bold and italic render inside paragraph text', () => {
  assert.equal(
    render('**bold** and *ital* text'),
    '<p><strong>bold</strong> and <em>ital</em> text</p>'
  );
  // Two sibling pairs in one paragraph: each opener takes its own first close.
  assert.equal(render('**a** and **b**'), '<p><strong>a</strong> and <strong>b</strong></p>');
  // Intraword emphasis matches CommonMark treatment of `*`.
  assert.equal(render('a*b*c'), '<p>a<em>b</em>c</p>');
});

test('inline code content is escaped and immune to every other inline rule', () => {
  assert.equal(
    render('Use `npm test` with `<b>` inside'),
    '<p>Use <code>npm test</code> with <code>&lt;b&gt;</code> inside</p>'
  );
  // Markers inside the span surface as literal text, never as tags.
  assert.equal(render('`a *b* [c](d) **e**`'), '<p><code>a *b* [c](d) **e**</code></p>');
});

test('links render with an href; escapable URL characters stay escaped', () => {
  assert.equal(
    render('Visit [our site](https://example.com) today'),
    '<p>Visit <a href="https://example.com">our site</a> today</p>'
  );
  // `&` and `"` were escaped before the inline pass, so the href attribute
  // carries entities and the attribute quoting can never be broken.
  assert.equal(
    render('[a](https://x.test/?a=1&b=2)'),
    '<p><a href="https://x.test/?a=1&amp;b=2">a</a></p>'
  );
  assert.equal(render('[a](u"v)'), '<p><a href="u&quot;v">a</a></p>');
});

test('inline rules apply in headings and list items, never in fences', () => {
  assert.equal(
    render('# A **titled** [link](https://x.test)'),
    '<h1>A <strong>titled</strong> <a href="https://x.test">link</a></h1>'
  );
  assert.equal(
    render('- **b** x and [l](u)'),
    '<ul><li><strong>b</strong> x and <a href="u">l</a></li></ul>'
  );
  // Fence content stays verbatim: the markers are never consumed there.
  assert.equal(
    render('```\n**not bold** [x](y)\n```'),
    '<pre><code>**not bold** [x](y)</code></pre>'
  );
});

test('markers that do not match a rule exactly stay escaped literal text', () => {
  assert.equal(render('**alone'), '<p>**alone</p>'); // bold opener, no close
  assert.equal(render('a [b c'), '<p>a [b c</p>'); // `[` with no `]`
  assert.equal(render('[t] no paren'), '<p>[t] no paren</p>'); // no `(` after `]`
  assert.equal(render('[t](url with space)'), '<p>[t](url with space)</p>'); // URL whitespace
  assert.equal(render('[]()'), '<p>[]()</p>'); // empty link text
  assert.equal(render('[a]()'), '<p>[a]()</p>'); // empty URL
  assert.equal(render('a ` b'), '<p>a ` b</p>'); // backtick never closed
  assert.equal(render('``'), '<p>``</p>'); // adjacent empty code pair
  assert.equal(render('*item'), '<p>*item</p>'); // italic opener, no close
  assert.equal(render('* item'), '<p>* item</p>'); // asterisk-bullet lookalike
});

test('backslash-escaped markers never open an inline rule', () => {
  // The scanner passes `\`+marker pairs through verbatim; the escape strip
  // consumes them afterwards, leaving the bare markers as inert text.
  assert.equal(render('\\*a\\*'), '<p>*a*</p>');
  assert.equal(render('\\`a\\`'), '<p>`a`</p>');
  assert.equal(render('\\[a](u)'), '<p>[a](u)</p>');
});

test('unmatched surplus asterisks around a pair stay literal text (rule 10)', () => {
  // The first viable `**` opener takes the next `**` as its close; the
  // asterisks that no pair consumes surface verbatim inside and outside.
  assert.equal(render('***x***'), '<p><strong>*x</strong>*</p>');
});

test('no recursion into matched content: markers inside strong stay literal', () => {
  assert.equal(render('**a *b* c**'), '<p><strong>a *b* c</strong></p>');
});

test('renderInline consumes already-escaped text (escape stays the single escaping point)', () => {
  assert.equal(renderInline(escapeHtml('*a* & <b>')), '<em>a</em> &amp; &lt;b&gt;');
});

// A legal 100,000-character body must not stall the single process: the
// position prepass makes every closer lookup linear. naive indexOf-per-
// opener scanning needs ~10^10 comparisons here — far beyond the generous
// 5s bound a linear scan clears in milliseconds (so this cannot flake).
test('adversarial opener floods render within the request budget', () => {
  const started = process.hrtime.bigint();
  render('['.repeat(100_000));
  render('[a](b'.repeat(20_000));
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs < 5000, `inline scan took ${elapsedMs.toFixed(0)}ms`);
});

// The five issue acceptance scenarios, pinned character-for-character on
// the wire exactly as a black-box probe sees them.
test('wire bodies match the inline acceptance contract exactly', async () => {
  const srv = await startServer();

  const boldItalic = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '**bold** and *ital* text' }),
  });
  assert.equal(boldItalic.status, 200);
  assert.equal(boldItalic.rawBody, '{"html":"<p><strong>bold</strong> and <em>ital</em> text</p>"}');

  const code = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: 'Use `npm test` with `<b>` inside' }),
  });
  assert.equal(code.status, 200);
  assert.equal(
    code.rawBody,
    '{"html":"<p>Use <code>npm test</code> with <code>&lt;b&gt;</code> inside</p>"}'
  );

  const link = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: 'Visit [our site](https://example.com) today' }),
  });
  assert.equal(link.status, 200);
  assert.equal(
    link.rawBody,
    '{"html":"<p>Visit <a href=\\"https://example.com\\">our site</a> today</p>"}'
  );

  const heading = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '# A **titled** [link](https://x.test)' }),
  });
  assert.equal(heading.status, 200);
  assert.equal(
    heading.rawBody,
    '{"html":"<h1>A <strong>titled</strong> <a href=\\"https://x.test\\">link</a></h1>"}'
  );

  const fence = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '```\n**not bold** [x](y)\n```' }),
  });
  assert.equal(fence.status, 200);
  assert.equal(fence.rawBody, '{"html":"<pre><code>**not bold** [x](y)</code></pre>"}');
});
