'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const { createServer, escapeHtml, render } = require('../server');

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

// Minimal node:http client; resolves {status, rawBody} once the full
// response body has been consumed.
function request(server, path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = body !== null ? { 'Content-Length': Buffer.byteLength(body) } : {};
    const req = http.request(
      { host: '127.0.0.1', port: server.address().port, path, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, rawBody: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

test('GET /health returns 200 with ok:true', async () => {
  const srv = await startServer();
  const res = await request(srv, '/health');
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(res.rawBody).ok, true);
});

test('POST /render escapes the golden pair exactly', async () => {
  const srv = await startServer();
  const res = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: 'a & b <c> "d" \'e\'' }),
  });
  assert.equal(res.status, 200);
  // Golden escape table, character for character.
  assert.equal(
    res.rawBody,
    '{"html":"a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;"}'
  );
});

test('escaping replaces & first (no double-escape)', async () => {
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(render('&lt;'), '&amp;lt;');
  const srv = await startServer();
  const res = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: '&lt;' }),
  });
  assert.equal(JSON.parse(res.rawBody).html, '&amp;lt;');
});

test('md of 100,001 characters returns 413 with the exact error body', async () => {
  const srv = await startServer();
  const res = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: 'x'.repeat(100001) }),
  });
  assert.equal(res.status, 413);
  assert.equal(res.rawBody, '{"error":"payload too large"}');
});

test('md of exactly 100,000 characters is still accepted', async () => {
  const srv = await startServer();
  const res = await request(srv, '/render', {
    method: 'POST',
    body: JSON.stringify({ md: 'x'.repeat(100000) }),
  });
  assert.equal(res.status, 200);
});

test('malformed JSON and missing/non-string md return 400 with an error field', async () => {
  const srv = await startServer();
  const badBodies = ['', 'not json', '{"x":1}', '{"md":123}'];
  for (const body of badBodies) {
    const res = await request(srv, '/render', { method: 'POST', body });
    assert.equal(res.status, 400, `status for body: ${JSON.stringify(body)}`);
    const parsed = JSON.parse(res.rawBody);
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  }
});

test('the process survives an invalid body and keeps serving', async () => {
  const srv = await startServer();
  const bad = await request(srv, '/render', { method: 'POST', body: 'not json' });
  assert.equal(bad.status, 400);
  const health = await request(srv, '/health');
  assert.equal(health.status, 200);
  assert.equal(JSON.parse(health.rawBody).ok, true);
});

test('unmatched method+path returns 404 with an error field', async () => {
  const srv = await startServer();
  const res = await request(srv, '/render'); // GET on a POST-only route
  assert.equal(res.status, 404);
  assert.ok(JSON.parse(res.rawBody).error);
});
