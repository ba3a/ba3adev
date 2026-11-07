// Structural tests for .github/workflows/refresh.yml and keepalive.yml. The workflows cannot run
// here, so these tests read the YAML and check what matters: the schedule, that the decision job
// has no secrets and no scripts of dependencies, how the deploy workflow is called, the
// concurrency groups, least privilege, and the keepalive. If the `actionlint` program happens to be
// installed it is run as well; it is never downloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const refreshFile = join(root, '.github', 'workflows', 'refresh.yml');
const keepaliveFile = join(root, '.github', 'workflows', 'keepalive.yml');
const refreshText = readFileSync(refreshFile, 'utf8');
const keepaliveText = readFileSync(keepaliveFile, 'utf8');
const refresh = parse(refreshText);
const keepalive = parse(keepaliveText);
const deploy = parse(readFileSync(join(root, '.github', 'workflows', 'deploy.yml'), 'utf8'));

/** @type {Array<Record<string, any>>} */
const decideSteps = refresh.jobs.decide.steps;

/**
 * @param {Array<Record<string, any>>} steps
 * @param {string} name
 * @returns {Record<string, any>}
 */
function step(steps, name) {
  const found = steps.filter((candidate) => String(candidate.name).includes(name));
  assert.equal(found.length, 1, `exactly one step is named like "${name}"`);
  return found[0];
}

