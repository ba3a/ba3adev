// Structural tests for .github/workflows/deploy.yml. The workflow cannot run here, so these tests
// read the YAML and check the properties that matter: the triggers, least privilege, pinned
// actions, secrets that are only referenced by name in the steps that need them, and the order of
// the steps. If the `actionlint` program happens to be installed it is run as well; it is never
// downloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const file = join(root, '.github', 'workflows', 'deploy.yml');
const text = readFileSync(file, 'utf8');
const workflow = parse(text);

/** @type {Array<Record<string, any>>} */
const steps = workflow.jobs.deploy.steps;

const SECRETS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];

/**
 * @param {string} name A step name, or a part of one.
 * @returns {Record<string, any>}
 */
function step(name) {
  const found = steps.filter((candidate) => String(candidate.name).includes(name));
  assert.equal(found.length, 1, `exactly one step is named like "${name}"`);
  return found[0];
}

/**
 * @param {string} name
 * @returns {number}
 */
function indexOfStep(name) {
  return steps.indexOf(step(name));
}

test('it runs on a push to main, by hand and when called by another workflow', () => {
  const on = workflow.on;
  assert.deepEqual(on.push, { branches: ['main'] });
  assert.ok('workflow_dispatch' in on);
  assert.ok('workflow_call' in on);
  assert.deepEqual(Object.keys(on).sort(), ['push', 'workflow_call', 'workflow_dispatch']);
});

test('only a run on main can publish: the job is guarded against other branches', () => {
  assert.equal(workflow.jobs.deploy.if, "github.ref == 'refs/heads/main'");
  // Every deployment targets the production branch, which is what the guard protects.
  assert.match(step('Deploy ba3a.dev').run, /--branch main/);
  assert.match(step('Deploy my.ba3a.dev').run, /--branch main/);
});

test('a caller can pass the secrets: all four are declared on workflow_call, and required', () => {
  const declared = workflow.on.workflow_call.secrets;
  assert.deepEqual(Object.keys(declared).sort(), [...SECRETS].sort());
  for (const name of SECRETS) assert.equal(declared[name].required, true, name);
});

test('it asks for read access to the contents and nothing else', () => {
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.deploy.permissions, undefined, 'the job does not widen them');
});

test('deployments queue in the group "deploy" and are not cancelled', () => {
  assert.deepEqual(workflow.concurrency, { group: 'deploy', 'cancel-in-progress': false });
});

test('every action is pinned to a version, in the same style as the rest of the repository', () => {
  const uses = steps.filter((candidate) => candidate.uses).map((candidate) => String(candidate.uses));
  assert.ok(uses.length >= 5);
  for (const reference of uses) {
    assert.match(reference, /^[\w.-]+\/[\w.-]+@(v\d+(\.\d+){0,2}|[0-9a-f]{40})$/, `${reference} is pinned to a version tag or a commit`);
  }
});

test('wrangler is pinned to an exact version', () => {
  assert.match(String(workflow.env.WRANGLER_VERSION), /^4\.\d+\.\d+$/);
  for (const name of ['Deploy ba3a.dev', 'Deploy my.ba3a.dev']) {
    assert.match(step(name).run, /wrangler@\$\{WRANGLER_VERSION\}/);
  }
  assert.match(text, /Refresh this pin deliberately/);
});

test('node and java are set up for the build and the Dokka reference', () => {
  const node = steps.find((candidate) => String(candidate.uses).startsWith('actions/setup-node@'));
  assert.deepEqual(node?.with, { 'node-version-file': '.nvmrc', cache: 'npm' });
  assert.ok(existsSync(join(root, '.nvmrc')));
  const java = steps.find((candidate) => String(candidate.uses).startsWith('actions/setup-java@'));
  assert.equal(java?.with.distribution, 'temurin');
  assert.equal(String(java?.with['java-version']), '21');
  assert.equal(java?.with.cache, 'gradle');
  assert.ok(existsSync(join(root, java?.with['cache-dependency-path'])), 'the file that keys the Gradle cache exists');
});

/**
 * @param {string} name
 * @returns {{ paths: string[], key: string, restoreKeys: string[] }}
 */
