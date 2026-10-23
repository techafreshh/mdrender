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

// Every §Supported-subset literal pair pinned byte-for-byte as a whole
// document. Single-construct inputs render inside a `<p>` (or their block
// tag), because that is the wire truth a black-box probe sees. `####` and
// unsupported-marker inputs degrade to escaped paragraph text, never tags.
test('PRD §Supported subset renders each literal pair exactly', () => {
  const pairs = [
    ['# Alpha', '<h1>Alpha</h1>'],
    ['## Beta', '<h2>Beta</h2>'],
    ['### Gamma', '<h3>Gamma</h3>'],
    ['#### Delta', '<p>#### Delta</p>'],
    ['**text**', '<p><strong>text</strong></p>'],
    ['*text*', '<p><em>text</em></p>'],
    ['`code`', '<p><code>code</code></p>'],
    ['[text](url)', '<p><a href="url">text</a></p>'],
    ['- one\n- two', '<ul><li>one</li><li>two</li></ul>'],
    ['```\ncode\n```', '<pre><code>code</code></pre>'],
    ['plain line', '<p>plain line</p>'],
    ['& < > " \'', '<p>&amp; &lt; &gt; &quot; &#39;</p>'],
  ];
  for (const [md, want] of pairs) {
    assert.equal(render(md), want, `render(${JSON.stringify(md)})`);
  }
});

// The two PRD Examples pinned character-for-character on the wire exactly
// as a black-box probe sees them: both the raw body string and the parsed
// html value must match the golden output.
test('PRD golden examples are byte-exact on the wire', async () => {
  const srv = await startServer();

  const golden1 = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({
      md: '# Hi\n\nVisit [our site](https://example.com) today, **please**.',
    }),
  });
  assert.equal(golden1.status, 200);
  assert.equal(
    golden1.rawBody,
    '{"html":"<h1>Hi</h1><p>Visit <a href=\\"https://example.com\\">our site</a> today, <strong>please</strong>.</p>"}'
  );
  assert.equal(
    JSON.parse(golden1.rawBody).html,
    '<h1>Hi</h1><p>Visit <a href="https://example.com">our site</a> today, <strong>please</strong>.</p>'
  );

  const golden2 = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: 'Use `npm test`.\n\n<script>alert(1)</script>' }),
  });
  assert.equal(golden2.status, 200);
  assert.equal(
    golden2.rawBody,
    '{"html":"<p>Use <code>npm test</code>.</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"}'
  );
  assert.equal(
    JSON.parse(golden2.rawBody).html,
    '<p>Use <code>npm test</code>.</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'
  );
});
