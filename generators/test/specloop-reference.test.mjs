// Tests of generators/specloop-reference.mjs against a small fixture copy of the
// layout of the specloop repository (generators/test/fixtures/specloop-mini).
// They need no network and no build. Inputs that git or the platform would
// change (line endings, a byte order mark, links, huge files) are made in a
// temporary copy of the fixture.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseReferenceJson } from '../../node_modules/coffer/src/docs/reference.js';
import {
  InputError,
  LIMITS,
  buildReference,
  environmentReads,
  flattenDefaults,
  parseFrontMatter,
  plainText,
  tableRows,
} from '../specloop-reference.mjs';

const generator = fileURLToPath(new URL('../specloop-reference.mjs', import.meta.url));
const fixture = fileURLToPath(new URL('./fixtures/specloop-mini', import.meta.url));

/** Temporary folders made by the tests, removed at the end. */
const temporary = [];
after(() => {
  for (const dir of temporary) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** @returns {string} A new empty temporary folder. */
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'specloop-reference-test-'));
  temporary.push(dir);
  return dir;
}

/** @returns {string} A writable copy of the fixture. */
function copyOfFixture() {
  const dir = join(scratch(), 'repo');
  cpSync(fixture, dir, { recursive: true });
  return dir;
}

/** @param {string[]} args */
function cli(args) {
  const result = spawnSync(process.execPath, [generator, ...args], { encoding: 'utf8' });
  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** @param {ReturnType<typeof buildReference>} result @param {string} title */
function section(result, title) {
  const found = result.reference.sections.find((candidate) => candidate.title === title);
  assert.ok(found, `the reference has the section "${title}"`);
  return found.items;
}

/** @param {{ name: string }[]} items @param {string} name */
function item(items, name) {
  const found = items.find((candidate) => candidate.name === name);
  assert.ok(found, `the item "${name}" is listed`);
  return found;
}

/** The number of keys of an object at every depth, counted the plain way. */
function countKeys(value) {
  let total = 0;
  for (const child of Object.values(value)) {
    total += 1;
    if (typeof child === 'object' && child !== null && !Array.isArray(child)) total += countKeys(child);
  }
  return total;
}

const result = buildReference(fixture);

test('every command file of the fixture is listed, with the default prefix', () => {
  const files = readdirSync(join(fixture, 'kit', 'commands')).filter((name) => name.endsWith('.md'));
  const commands = section(result, 'Slash commands');
  assert.equal(commands.length, files.length);
  assert.deepEqual(
    commands.map((command) => command.name),
    files.map((name) => `/m-${name.slice(0, -3)}`).sort(),
  );
  assert.equal(result.counts.commands, files.length);
});

test('every key of defaults.json is listed, at every depth', () => {
  const defaults = JSON.parse(readFileSync(join(fixture, 'kit', 'specloop', 'defaults.json'), 'utf8'));
  const keys = section(result, 'Configuration keys');
  assert.equal(keys.length, countKeys(defaults));
  assert.equal(result.counts.keys, countKeys(defaults));
  assert.equal(new Set(keys.map((key) => key.name)).size, keys.length, 'no key is listed twice');
  for (const name of ['commandPrefix', 'feature', 'feature.planPhases.feature-plan.delegate', 'phases.plan.check.type', 'unicodeKey-\u00e9', 'emptyBlock', 'list']) {
    item(keys, name);
  }
});

test('the output is in the format coffer reads', () => {
  const parsed = parseReferenceJson(JSON.stringify(result.reference));
  assert.ok('model' in parsed, 'problems' in parsed ? parsed.problems.join('; ') : '');
});

test('commands: description, argument hint, prefix note and the cases of front matter', () => {
  const commands = section(result, 'Slash commands');
  const go = item(commands, '/m-go');
  assert.equal(go.kind, 'slash command');
  assert.equal(go.signature, '/m-go');
  assert.match(go.description, /^mini: start or resume the workflow\n\n/);
  assert.match(go.description, /default prefix "m-"/);
  assert.match(go.description, /another prefix/);
  assert.equal(go.undocumented, false);
  assert.equal(item(commands, '/m-spec').signature, '/m-spec <path-to-spec.md>');
  assert.match(item(commands, '/m-spec').description, /^mini: load a spec, the "quoted" kind\n/);
  // An argument hint that looks like a YAML list stays text; a trailing comment is dropped.
  assert.equal(item(commands, '/m-update').signature, '/m-update [check|skip|never]');
  assert.match(item(commands, '/m-update').description, /^mini: check for updates\n/);
  // A folded block scalar is joined into one line.
  assert.match(item(commands, '/m-status').description, /^mini: show the state of the workflow\n/);
  // Unicode and escapes survive.
  assert.match(item(commands, '/m-unicode').description, /^Показать состояние — ünïcode ✓ é and a tab: done\n/);
  // No description, and no front matter: flagged, without a description, with a warning.
  for (const name of ['/m-nodesc', '/m-nofront']) {
    const command = item(commands, name);
    assert.equal(command.undocumented, true, name);
    assert.equal(command.description, undefined, name);
  }
  assert.equal(item(commands, '/m-nodesc').signature, '/m-nodesc <anything>');
  assert.ok(result.warnings.some((warning) => warning.includes('kit/commands/nofront.md') && warning.includes('no front matter')));
});

test('configuration keys: exact descriptions, inherited descriptions and undocumented keys', () => {
  const keys = section(result, 'Configuration keys');
  const maxIterations = item(keys, 'maxIterations');
  assert.equal(maxIterations.signature, 'maxIterations = 15');
  assert.equal(maxIterations.kind, 'configuration key');
  // The first description wins; a table in a code fence is not read.
  assert.equal(maxIterations.description, 'Blocked stops per phase.');
  // Links, bold text and an escaped bar become plain text.
  assert.equal(item(keys, 'commandPrefix').description, 'Prefix of the slash commands, see Commands.');
  assert.equal(item(keys, 'list').description, 'A list of letters, written with an escaped bar: a|b.');
  assert.equal(item(keys, 'list').signature, 'list = ["a","b"]');
  assert.equal(item(keys, 'unicodeKey-\u00e9').description, 'Описание ключа с юникодом.');
  // A group has an item of its own; its children without a row take its description.
  assert.equal(item(keys, 'feature').kind, 'configuration group');
  assert.equal(item(keys, 'feature').description, 'Feature-mode settings.');
  assert.equal(item(keys, 'feature.inheritedChild').description, 'Part of "feature": Feature-mode settings.');
  assert.equal(item(keys, 'feature.branchPrefix').description, 'Prefix of the branch (CRLF line ending).');
  // The nearest documented ancestor wins over the top-level key.
  assert.equal(item(keys, 'feature.planPhases.feature-plan.delegate').description, 'Part of "feature.planPhases": The planning phases.');
  assert.equal(item(keys, 'phases.plan.check.type').description, 'Part of "phases": The phase graph.');
  // The header row of a table is not data.
  assert.equal(item(keys, 'update.mode').description, 'Part of "update": Update checks; see Updates.');
  assert.equal(item(keys, 'update.intervalHours').description, 'Minimum time between checks.');
  // No row, a row with one cell, a row with an empty description, and an empty object.
  for (const name of ['ghost', 'documentedLeaf', 'emptyBlock']) {
    assert.equal(item(keys, name).undocumented, true, name);
    assert.equal(item(keys, name).description, undefined, name);
  }
  assert.equal(item(keys, 'emptyBlock').signature, 'emptyBlock = {}');
  assert.equal(item(keys, 'emptyBlock').kind, 'configuration key');
});

test('environment variables: every read form, no writes, no comments', () => {
  const variables = section(result, 'Environment variables');
  assert.deepEqual(
    variables.map((variable) => variable.name),
    ['BARE_ENVIRON', 'CI', 'CLAUDE_PROJECT_DIR', 'MINI_DISABLED', 'MINI_GETENV'],
  );
  assert.equal(item(variables, 'MINI_DISABLED').description, 'All hooks become no-ops.');
  assert.equal(item(variables, 'CI').description, 'Update checks behave as off.');
  for (const name of ['BARE_ENVIRON', 'CLAUDE_PROJECT_DIR', 'MINI_GETENV']) assert.equal(item(variables, name).undocumented, true, name);
  assert.equal(item(variables, 'CI').kind, 'environment variable');
});

test('the counts and the list of undocumented items agree with the flags', () => {
  const flagged = result.reference.sections.flatMap((candidate) => candidate.items).filter((candidate) => candidate.undocumented);
  assert.equal(result.counts.undocumented, flagged.length);
  assert.deepEqual(result.undocumented.slice().sort(), [
    'configuration key documentedLeaf',
    'configuration key emptyBlock',
    'configuration key ghost',
    'environment variable BARE_ENVIRON',
    'environment variable CLAUDE_PROJECT_DIR',
    'environment variable MINI_GETENV',
    'slash command /m-nodesc',
    'slash command /m-nofront',
  ]);
});

test('anchors are unique and acceptable to coffer', () => {
  const anchors = result.reference.sections.flatMap((candidate) => candidate.items).map((candidate) => candidate.anchor);
  assert.equal(new Set(anchors).size, anchors.length);
  for (const anchor of anchors) assert.match(anchor, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
});

test('the order is deterministic: sorted, and byte-identical on two runs', () => {
  const first = scratch();
  const second = scratch();
  assert.equal(cli([fixture, first]).code, 0);
  assert.equal(cli([fixture, second]).code, 0);
  const text = readFileSync(join(first, 'reference.json'), 'utf8');
  assert.equal(text, readFileSync(join(second, 'reference.json'), 'utf8'));
  assert.ok(text.endsWith('}\n'));
  assert.doesNotMatch(text, /\d{4}-\d{2}-\d{2}T/, 'no time stamp');
  const byCodePoint = (items) => items.map((entry) => entry.name).every((name, index, names) => index === 0 || names[index - 1] < name);
  for (const title of ['Slash commands', 'Configuration keys', 'Environment variables']) {
    assert.ok(byCodePoint(section(result, title)), `${title} are sorted`);
  }
});

test('the command line writes reference.json and nothing else, and reports the undocumented items', () => {
  const out = join(scratch(), 'nested', 'out');
  const run = cli([fixture, out]);
  assert.equal(run.code, 0, run.stderr);
  assert.deepEqual(readdirSync(out), ['reference.json']);
  assert.match(run.stdout, /^specloop reference: 7 commands, 25 configuration keys, 5 environment variables, 8 undocumented\n$/);
  assert.match(run.stderr, /^undocumented: slash command \/m-nodesc$/m);
  assert.match(run.stderr, /^undocumented: configuration key ghost$/m);
  assert.match(run.stderr, /^undocumented: environment variable CLAUDE_PROJECT_DIR$/m);
  assert.match(run.stderr, /^warning: kit\/commands\/nofront\.md: has no front matter$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(out, 'reference.json'), 'utf8')), JSON.parse(JSON.stringify(result.reference)));
});

