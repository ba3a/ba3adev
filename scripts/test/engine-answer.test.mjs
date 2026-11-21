// Tests for scripts/engine-answer.mjs. Nothing is fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { answer } from '../engine-answer.mjs';

const pkg = (range) => JSON.stringify({ dependencies: { coffer: `git+https://github.com/ba3a/coffer.git#semver:>=${range}` } });
const tags = ['v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.3.0', 'v0.1.2'].map((tag, i) => `${String(i).padStart(40, 'a')}\trefs/tags/${tag}\n`).join('');
const live = (engineVersion) => JSON.stringify({ engineVersion });

test('a site built with an older release needs a rebuild, and the newest tag counts even across a minor version', () => {
  const result = answer(pkg('0.2.1'), tags, [{ site: 'a', buildInfo: live('0.2.1') }, { site: 'b', buildInfo: live('0.3.0') }]);
  assert.equal(result.needed, true);
  assert.equal(result.reasons.length, 1);
  assert.match(result.reasons[0].message, /a was built with coffer 0\.2\.1; 0\.3\.0 is released/);
});

test('sites on the newest release need nothing', () => {
  const result = answer(pkg('0.2.1'), tags, [{ site: 'a', buildInfo: live('0.3.0') }]);
  assert.deepEqual(result, { needed: false, site: 'coffer', reasons: [] });
});

test('a range without a >= version, no release in the range and a build-info without a version are errors', () => {
  assert.throws(() => answer(JSON.stringify({ dependencies: { coffer: 'git+https://github.com/ba3a/coffer.git#v0.2.0' } }), tags, []), /no #semver/);
  assert.throws(() => answer(pkg('0.9.0'), tags, []), /no coffer release/);
  assert.throws(() => answer(pkg('0.2.1'), tags, [{ site: 'a', buildInfo: '{}' }]), /no engineVersion/);
});