test('refresh runs every 15 minutes and by hand, and nothing else', () => {
  assert.deepEqual(Object.keys(refresh.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(refresh.on.schedule, [{ cron: '*/15 * * * *' }]);
});

test('the delay of scheduled runs and the 60-day rule are explained in a comment', () => {
  assert.match(refreshText, /5 to 15 minutes late/);
  assert.match(refreshText, /about every 15 minutes/);
  assert.match(refreshText, /within an hour/);
  assert.match(refreshText, /default branch/);
  assert.match(refreshText, /60 days/);
  assert.match(refreshText, /No token in the project repositories/);
});

test('the decision job asks both sites, with the exact command and the live build-info.json', () => {
  const run = String(step(decideSteps, 'Ask both sites').run);
  assert.match(run, /^set -euo pipefail$/m, 'a failing command stops the step');
  assert.match(run, /for site in ba3a\.dev my\.ba3a\.dev; do/);
  assert.match(run, /npx coffer rebuild-needed --site "\$site" --url "https:\/\/\$site\/build-info\.json" --json > /);
  assert.doesNotMatch(run, /\|\| true|set \+e|2>\/dev\/null|continue-on-error/, 'an error is never ignored');
  assert.match(run, /node scripts\/refresh-decide\.mjs .*ba3a\.dev\.json" .*my\.ba3a\.dev\.json"/);
  assert.equal(step(decideSteps, 'Ask both sites').id, 'decide');
  assert.equal(refresh.jobs.decide.outputs.needed, '${{ steps.decide.outputs.needed }}');
  assert.equal(step(decideSteps, 'Ask both sites')['continue-on-error'], undefined);
});

test('the site ids and addresses are those of coffer.yaml', () => {
  const config = parse(readFileSync(join(root, 'coffer.yaml'), 'utf8'));
  const run = String(step(decideSteps, 'Ask both sites').run);
  const listed = /for site in ([^;]+); do/.exec(run)?.[1].split(' ');
  assert.deepEqual(listed, config.sites.map((/** @type {{ id: string }} */ site) => site.id));
  for (const site of config.sites) assert.equal(site.baseUrl, `https://${site.id}`);
});

test('the decision job has no secrets, no write access and installs without scripts', () => {
  const job = refresh.jobs.decide;
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.env, undefined);
  assert.equal(job.if, undefined);
  const text = JSON.stringify(job);
  assert.doesNotMatch(text, /secrets\./);
  assert.doesNotMatch(text, /GH_TOKEN|GITHUB_TOKEN|github\.token/);
  assert.equal(step(decideSteps, 'Install dependencies').run, 'npm ci --ignore-scripts');
  assert.equal(step(decideSteps, 'Check out').with['persist-credentials'], false);
  assert.ok(job['timeout-minutes'] <= 15);
  // No step passes anything but a plain literal to a command, and none builds a command from github.* context.
  assert.doesNotMatch(decideSteps.map((candidate) => String(candidate.run ?? '')).join('\n'), /\$\{\{/);
});

test('the deploy job calls deploy.yml only when needed, with the secrets and read access', () => {
  const job = refresh.jobs.deploy;
  assert.equal(job.uses, './.github/workflows/deploy.yml');
  assert.equal(job.secrets, 'inherit');
  assert.equal(job.needs, 'decide');
  assert.equal(job.if, "needs.decide.outputs.needed == 'true'");
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job.steps, undefined, 'a job that calls a workflow has no steps');
  assert.ok('workflow_call' in deploy.on, 'deploy.yml can be called');
  // The permissions of the caller are enough for the ones deploy.yml asks for.
  assert.deepEqual(deploy.permissions, { contents: 'read' });
  // Nothing else needs the decision job's answer, and an error in it means no deployment: the `if` is
  // evaluated with the implicit success() of a needed job, so a failed decision skips the deployment.
  assert.doesNotMatch(String(job.if), /always\(\)|failure\(\)|cancelled\(\)/);
});

test('the secrets are not named in refresh.yml: the deploy workflow declares them', () => {
  assert.doesNotMatch(refreshText.replace(/^\s*#.*$/gm, ''), /secrets\.[A-Z]/);
  assert.deepEqual(Object.keys(deploy.on.workflow_call.secrets).length, 4);
});

test('refresh has a group of its own that is not the deployment group, and is never cancelled', () => {
  assert.deepEqual(refresh.concurrency, { group: 'refresh', 'cancel-in-progress': false });
  assert.notEqual(refresh.concurrency.group, deploy.concurrency.group);
  assert.deepEqual(keepalive.concurrency.group === refresh.concurrency.group, false);
  assert.equal(keepalive.concurrency['cancel-in-progress'], false);
});

test('the default permission is read-only, and only the keepalive jobs may write to Actions', () => {
  assert.deepEqual(refresh.permissions, { contents: 'read' });
  assert.deepEqual(keepalive.permissions, { contents: 'read' });
  for (const [name, job] of Object.entries(refresh.jobs)) {
    const write = /** @type {any} */ (job).permissions?.actions === 'write';
    assert.equal(write, name === 'keepalive', `${name}`);
  }
  assert.deepEqual(refresh.jobs.keepalive.permissions, { contents: 'read', actions: 'write' });
  assert.deepEqual(keepalive.jobs.keepalive.permissions, { contents: 'read', actions: 'write' });
  // Nobody asks for more than that anywhere.
  for (const text of [refreshText, keepaliveText]) assert.doesNotMatch(text, /(contents|pull-requests|id-token|packages): write|write-all/);
});

test('the keepalive job of refresh.yml is independent and runs no installed code', () => {
  const job = refresh.jobs.keepalive;
  assert.equal(job.needs, undefined, 'a failing poll does not stop it, and it does not hold back a deployment');
  assert.equal(job.if, undefined);
  const run = job.steps.map((/** @type {Record<string, any>} */ candidate) => String(candidate.run ?? '')).join('\n');
  assert.match(run, /^node scripts\/keepalive\.mjs refresh\.yml$/m);
  assert.doesNotMatch(run, /npm|npx/);
  assert.deepEqual(step(job.steps, 'Enable refresh.yml').env, { GH_TOKEN: '${{ github.token }}' });
});

test('keepalive.yml runs monthly and by hand, and enables refresh.yml and itself', () => {
  assert.deepEqual(Object.keys(keepalive.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.equal(keepalive.on.schedule.length, 1);
  const cron = String(keepalive.on.schedule[0].cron).split(' ');
  assert.equal(cron.length, 5);
  assert.equal(cron[2], '1', 'on the 1st of the month');
  assert.deepEqual(cron.slice(3), ['*', '*'], 'every month');
  assert.match(cron[0], /^\d+$/);
  assert.match(cron[1], /^\d+$/);
  const run = String(step(keepalive.jobs.keepalive.steps, 'Enable refresh.yml').run);
  assert.equal(run, 'node scripts/keepalive.mjs --always refresh.yml keepalive.yml');
  assert.deepEqual(step(keepalive.jobs.keepalive.steps, 'Enable refresh.yml').env, { GH_TOKEN: '${{ github.token }}' });
  assert.ok(existsSync(join(root, '.github', 'workflows', 'keepalive.yml')));
  assert.match(keepaliveText, /60 days/);
  assert.match(keepaliveText, /best effort/);
});

test('the token reaches the keepalive script only through the environment of its step', () => {
  for (const [text, workflow] of [[refreshText, refresh], [keepaliveText, keepalive]]) {
    const code = text.replace(/^\s*#.*$/gm, '');
    assert.equal(code.match(/github\.token/g)?.length, 1, 'the token is referenced once');
    for (const job of Object.values(workflow.jobs)) {
      assert.equal(/** @type {any} */ (job).env, undefined, 'no environment at the level of a job');
      for (const candidate of /** @type {any} */ (job).steps ?? []) {
        if (candidate.env) assert.match(String(candidate.run), /^node scripts\/keepalive\.mjs /);
        assert.doesNotMatch(String(candidate.run ?? ''), /\becho\b|printenv|set\s+-[a-z]*x|GH_TOKEN/);
      }
    }
    assert.equal(workflow.env, undefined);
  }
});

test('every action is pinned like the ones in deploy.yml', () => {
  /** @type {string[]} */
  const used = [];
  for (const workflow of [refresh, keepalive]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const candidate of /** @type {any} */ (job).steps ?? []) if (candidate.uses) used.push(String(candidate.uses));
    }
  }
  assert.ok(used.length >= 6);
  /** @type {Map<string, string>} */
  const known = new Map();
  for (const candidate of deploy.jobs.deploy.steps) {
    if (candidate.uses) known.set(String(candidate.uses).split('@')[0], String(candidate.uses));
  }
  for (const reference of used) {
    assert.equal(reference, known.get(reference.split('@')[0]), `${reference} is the version deploy.yml uses`);
  }
});

test('node comes from .nvmrc and the scripts the workflows run exist', () => {
  for (const workflow of [refresh, keepalive]) {
    for (const job of Object.values(workflow.jobs)) {
      for (const candidate of /** @type {any} */ (job).steps ?? []) {
        if (String(candidate.uses).startsWith('actions/setup-node@')) assert.equal(candidate.with['node-version-file'], '.nvmrc');
      }
    }
  }
  assert.ok(existsSync(join(root, '.nvmrc')));
  for (const text of [refreshText, keepaliveText]) {
    for (const match of text.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)) assert.ok(existsSync(join(root, match[1])), `${match[1]} exists`);
  }
  for (const script of ['scripts/refresh-decide.mjs', 'scripts/keepalive.mjs']) assert.ok(existsSync(join(root, script)));
});

test('coffer rebuild-needed has the options and the exit-code contract the workflow relies on', () => {
  const usage = readFileSync(join(root, 'node_modules', 'coffer', 'src', 'cli.js'), 'utf8');
  for (const option of ['--url', '--site', '--json']) assert.ok(usage.includes(option), option);
  const docs = readFileSync(join(root, 'node_modules', 'coffer', 'docs', 'scheduling.md'), 'utf8');
  assert.match(docs, /\| 0 +\| The command gave an answer/);
  assert.match(docs, /\| 1 +\| The command could not give an answer/);
});

test('actionlint finds nothing, when it is installed', (t) => {
  const result = spawnSync('actionlint', [refreshFile, keepaliveFile], { encoding: 'utf8' });
  if (result.error) {
    t.skip('actionlint is not installed; the structure was checked by the tests above');
    return;
  }
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
