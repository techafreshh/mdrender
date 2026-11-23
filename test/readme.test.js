'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

test('README documents every required section', () => {
  for (const heading of ['What it is', 'Why it exists', 'Quickstart', 'Usage', 'Configuration', 'Limitations']) {
    assert.match(readme, new RegExp(`^## ${heading}$`, 'm'), `README is missing the "## ${heading}" section`);
  }
});

test('every environment variable the code reads is documented', () => {
  const names = new Set();
  for (const file of ['server.js', 'e2e.mjs']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) names.add(match[1]);
  }
  assert.deepStrictEqual([...names].sort(), ['E2E_BASE_URL', 'PORT']);
  for (const name of names) assert.ok(readme.includes(name), `README does not document the ${name} environment variable`);
});

test('every command the README advertises is backed by a file in the repo', () => {
  for (const command of ['node server.js', 'node --test', 'node e2e.mjs', 'docker compose up']) {
    assert.ok(readme.includes(command), `README does not mention \`${command}\``);
  }
  for (const file of ['server.js', 'e2e.mjs', 'docker-compose.yml', '.github/workflows/ci.yml', 'PRD.md']) {
    assert.ok(fs.existsSync(path.join(root, file)), `README points at ${file}, which does not exist`);
  }
});

test('README advertises no npm scripts or package.json, because the repo has neither', () => {
  assert.ok(!fs.existsSync(path.join(root, 'package.json')));
  assert.doesNotMatch(readme, /\bnpm (install|test|run)\b/, 'README must not reference npm commands: there is no package.json');
});
