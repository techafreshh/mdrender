'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createServer, render } = require('../server');

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

// Acceptance bullet 3: every unsupported block construct (table, blockquote,
// image, setext heading) in one document comes out fully inert — the wire
// body is the exact pinned string, no `<table`/`<blockquote`/`<img`/`<h1`
// substring appears, and every raw `<`/`>` belongs to the single emitted
// `<p>` wrapper (the only structural tags allowed as raw angles).
test('wire body for tables, blockquotes, images, and setext in one document', async () => {
  const srv = await startServer();
  const res = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '| a | b |\n> quote\n![img](x.png)\nSetext\n======' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.rawBody, '{"html":"<p>| a | b |\\n&gt; quote\\n![img](x.png)\\nSetext\\n======</p>"}');
  const html = JSON.parse(res.rawBody).html;
  for (const banned of ['<table', '<blockquote', '<img', '<h1']) {
    assert.ok(!html.includes(banned), `must not contain ${banned}`);
  }
  // "every < and > escaped": outside the one `<p>`/`</p>` wrapper no raw
  // angle survives; the wrapper is the only legal raw pair in the output.
  assert.equal(html.slice(0, 3), '<p>');
  assert.ok(html.endsWith('</p>'));
  assert.ok(!/[<>]/.test(html.slice(3, -4)), 'only the <p> wrapper may contain raw angles');
});

// Acceptance bullet 4: whitespace-flanked emphasis and whitespace-laden link
// URLs are near-miss syntax — no `<strong>`, `<em>`, or `<a href` may be
// emitted; everything stays escaped literal text byte-for-byte on the wire.
test('wire body for unmatched emphasis and malformed links stays literal', async () => {
  const srv = await startServer();
  const res = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '* unmatched\n[a](bad url\n** still ** open' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.rawBody, '{"html":"<p>* unmatched\\n[a](bad url\\n** still ** open</p>"}');
  const html = JSON.parse(res.rawBody).html;
  for (const banned of ['<strong>', '<em>', '<a href']) {
    assert.ok(!html.includes(banned), `must not contain ${banned}`);
  }
});

test('unsupported constructs stay escaped literal text, per family', () => {
  // Tables are not a block rule: pipe rows pass through unescaped pipes.
  assert.equal(render('| a | b |\n| - | - |'), '<p>| a | b |\n| - | - |</p>');
  // Blockquote `>` is escapable punctuation: it comes out as `&gt;`.
  assert.equal(render('> quote\n> more'), '<p>&gt; quote\n&gt; more</p>');
  // Images are unsupported (rule 11): the bang prefix must keep the whole
  // `![alt](url)` run literal — no inner <a href> may leak out, mid-text
  // included.
  assert.equal(render('![alt](x.png)'), '<p>![alt](x.png)</p>');
  assert.equal(render('a![x](y)b'), '<p>a![x](y)b</p>');
  // Nested list content (two-space indent) is not a `- ` line: the parent
  // list closes at the indented line and the child stays paragraph text.
  assert.equal(render('- top\n  - nested'), '<ul><li>top</li></ul><p> - nested</p>');
  // Setext headings (`===`/`---` underline) are not headings: the underline
  // stays paragraph text (and `-` would only matter at line start with a
  // space, which it has not).
  assert.equal(render('Para\n==='), '<p>Para\n===</p>');
  assert.equal(render('Para\n---'), '<p>Para\n---</p>');
  // Reference links have no definition registry: both the usage and the
  // definition line render as separate plain paragraphs.
  assert.equal(
    render('[ref][1]\n\n[1]: https://x.test'),
    '<p>[ref][1]</p><p>[1]: https://x.test</p>'
  );
});

test('raw HTML and malformed links come out inert', () => {
  // Any raw tag shape is escaped character-for-character, attributes
  // included — the text can never become live DOM.
  assert.equal(
    render('<img src=x onerror=alert(1)>'),
    '<p>&lt;img src=x onerror=alert(1)&gt;</p>'
  );
  // A quote inside the URL breaks the whitespace-free URL requirement, and
  // the `"` escapes to &quot; — the match falls through to literal text.
  assert.equal(render('[x](a"b c)'), '<p>[x](a&quot;b c)</p>');
});

test('emphasis flanking near-misses stay literal; flanking holds across a newline', () => {
  // Whitespace at either edge of the matched content rejects the pair.
  assert.equal(render('** bold ** open'), '<p>** bold ** open</p>');
  // The joining \n is not an edge: flanking is the only newline
  // restriction, so `x*y\nz*w` still closes an italic pair (CommonMark's
  // own soft-break behavior) — this documents that no *extra* line
  // confinement was added along with flanking.
  assert.equal(render('x*y\nz*w'), '<p>x<em>y\nz</em>w</p>');
});

// The battery must never take the process down: after the adversarial
// bodies above, /health still answers 200 {ok:true} on the same instance.
test('the process survives the adversarial battery and keeps serving', async () => {
  const srv = await startServer();
  for (const md of [
    '| a | b |\n> quote\n![img](x.png)\nSetext\n======',
    '* unmatched\n[a](bad url\n** still ** open',
  ]) {
    const res = await request(srv, '/render', {
      method: 'POST',
      body: JSON.stringify({ md }),
    });
    assert.equal(res.status, 200);
    assert.ok(JSON.parse(res.rawBody).html !== undefined);
  }
  const health = await request(srv, '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.rawBody).ok, true);
});
