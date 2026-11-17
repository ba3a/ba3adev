import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));

test('package.json follows the coffer releases from 0.2.1 up to the next minor', () => {
  assert.equal(json('package.json').dependencies.coffer, 'git+https://github.com/ba3a/coffer.git#semver:^0.2.1');
});

test('package-lock.json resolves coffer to a release that satisfies the range', () => {
  const lock = json('package-lock.json');
  assert.equal(lock.packages[''].dependencies.coffer, 'git+https://github.com/ba3a/coffer.git#semver:^0.2.1');
  const entry = lock.packages['node_modules/coffer'];
  assert.match(entry.version, /^0\.2\.(?:[1-9]\d*)$/);
  assert.match(entry.resolved, /ba3a\/coffer\.git#[0-9a-f]{40}$/);
});

test('the installed engine is the locked version', () => {
  assert.equal(json('node_modules/coffer/package.json').version, json('package-lock.json').packages['node_modules/coffer'].version);
});

test('the engine stylesheet registers --coffer-measure as a <length> set on :root', () => {
  const css = read('node_modules/coffer/theme/assets/coffer.css');
  const property = css.match(/@property\s+--coffer-measure\s*\{([^}]*)\}/);
  assert.ok(property, '@property --coffer-measure is registered');
  assert.match(property[1], /syntax:\s*"<length>"/);
  const rootRule = [...css.matchAll(/(^|\})\s*:root\s*\{([^}]*)\}/g)].map((m) => m[2]);
  assert.ok(rootRule.some((body) => /--coffer-measure:\s*68ch\s*;/.test(body)), ':root sets --coffer-measure');
});
