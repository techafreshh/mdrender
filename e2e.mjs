// Delivery probe: proves the contract bytes served by the app inside the
// worker container over the published host port. Zero dependencies (Node 22
// global fetch). This file lives at the repo root, NOT under `test/`,
// because Node 22's `node --test` executes every script under any `test/`
// directory — here it is invisible to the runner. Usage: `node e2e.mjs`
// (wait then replay), `node e2e.mjs wait`, `node e2e.mjs replay`.
const BASE = process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000';
const POLL_DEADLINE_MS = 60_000;
const POLL_INTERVAL_MS = 500;

// Bounded poll: /health must answer 200 with body {"ok":true} before the
// deadline, else exit non-zero (the stack is not delivering).
async function waitForHealth() {
  const deadline = Date.now() + POLL_DEADLINE_MS;
  let lastFailure = 'not attempted';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(2000) });
      const text = await res.text();
      if (res.status === 200 && JSON.parse(text).ok === true) {
        console.log(`PASS /health is 200 {"ok":true} at ${BASE}`);
        return;
      }
      lastFailure = `status ${res.status} body ${text}`;
    } catch (err) {
      lastFailure = String(err.cause ?? err);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  console.error(`FAIL /health never became 200 {"ok":true} at ${BASE} within ${POLL_DEADLINE_MS}ms (last: ${lastFailure})`);
  console.error('Inspect the app with: docker compose logs worker');
  process.exit(1);
}

// Contract replay: status and body compared byte-for-byte against the same
// literals pinned in test/golden.test.js, test/server.test.js and
// test/adversarial.test.js — copied verbatim, never retyped.
const CASES = [
  {
    name: 'GET /health',
    method: 'GET',
    path: '/health',
    body: null,
    status: 200,
    want: '{"ok":true}',
  },
  {
    name: 'PRD golden 1 (link + bold)',
    method: 'POST',
    path: '/render',
    body: JSON.stringify({
      md: '# Hi\n\nVisit [our site](https://example.com) today, **please**.',
    }),
    status: 200,
    want: '{"html":"<h1>Hi</h1><p>Visit <a href=\\"https://example.com\\">our site</a> today, <strong>please</strong>.</p>"}',
  },
  {
    name: 'PRD golden 2 (code + escaped script)',
    method: 'POST',
    path: '/render',
    body: JSON.stringify({ md: 'Use `npm test`.\n\n<script>alert(1)</script>' }),
    status: 200,
    want: '{"html":"<p>Use <code>npm test</code>.</p><p>&lt;script&gt;alert(1)&lt;/script&gt;</p>"}',
  },
  {
    name: '100,001-char md is 413',
    method: 'POST',
    path: '/render',
    body: JSON.stringify({ md: 'x'.repeat(100001) }),
    status: 413,
    want: '{"error":"payload too large"}',
  },
  {
    name: 'raw HTML injection is escaped inert',
    method: 'POST',
    path: '/render',
    body: JSON.stringify({ md: '<img src=x onerror=alert(1)>' }),
    status: 200,
    want: '{"html":"<p>&lt;img src=x onerror=alert(1)&gt;</p>"}',
  },
];

// Strict-equality replay: the first mismatch throws (non-zero exit).
async function replayContract() {
  for (const c of CASES) {
    let res, got;
    try {
      res = await fetch(`${BASE}${c.path}`, {
        method: c.method,
        headers: c.body === null ? undefined : { 'content-type': 'application/json' },
        body: c.body,
        signal: AbortSignal.timeout(5000),
      });
      got = await res.text();
    } catch (err) {
      throw new Error(`FAIL ${c.name}: request to ${BASE}${c.path} failed: ${String(err.cause ?? err)}`);
    }
    if (res.status !== c.status || got !== c.want) {
      throw new Error(
        `FAIL ${c.name}: expected status ${c.status} body ${JSON.stringify(c.want)}, got status ${res.status} body ${JSON.stringify(got)}`
      );
    }
  }
  console.log(`PASS ${CASES.length}/${CASES.length} contract cases match exactly at ${BASE}`);
}

const mode = process.argv[2] ?? 'both';
if (mode === 'wait' || mode === 'both') await waitForHealth();
if (mode === 'replay' || mode === 'both') await replayContract();
