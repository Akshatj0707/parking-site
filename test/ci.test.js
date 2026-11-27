'use strict';

// The GitHub Actions file is plain text that nothing else reads until it is pushed, so a typo would only show up on GitHub.
// These checks catch the usual mistakes here instead (no YAML library needed: the file is small and its shape is fixed).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('the workflow runs the same command as "npm test" does on a computer', () => {
  assert.match(workflow, /^\s*- run: npm test\s*$/m);
  assert.equal(pkg.scripts.test, 'node --test');
});

test('the workflow installs exactly what package-lock.json says', () => {
  assert.match(workflow, /^\s*- run: npm ci\s*$/m);
  assert.ok(fs.existsSync(path.join(root, 'package-lock.json')));
});

test('the workflow runs on pushes and pull requests to the branches in use', () => {
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'));
  assert.match(on, /push:\s*\n\s*branches: \[free-demo, main\]/);
  assert.match(on, /pull_request:\s*\n\s*branches: \[free-demo, main\]/);
});

test('the workflow tries the oldest Node the site supports and a current one, and can only read the code', () => {
  const minimum = String(pkg.engines.node).match(/(\d+)/)[1];
  const matrix = workflow.match(/node: \[([^\]]+)\]/);
  assert.ok(matrix, 'a Node version list');
  const versions = matrix[1].split(',').map((v) => Number(v.trim()));
  assert.ok(versions.includes(Number(minimum)), `Node ${minimum} (engines in package.json) is tested`);
  assert.ok(Math.max(...versions) > Number(minimum), 'a newer Node is tested too');
  assert.match(workflow, /permissions:\s*\n\s*contents: read/);
});

test('the workflow file has no tab characters (YAML does not allow them) and every line is plain text', () => {
  assert.ok(!workflow.includes('\t'));
  assert.ok(!/[^\n\x20-\x7e]/.test(workflow.replace(/[—–’]/g, '')), 'no stray control or odd characters');
});

test('the README badge points at this workflow', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  assert.match(readme, /actions\/workflows\/ci\.yml\/badge\.svg/);
});
