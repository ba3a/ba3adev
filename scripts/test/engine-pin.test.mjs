import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));

test('package.json pins the coffer tag v0.1.2', () => {
  assert.equal(json('package.json').dependencies.coffer, 'git+https://github.com/ba3a/coffer.git#v0.1.2');
});

test('package-lock.json resolves coffer to the pinned release', () => {
  const lock = json('package-lock.json');
  assert.equal(lock.packages[''].dependencies.coffer, 'git+https://github.com/ba3a/coffer.git#v0.1.2');
  const entry = lock.packages['node_modules/coffer'];
  assert.equal(entry.version, '0.1.2');
  assert.match(entry.resolved, /ba3a\/coffer\.git#[0-9a-f]{40}$/);
});

test('the installed engine is 0.1.2', () => {
  assert.equal(json('node_modules/coffer/package.json').version, '0.1.2');
});

test('the engine stylesheet registers --coffer-measure as a <length> set on :root', () => {
  const css = read('node_modules/coffer/theme/assets/coffer.css');
  const property = css.match(/@property\s+--coffer-measure\s*\{([^}]*)\}/);
  assert.ok(property, '@property --coffer-measure is registered');
  assert.match(property[1], /syntax:\s*"<length>"/);
  const rootRule = [...css.matchAll(/(^|\})\s*:root\s*\{([^}]*)\}/g)].map((m) => m[2]);
  assert.ok(rootRule.some((body) => /--coffer-measure:\s*68ch\s*;/.test(body)), ':root sets --coffer-measure');
});