test('wrong arguments exit with 2', () => {
  assert.equal(cli([]).code, 2);
  assert.equal(cli([fixture]).code, 2);
  assert.equal(cli([fixture, scratch(), 'extra']).code, 2);
  assert.match(cli([]).stderr, /usage:/);
});

test('missing inputs exit with 3 and the message names what is missing', () => {
  const cases = [
    ['kit/specloop/defaults.json', /kit\/specloop\/defaults\.json is missing/],
    ['kit/specloop/engine.py', /kit\/specloop\/engine\.py is missing/],
    ['kit/commands', /kit\/commands\/ is missing/],
    ['docs', /docs\/ is missing/],
  ];
  for (const [path, message] of cases) {
    const repo = copyOfFixture();
    rmSync(join(repo, ...path.split('/')), { recursive: true });
    const out = scratch();
    const run = cli([repo, out]);
    assert.equal(run.code, 3, `${path}: ${run.stderr}`);
    assert.match(run.stderr, message);
    assert.equal(existsSync(join(out, 'reference.json')), false, 'nothing is written after a failure');
  }
  const run = cli([join(scratch(), 'no-such-repo'), scratch()]);
  assert.equal(run.code, 3);
  assert.match(run.stderr, /no-such-repo" does not exist/);
});

test('an empty commands folder is an error, so the reference cannot silently omit the commands', () => {
  const repo = copyOfFixture();
  rmSync(join(repo, 'kit', 'commands'), { recursive: true });
  mkdirSync(join(repo, 'kit', 'commands'));
  const run = cli([repo, scratch()]);
  assert.equal(run.code, 3);
  assert.match(run.stderr, /no command templates/);
});

test('oversized and invalid inputs are refused', () => {
  const big = 'x'.repeat(LIMITS.commandFile + 1);
  /** @type {[string, string | Buffer, RegExp][]} */
  const cases = [
    ['kit/commands/go.md', `---\ndescription: ${big}\n---\n`, /kit\/commands\/go\.md is \d+ bytes; at most 65536 are read/],
    ['kit/specloop/defaults.json', ` ${' '.repeat(LIMITS.defaults)}{}`, /defaults\.json is \d+ bytes/],
    ['docs/configuration.md', 'x'.repeat(LIMITS.docFile + 1), /docs\/configuration\.md is \d+ bytes/],
    ['kit/specloop/engine.py', 'x'.repeat(LIMITS.engine + 1), /engine\.py is \d+ bytes/],
    ['kit/specloop/defaults.json', '{ not json', /defaults\.json is not valid JSON/],
    ['kit/specloop/defaults.json', '[1, 2]', /must hold a JSON object/],
    ['kit/specloop/defaults.json', '{"a.b": 1, "a": {"b": 2}}', /dotted key "a\.b" names two different keys/],
    ['kit/specloop/defaults.json', `${'{"a":'.repeat(40)}1${'}'.repeat(40)}`, /nested deeper than 16 levels/],
    ['kit/commands/go.md', Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe, 0x0a, 0x2d, 0x2d, 0x2d]), /not valid UTF-8/],
    ['kit/commands/bad name.md', '---\ndescription: x\n---\n', /not a usable command name/],
  ];
  for (const [path, content, message] of cases) {
    const repo = copyOfFixture();
    writeFileSync(join(repo, ...path.split('/')), content);
    const run = cli([repo, scratch()]);
    assert.equal(run.code, 3, `${path}: ${run.stderr}`);
    assert.match(run.stderr, message, path);
  }
});