function cacheStep(name) {
  const s = step(name);
  assert.match(String(s.uses), /^actions\/cache@/);
  return {
    paths: String(s.with.path).split('\n').filter(Boolean),
    key: String(s.with.key),
    restoreKeys: String(s.with['restore-keys'] ?? '').split('\n').filter(Boolean),
  };
}

test('the four cache directories of the build are cached', () => {
  const images = cacheStep('image and title card');
  const docs = cacheStep('documentation caches');
  assert.deepEqual([...images.paths, ...docs.paths].sort(), ['.cache/cards', '.cache/images', '.cache/reference', '.cache/repos']);
  assert.match(images.key, /hashFiles\('media\.lock\.json'\)/);
  assert.match(images.key, /hashFiles\('coffer\.yaml'\)/);
});

test('the documentation caches are keyed by the generators and the build support, with no fallback past them', () => {
  const docs = cacheStep('documentation caches');
  for (const needle of ["hashFiles('generators/**')", "hashFiles('build-support/**')", 'coffer.yaml', 'package-lock.json', 'media.lock.json']) {
    assert.ok(docs.key.includes(needle), `the key contains ${needle}`);
    assert.ok(docs.restoreKeys.every((restore) => restore.includes(needle)), `every restore key contains ${needle}`);
  }
  assert.ok(docs.restoreKeys.length > 0, 'the latest result for the same hashes is restored');
  assert.ok(docs.restoreKeys.every((restore) => restore.length > 'docs-'.length + 20), 'no restore key is a bare prefix');
});

test('secrets appear only as ${{ secrets.NAME }} in the env of the steps that need them', () => {
  const allowedIn = /** @type {Record<string, string[]>} */ ({
    R2_ACCESS_KEY_ID: ['Fetch the photo originals'],
    R2_SECRET_ACCESS_KEY: ['Fetch the photo originals'],
    CLOUDFLARE_API_TOKEN: ['Deploy ba3a.dev', 'Deploy my.ba3a.dev'],
    CLOUDFLARE_ACCOUNT_ID: ['Fetch the photo originals', 'Deploy ba3a.dev', 'Deploy my.ba3a.dev'],
  });
  // Every mention of "secrets." in the file is one of these references.
  const mentions = [...text.matchAll(/secrets\.([A-Za-z0-9_]+)/g)].map((match) => match[1]);
  assert.ok(mentions.every((name) => SECRETS.includes(name)), 'only the four known secrets are used');
  for (const reference of text.matchAll(/\$\{\{\s*secrets\.[A-Za-z0-9_]+\s*\}\}/g)) {
    assert.match(reference[0], /^\$\{\{ secrets\.[A-Z0-9_]+ \}\}$/);
  }
  for (const candidate of steps) {
    assert.doesNotMatch(String(candidate.run ?? ''), /secrets\./, `step "${candidate.name}" does not put a secret into a command`);
    assert.doesNotMatch(JSON.stringify(candidate.with ?? {}), /secrets\./, `step "${candidate.name}" does not pass a secret to an action`);
    for (const [variable, value] of Object.entries(candidate.env ?? {})) {
      const match = /^\$\{\{ secrets\.([A-Z0-9_]+) \}\}$/.exec(String(value));
      assert.ok(match, `${candidate.name}: ${variable} is a plain secret reference`);
      assert.equal(match[1], variable, `${candidate.name}: ${variable} carries the secret of the same name`);
      assert.ok(allowedIn[variable]?.some((allowed) => String(candidate.name).startsWith(allowed)), `${variable} is not passed to "${candidate.name}"`);
    }
  }
  assert.equal(workflow.env.CLOUDFLARE_API_TOKEN, undefined);
  assert.equal(workflow.jobs.deploy.env, undefined, 'no secret at the level of the job');
  // And each of the steps that need secrets does get them.
  for (const [variable, names] of Object.entries(allowedIn)) {
    for (const name of names) assert.ok(step(name).env?.[variable], `${name} has ${variable}`);
  }
});

