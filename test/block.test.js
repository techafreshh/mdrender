'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createServer, escapeHtml, parseBlocks, render } = require('../server');

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

test('headings h1-h3 emit one tag per line, never merged', () => {
  assert.equal(render('# Alpha\n## Beta\n### Gamma'), '<h1>Alpha</h1><h2>Beta</h2><h3>Gamma</h3>');
});

test('#### or deeper, and # without a space, stay escaped paragraph text', () => {
  assert.equal(render('#### Deep'), '<p>#### Deep</p>');
  assert.equal(render('#NoSpace'), '<p>#NoSpace</p>');
});

// `* ` is an unordered-list marker in full markdown but not in our subset:
// it must pass through as escaped paragraph text, never become a <ul>.
test('an asterisk list-marker lookalike stays escaped paragraph text', () => {
  assert.equal(render('* item'), '<p>* item</p>');
  assert.equal(render('*item'), '<p>*item</p>');
});

// Backslash escapes (CommonMark): `\` before an ASCII punctuation character
// is consumed, leaving that character as inert text — so a backslash-escaped
// asterisk renders as a plain asterisk inside a paragraph. The escape runs
// at content-emission time, never before classification: `\- `/`\# ` must
// NOT conjure a list/heading, and fence content stays verbatim.
test('a backslash-escaped asterisk renders as a literal asterisk', () => {
  assert.equal(render('\\* item'), '<p>* item</p>');
});

test('backslash escapes never create block structure', () => {
  assert.equal(render('\\- item'), '<p>- item</p>');
  assert.equal(render('\\# hi'), '<p># hi</p>');
  assert.equal(render('\\```'), '<p>```</p>');
});

test('backslash escapes apply to heading and list content, never fence content', () => {
  assert.equal(render('# \\* hi'), '<h1>* hi</h1>');
  assert.equal(render('- \\* x'), '<ul><li>* x</li></ul>');
  assert.equal(render('```\n\\* x\n```'), '<pre><code>\\* x</code></pre>');
});

test('backslash escapes before HTML-escapable characters stay fully escaped', () => {
  assert.equal(render('\\&'), '<p>&amp;</p>');
  assert.equal(render('\\<x>'), '<p>&lt;x&gt;</p>');
  assert.equal(render('\\"q"'), '<p>&quot;q&quot;</p>');
});

test('a backslash before non-punctuation, another backslash chain, or end of input is kept', () => {
  assert.equal(render('\\a'), '<p>\\a</p>'); // `\a` is not an escape
  assert.equal(render('a\\\\b'), '<p>a\\b</p>'); // `\\` escapes to one backslash
  assert.equal(render('line\\'), '<p>line\\</p>'); // trailing backslash kept
});

test('consecutive `- ` lines form one <ul>; a non-list line ends the run', () => {
  assert.equal(render('- one\n- two\n\npara'), '<ul><li>one</li><li>two</li></ul><p>para</p>');
  assert.equal(render('-a'), '<p>-a</p>');
});

test('fenced content is escaped verbatim inside one <pre><code>', () => {
  assert.equal(
    render('```\n<script>alert(1)</script>\n```'),
    '<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>'
  );
});

test('fence content keeps heading and list markers verbatim inside <code>', () => {
  assert.equal(
    render('```\n# not a heading\n- not a list\n```'),
    '<pre><code># not a heading\n- not a list</code></pre>'
  );
});

test('an unterminated fence consumes to the end of input', () => {
  assert.equal(render('```\nleft open'), '<pre><code>left open</code></pre>');
});

test('a blank line inside a fence is fence content, not a separator', () => {
  assert.equal(render('```\na\n\nb\n```'), '<pre><code>a\n\nb</code></pre>');
});

test('consecutive non-blank lines merge into one paragraph', () => {
  assert.equal(
    render('line one\nline two\n\nline three'),
    '<p>line one\nline two</p><p>line three</p>'
  );
});

test('a blank line always ends the paragraph run', () => {
  assert.equal(render('a\n\n\n\nb'), '<p>a</p><p>b</p>');
});

// CR and CRLF are line boundaries exactly like LF (CommonMark); a `\r` left
// inside a block would leak into the HTML and corrupt exact-body output.
test('CRLF and lone-CR line endings are normalized before block parsing', () => {
  assert.equal(
    render('line one\r\nline two\r\n\r\nline three'),
    '<p>line one\nline two</p><p>line three</p>'
  );
  assert.equal(render('a\rb'), '<p>a\nb</p>');
  assert.equal(render('# Alpha\r\n## Beta'), '<h1>Alpha</h1><h2>Beta</h2>');
  assert.equal(render('* item\r\n'), '<p>* item</p>');
  assert.equal(render('```\r\na\r\n```'), '<pre><code>a</code></pre>');
});

test('block content is escaped in every position', () => {
  assert.equal(render('# <x>'), '<h1>&lt;x&gt;</h1>');
  assert.equal(render('- <x>'), '<ul><li>&lt;x&gt;</li></ul>');
  assert.equal(render('<x>'), '<p>&lt;x&gt;</p>');
});

test('parseBlocks consumes already-escaped text (escape stays the single escaping point)', () => {
  assert.equal(parseBlocks(escapeHtml('a & b')), '<p>a &amp; b</p>');
});

test('wire bodies match the acceptance contract exactly', async () => {
  const srv = await startServer();

  const headings = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '# Alpha\n## Beta\n### Gamma' }),
  });
  assert.equal(headings.status, 200);
  assert.equal(headings.rawBody, '{"html":"<h1>Alpha</h1><h2>Beta</h2><h3>Gamma</h3>"}');

  const list = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '- one\n- two\n\npara' }),
  });
  assert.equal(list.status, 200);
  assert.equal(list.rawBody, '{"html":"<ul><li>one</li><li>two</li></ul><p>para</p>"}');

  const fence = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '```\n<script>alert(1)</script>\n```' }),
  });
  assert.equal(fence.status, 200);
  assert.equal(
    fence.rawBody,
    '{"html":"<pre><code>&lt;script&gt;alert(1)&lt;/script&gt;</code></pre>"}'
  );

  // The html string contains a real newline; JSON.stringify emits it as the
  // two-character escape `\n` on the wire — pinned here as `\\n`.
  const para = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: 'line one\nline two\n\nline three' }),
  });
  assert.equal(para.status, 200);
  assert.equal(para.rawBody, '{"html":"<p>line one\\nline two</p><p>line three</p>"}');

  // Same document arriving with CRLF line endings must produce the exact
  // same wire body — no `\r` may survive into the emitted HTML.
  const crlf = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: 'line one\r\nline two\r\n\r\nline three' }),
  });
  assert.equal(crlf.status, 200);
  assert.equal(crlf.rawBody, '{"html":"<p>line one\\nline two</p><p>line three</p>"}');
});