test('a linked folder is not followed', (t) => {
  for (const folder of ['docs', 'kit/commands']) {
    const repo = copyOfFixture();
    rmSync(join(repo, ...folder.split('/')), { recursive: true });
    try {
      // A junction needs no privilege on Windows; elsewhere it is a folder link.
      symlinkSync(scratch(), join(repo, ...folder.split('/')), 'junction');
    } catch (error) {
      t.skip(`cannot create a folder link here: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const run = cli([repo, scratch()]);
    assert.equal(run.code, 3, folder);
    assert.match(run.stderr, new RegExp(`${folder}/ is a symbolic link`));
  }
});

test('linked files are not followed', (t) => {
  const outside = join(scratch(), 'outside.md');
  writeFileSync(outside, '---\ndescription: from outside the repository\n---\n');
  for (const [path, message] of [
    ['kit/commands/linked.md', /kit\/commands\/linked\.md is a symbolic link/],
    ['kit/specloop/engine.py', /engine\.py is a symbolic link/],
    ['docs/linked.md', /docs\/linked\.md is a symbolic link/],
  ]) {
    const repo = copyOfFixture();
    const file = join(repo, ...path.split('/'));
    rmSync(file, { force: true });
    try {
      symlinkSync(outside, file);
    } catch (error) {
      t.skip(`cannot create a symbolic link here: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const run = cli([repo, scratch()]);
    assert.equal(run.code, 3, path);
    assert.match(run.stderr, message);
  }
});

test('CRLF line endings and a byte order mark are accepted', () => {
  const repo = copyOfFixture();
  for (const path of ['kit/commands/go.md', 'kit/commands/spec.md', 'docs/configuration.md', 'kit/specloop/engine.py']) {
    const file = join(repo, ...path.split('/'));
    writeFileSync(file, `\ufeff${readFileSync(file, 'utf8').replace(/\r?\n/g, '\r\n')}`);
  }
  const crlf = buildReference(repo);
  assert.deepEqual(crlf.reference, result.reference);
});

test('the output goes only to <out>/reference.json, even for an odd out path', () => {
  const base = scratch();
  const out = join(base, 'a', '..', 'b');
  assert.equal(cli([fixture, out]).code, 0);
  assert.deepEqual(readdirSync(base), ['b']);
  assert.deepEqual(readdirSync(join(base, 'b')), ['reference.json']);
});

test('a refused output folder exits with 4', () => {
  const base = scratch();
  writeFileSync(join(base, 'file'), 'not a folder');
  const run = cli([fixture, join(base, 'file')]);
  assert.equal(run.code, 4);
  assert.match(run.stderr, /cannot write reference\.json/);
});

test('buildReference throws InputError for bad input', () => {
  assert.throws(() => buildReference(join(scratch(), 'missing')), InputError);
});

test('parseFrontMatter: entries, quoting and what it leaves alone', () => {
  assert.equal(parseFrontMatter('no front matter\n'), null);
  assert.equal(parseFrontMatter('--- \ndescription: x\n---\n')?.values.get('description'), 'x');
  const front = parseFrontMatter(
    ['---', '# a comment', 'description: "a \\"quoted\\" \\\\ value\\n\\u00e9"', "other: 'it''s'", 'plain: two words # note', 'nested:', '  child: 1', 'empty:', 'description: second one is ignored', '---', 'body'].join('\n'),
  );
  assert.ok(front);
  assert.equal(front.values.get('description'), 'a "quoted" \\ value\n\u00e9');
  assert.equal(front.values.get('other'), "it's");
  assert.equal(front.values.get('plain'), 'two words');
  assert.equal(front.values.get('child'), undefined);
  assert.equal(front.values.get('empty'), '');
  assert.deepEqual(front.problems, []);
  const unclosedQuote = parseFrontMatter('---\ndescription: "never closed\n---\n');
  assert.deepEqual(unclosedQuote?.problems, ['description: the quoted value is not closed on its line']);
  assert.equal(unclosedQuote?.values.get('description'), undefined);
  assert.deepEqual(parseFrontMatter('---\ndescription: x\n')?.problems, ['the front matter is not closed by a line "---"']);
  // A name that is not a plain key (here __proto__) is not an entry at all.
  assert.equal(parseFrontMatter('---\n__proto__: x\n---\n')?.values.size, 0);
});

test('tableRows: keys, odd cells and fences', () => {
  const rows = tableRows(
    [
      '| Key | Meaning |',
      '| --- | --- |',
      '| `a` | **Bold** [link](x.md#y) text |',
      '| `b=1` | with `code` |',
      '| `c` (note) | Trailing text after the span. |',
      '| nope | Not a code span. |',
      '| x `d` | Span not at the start. |',
      '| `` | Empty. |',
      '| `e` |   |',
      '',
      '```',
      '| Key | Meaning |',
      '| --- | --- |',
      '| `f` | In a fence. |',
      '```',
      '| `g` | Not a table: no separator row. |',
      '| `h` | Still not. |',
      '',
      '| Key | Left | Right |',
      '|:--|:-:|--:|',
      '| `i` | middle | The last cell is the text. |',
      '| `j` | no trailing bar | Last cell',
    ].join('\n'),
  );
  assert.deepEqual(rows, [
    { key: 'a', description: 'Bold link text' },
    { key: 'b=1', description: 'with code' },
    { key: 'c', description: 'Trailing text after the span.' },
    { key: 'i', description: 'The last cell is the text.' },
    { key: 'j', description: 'Last cell' },
  ]);
});

test('plainText reduces Markdown to text', () => {
  assert.equal(plainText('See [the **guide**](a.md) and  [x](y)\tnow<br>then'), 'See the guide and x now then');
});

test('flattenDefaults: groups, leaves, arrays and empty objects', () => {
  const flat = flattenDefaults({ b: { c: [1, { d: 2 }], e: {} }, a: null, f: 'x' });
  assert.deepEqual(
    flat.map((entry) => [entry.key, entry.group]),
    [
      ['a', false],
      ['b', true],
      ['b.c', false],
      ['b.e', false],
      ['f', false],
    ],
  );
  // __proto__ in the JSON is an ordinary key, not a prototype.
  const polluted = flattenDefaults(JSON.parse('{"__proto__": {"x": 1}}'));
  assert.deepEqual(polluted.map((entry) => entry.key), ['__proto__', '__proto__.x']);
  assert.equal({}.x, undefined);
});

test('environmentReads: the forms that count', () => {
  const source = [
    'a = os.environ.get("ONE")',
    "b = os.environ.get('TWO', 'default')",
    'c = os.environ["THREE"]',
    "d = os.getenv('FOUR')",
    'e = environ.get ( "FIVE" )',
    '# f = os.environ.get("COMMENT")',
    'g = dict(os.environ, SIX="1")',
    'h = os.environ.get(name)',
    'i = os.environ.get("ONE") + os.environ.get("ONE")',
    'j = os.environ.get("with space")',
    'k = myenviron.get("SEVEN")',
  ].join('\n');
  assert.deepEqual(environmentReads(source), ['FIVE', 'FOUR', 'ONE', 'THREE', 'TWO']);
});

test('long input does not take long (no catastrophic backtracking)', () => {
  const started = Date.now();
  const hostile = `| \`${'a'.repeat(3000)}\` | ${'[x]('.repeat(1500)} |\n`.repeat(50);
  tableRows(`| K | M |\n|---|---|\n${hostile}`);
  environmentReads(`os.environ.get( ${'"'.repeat(100000)}\n${'environ['.repeat(20000)}`);
  parseFrontMatter(`---\ndescription: ${'"\\'.repeat(100000)}\n---\n`);
  parseFrontMatter(`---\ndescription: a${' '.repeat(60000)}b\n---\n`);
  plainText('['.repeat(100000) + ']('.repeat(10000));
  environmentReads(`environ${' '.repeat(60000)}x\n${'environ '.repeat(20000)}`);
  assert.ok(Date.now() - started < 5000, 'hostile text is handled in linear time');
});