test('nothing prints the environment or turns on tracing and debug output', () => {
  const commands = steps.map((candidate) => String(candidate.run ?? '')).join('\n');
  assert.doesNotMatch(commands, /set\s+-[a-z]*x/);
  assert.doesNotMatch(commands, /\b(printenv|env\s*(\||$))/m);
  assert.doesNotMatch(commands, /\becho\b/);
  assert.doesNotMatch(commands, /--verbose|--debug|\bDEBUG\b|WRANGLER_LOG|ACTIONS_STEP_DEBUG/i);
  assert.doesNotMatch(text, /ACTIONS_STEP_DEBUG|ACTIONS_RUNNER_DEBUG/);
  assert.doesNotMatch(commands, /\bcurl\b.*(Authorization|token)/i);
});

test('the steps run in a safe order', () => {
  const order = [
    'Check out',
    'Set up Node.js',
    'Install dependencies',
    'Fetch the photo originals',
    'Build both sites',
    'Check the build',
    'Print the build report',
    'Prepare the output',
    'Deploy ba3a.dev',
    'Deploy my.ba3a.dev',
    'Smoke test',
  ];
  const positions = order.map(indexOfStep);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b), 'the steps are in the order of the list');
  assert.equal(new Set(positions).size, order.length);
  // The caches and Java are in place before the build that fills them.
  assert.ok(indexOfStep('documentation caches') < indexOfStep('Build both sites'));
  assert.ok(indexOfStep('image and title card') < indexOfStep('Build both sites'));
  assert.ok(indexOfStep('Set up Java') < indexOfStep('Build both sites'));
  assert.equal(steps.at(-1)?.name, 'Smoke test the live sites', 'the smoke test comes last');
});

test('the build is the production build, checked with the W3C feed validator', () => {
  assert.equal(step('Install dependencies').run, 'npm ci');
  assert.equal(step('Fetch the photo originals').run, 'npx coffer media pull');
  assert.equal(step('Build both sites').run, 'npm run build');
  assert.doesNotMatch(step('Build both sites').run, /--drafts/);
  assert.equal(step('Check the build').run, 'npx coffer check --w3c');
  assert.match(step('Print the build report').run, /scripts\/build-summary\.mjs >> "\$GITHUB_STEP_SUMMARY"/);
  assert.match(step('Prepare the output').run, /scripts\/prepare-deploy\.mjs/);
});

test('each site goes to its own production Pages project from its own folder', () => {
  const first = step('Deploy ba3a.dev').run;
  const second = step('Deploy my.ba3a.dev').run;
  assert.match(first, /pages deploy dist\/ba3a\.dev --project-name ba3a-dev --branch main/);
  assert.match(second, /pages deploy dist\/my\.ba3a\.dev --project-name my-ba3a-dev --branch main/);
  assert.doesNotMatch(first + second, /preview|--branch (?!main)/);
});

test('the smoke test reads the build of this run and has a bounded wait', () => {
  const smoke = step('Smoke test').run;
  assert.match(smoke, /^node scripts\/smoke-test\.mjs --dist dist --timeout \d+$/);
  const seconds = Number(/--timeout (\d+)/.exec(smoke)?.[1]);
  assert.ok(seconds > 0 && seconds <= 600);
  assert.ok(workflow.jobs.deploy['timeout-minutes'] > seconds / 60, 'the job limit is longer than the smoke test');
  assert.equal(step('Smoke test').env, undefined, 'the smoke test needs no secret');
});

test('every script the workflow runs exists', () => {
  const commands = steps.map((candidate) => String(candidate.run ?? '')).join('\n');
  const scripts = [...commands.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map((match) => match[1]);
  assert.ok(scripts.length >= 3);
  for (const script of scripts) assert.ok(existsSync(join(root, script)), `${script} exists`);
  // The command names the workflow relies on are those of the package.json.
  const scriptsOfPackage = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
  assert.ok(scriptsOfPackage.build);
  assert.ok(existsSync(join(root, 'deploy', '_headers')));
});

test('actionlint finds nothing, when it is installed', (t) => {
  const result = spawnSync('actionlint', [file], { encoding: 'utf8' });
  if (result.error) {
    t.skip('actionlint is not installed; the structure was checked by the tests above');
    return;
  }
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
