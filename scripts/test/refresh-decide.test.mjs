// Tests for scripts/refresh-decide.mjs, which turns the answers of `coffer rebuild-needed --json`
// into the one `needed` output of the scheduled refresh workflow. Only files in a throwaway folder
// are used; nothing is fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkAnswer, decide, main } from '../refresh-decide.mjs';

const script = fileURLToPath(new URL('../refresh-decide.mjs', import.meta.url));

/**
 * @param {Record<string, unknown>} answers File name to content (objects are written as JSON).
 * @returns {{ dir: string, path: (name: string) => string }}
 */
function folder(answers) {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-decide-'));
  for (const [name, content] of Object.entries(answers)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return { dir, path: (name) => join(dir, name) };
}

const NO = { needed: false, site: 'ba3a.dev', url: 'https://ba3a.dev/build-info.json', checkedAt: '2026-06-01T00:00:00.000Z', reasons: [] };
const YES = {
  needed: true,
  site: 'my.ba3a.dev',
  url: 'https://my.ba3a.dev/build-info.json',
  checkedAt: '2026-06-01T00:00:00.000Z',
  reasons: [{ code: 'source-sha-changed', source: 'roto', message: 'roto: main moved from aaa to bbb' }],
};

test('nothing to do when no site needs a rebuild', () => {
  const { dir, path } = folder({ 'a.json': NO, 'b.json': { ...NO, site: 'my.ba3a.dev' } });
  try {
    const result = decide([path('a.json'), path('b.json')]);
    assert.equal(result.needed, false);
    assert.match(result.report, /site ba3a\.dev: up to date/);
    assert.match(result.report, /deploy: no/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('either site is enough, whichever comes first', () => {
  const { dir, path } = folder({ 'a.json': NO, 'b.json': YES });
  try {
    assert.equal(decide([path('a.json'), path('b.json')]).needed, true);
    assert.equal(decide([path('b.json'), path('a.json')]).needed, true);
    const report = decide([path('a.json'), path('b.json')]).report;
    assert.match(report, /site my\.ba3a\.dev: rebuild needed\n {2}- source-sha-changed: roto: main moved from aaa to bbb/);
    assert.match(report, /deploy: yes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the answer is written to $GITHUB_OUTPUT as needed=true or needed=false', () => {
  const { dir, path } = folder({ 'a.json': NO, 'b.json': YES, 'out.txt': '' });
  try {
    for (const [files, expected] of [
      [['a.json', 'b.json'], 'needed=true\n'],
      [['a.json'], 'needed=false\n'],
    ]) {
      writeFileSync(path('out.txt'), '');
      let printed = '';
      const code = main(files.map(path), { out: (text) => (printed += text), err: () => assert.fail('no error expected'), env: { GITHUB_OUTPUT: path('out.txt') } });
      assert.equal(code, 0);
      assert.equal(readFileSync(path('out.txt'), 'utf8'), expected);
      assert.match(printed, /^site /);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an answer that cannot be used is an error, and writes no output', () => {
  const cases = /** @type {Record<string, unknown>} */ ({
    'missing.json': undefined,
    'empty.json': '',
    'text.json': 'yes\n',
    'array.json': [],
    'no-needed.json': { site: 'a', reasons: [] },
    'string-needed.json': { needed: 'true', site: 'a', reasons: [{ code: 'x', message: 'y' }] },
    'no-site.json': { needed: false, reasons: [] },
    'no-reasons.json': { needed: false, site: 'a' },
    'bad-reason.json': { needed: true, site: 'a', reasons: [{ code: 'x' }] },
    'disagree-yes.json': { needed: true, site: 'a', reasons: [] },
    'disagree-no.json': { needed: false, site: 'a', reasons: [{ code: 'x', message: 'y' }] },
  });
  const { dir, path } = folder({ ...Object.fromEntries(Object.entries(cases).filter(([, v]) => v !== undefined)), 'ok.json': YES, 'out.txt': '' });
  try {
    for (const name of Object.keys(cases)) {
      // A good answer next to a bad one must not win: "yes" never covers up an error.
      let error = '';
      const code = main([path('ok.json'), path(name)], { out: () => assert.fail('nothing is printed'), err: (text) => (error += text), env: { GITHUB_OUTPUT: path('out.txt') } });
      assert.equal(code, 1, name);
      assert.match(error, /^refresh: /, name);
      assert.equal(readFileSync(path('out.txt'), 'utf8'), '', `${name}: no output was written`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('without files, or with an option, it is a usage error', () => {
  for (const args of [[], ['--json'], ['--help', 'x.json']]) {
    let error = '';
    assert.equal(main(args, { out: () => {}, err: (text) => (error += text), env: {} }), 2);
    assert.match(error, /^Usage:/);
  }
});

test('text from the answers cannot become a workflow command or a second line', () => {
  const hostile = { needed: true, site: 'a', reasons: [{ code: 'x\n::set-output name=needed::false', message: '\r\n::add-mask::value\u0000\u2028::error::boom' }] };
  const { dir, path } = folder({ 'h.json': hostile });
  try {
    const { report } = decide([path('h.json')]);
    for (const line of report.split('\n')) assert.doesNotMatch(line, /^::/, `"${line}" starts like a workflow command`);
    assert.equal(report.trimEnd().split('\n').length, 3, 'one line for the site, one for the reason, one for the result');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkAnswer keeps only what it needs', () => {
  assert.deepEqual(checkAnswer(YES, 'x'), { needed: true, site: 'my.ba3a.dev', reasons: [{ code: 'source-sha-changed', message: 'roto: main moved from aaa to bbb' }] });
});

test('it runs as a program: the exit code and the output file', () => {
  const { dir, path } = folder({ 'a.json': NO, 'b.json': YES, 'bad.json': '{', 'out.txt': '' });
  try {
    const ok = spawnSync(process.execPath, [script, path('a.json'), path('b.json')], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: path('out.txt') } });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(readFileSync(path('out.txt'), 'utf8'), 'needed=true\n');
    const bad = spawnSync(process.execPath, [script, path('a.json'), path('bad.json')], { encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: path('out.txt') } });
    assert.equal(bad.status, 1);
    assert.equal(readFileSync(path('out.txt'), 'utf8'), 'needed=true\n', 'a failed run adds nothing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
