// Tests for OPERATIONS.md, the go-live runbook: its steps are in order and each action asks for the
// user's confirmation, its commands match the repository (secret names, pins, scripts, paths), the list of
// files to adapt after the split of the engine is complete, and the commands that edit files work on copies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (/** @type {string} */ name) => readFileSync(join(root, name), 'utf8');

const operations = read('OPERATIONS.md');
const packageJson = JSON.parse(read('package.json'));
const deploy = read('.github/workflows/deploy.yml');

const CONFIRM = 'User confirms before running.';

/**
 * @param {string} text
 * @returns {{ level: number, title: string, line: number, body: string }[]} The sections of a Markdown text, with the text up to the next heading of any level.
 */
function sections(text) {
  const lines = text.split('\n');
  /** @type {{ level: number, title: string, line: number, body: string }[]} */
  const found = [];
  let inFence = false;
  lines.forEach((line, index) => {
    if (/^ *```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6}) +(.+?) *$/.exec(line) : null;
    if (heading) found.push({ level: heading[1].length, title: heading[2], line: index + 1, body: '' });
    else if (found.length > 0) found[found.length - 1].body += `${line}\n`;
  });
  return found;
}

/** @param {string} text @returns {string[]} The bodies of the fenced code blocks. */
function fences(text) {
  return [...text.matchAll(/^ *```[\w-]*\n([\s\S]*?)^ *```[ \t]*$/gm)].map((match) => match[1]);
}

/** @param {string} text @returns {string} The text without fenced code blocks. */
function withoutFences(text) {
  return text.replace(/^ *```[\s\S]*?^ *```[ \t]*$/gm, '');
}

/** @param {string} heading @returns {string} The anchor GitHub makes from a heading. */
function slugify(heading) {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s/g, '-');
}

/** @param {string} text @returns {string[]} The anchors of the headings. */
function anchorsOf(text) {
  /** @type {string[]} */
  const anchors = [];
  const counts = new Map();
  for (const { title } of sections(text)) {
    const base = slugify(title);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.push(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

const parts = sections(operations);
const steps = parts.filter((part) => part.level === 2 && /^\d\. /.test(part.title));
const actions = parts.filter((part) => part.level === 3);

/** @param {string} prefix The number of an action, for example "2.3". @returns {{ title: string, body: string }} */
function action(prefix) {
  const found = actions.find((part) => part.title.startsWith(`${prefix} `));
  assert.ok(found, `OPERATIONS.md has an action ${prefix}`);
  return found;
}

test('the steps 0 to 7 are in order, and the seven go-live steps are the ones that were planned', () => {
  assert.deepEqual(
    steps.map((step) => step.title.split('.')[0]),
    ['0', '1', '2', '3', '4', '5', '6', '7'],
  );
  const titles = steps.map((step) => step.title);
  assert.match(titles[1], /ba3a\/coffer/);
  assert.match(titles[2], /tagged engine/);
  assert.match(titles[3], /Core types/);
  assert.match(titles[4], /public content repository/);
  assert.match(titles[5], /Cloudflare/);
  assert.match(titles[6], /Deploy/);
  assert.match(titles[7], /Upgrade coffer/);
});

test('every action of every step asks the user to confirm, in its first lines', () => {
  assert.ok(actions.length >= 30, `${actions.length} actions`);
  for (const part of actions) {
    const firstLines = part.body.split('\n').filter((line) => line.trim() !== '');
    // The marker may follow a sentence or two that explain the action, but comes before any command.
    const marker = firstLines.findIndex((line) => line.includes(CONFIRM));
    const code = firstLines.findIndex((line) => line.startsWith('```'));
    assert.ok(marker >= 0 && marker <= 4, `"${part.title}" has the marker "${CONFIRM}" near its top`);
    assert.ok(code === -1 || marker < code, `"${part.title}" asks for confirmation before its first command`);
  }
});

test('every action is numbered in order inside its step', () => {
  for (const step of steps) {
    const number = step.title.split('.')[0];
    const own = actions.filter((part) => {
      const owner = [...steps].reverse().find((candidate) => candidate.line < part.line);
      return owner === step;
    });
    assert.deepEqual(
      own.map((part) => part.title.split(' ')[0]),
      own.map((_, index) => `${number}.${index + 1}`),
      `the actions of step ${number}`,
    );
  }
});

test('commands appear only inside the numbered steps', () => {
  const firstStep = parts.indexOf(steps[0]);
  const before = parts.slice(0, firstStep).map((part) => part.body).join('\n');
  assert.deepEqual(fences(before), [], 'no command before step 0');
  const lastStep = steps[steps.length - 1];
  const after = parts.slice(parts.indexOf(lastStep) + 1).filter((part) => part.level === 2);
  for (const part of after) assert.deepEqual(fences(part.body), [], `no command in "${part.title}"`);
});

test('the commands of the go-live are written out exactly', () => {
  const commands = fences(operations).join('\n');
  for (const needle of [
    'gh repo create ba3a/coffer --public',
    'sh scripts/split-coffer.sh\n',
    'sh scripts/split-coffer.sh --push',
    'git tag -a v0.1.0 -m "coffer 0.1.0"',
    'git push origin v0.1.0',
    'npm install',
    'npm test',
    'github:ba3a/coffer#v0.1.0',
    'delete p.workspaces',
    'git rm -r --quiet coffer',
    'gh repo create ba3a/ba3adev --public',
    'git remote add origin https://github.com/ba3a/ba3adev.git',
    'node scripts/cloudflare-setup.mjs --dry-run',
    'node scripts/cloudflare-setup.mjs\nnode scripts/cloudflare-setup.mjs\n',
    'npx coffer media push',
    'gh secret set CLOUDFLARE_API_TOKEN --repo ba3a/ba3adev',
    'git push -u origin main',
    'gh workflow disable refresh.yml',
    'gh workflow run deploy.yml',
    'gh workflow enable refresh.yml',
    'npm install github:ba3a/coffer#v0.2.0',
    'npm view wrangler@',
    'actionlint',
    'curl -sI https://ba3a.dev/build-info.json',
    'java -version',
    'ls-files -s gradlew',
  ]) {
    assert.ok(commands.includes(needle), `a command block contains ${JSON.stringify(needle)}`);
  }
  assert.match(action('1.2').body, /git subtree split --prefix=coffer -b coffer-export/);
});

test('git push --push and repository creation appear only under the actions that are meant to do them', () => {
  const pushAction = actions.find((part) => fences(part.body).some((block) => block.includes('split-coffer.sh --push')));
  assert.ok(pushAction?.title.startsWith('1.3 '), 'split-coffer.sh --push is in action 1.3 only');
  for (const part of actions) {
    const text = fences(part.body).join('\n');
    if (/gh repo create/.test(text)) assert.match(part.title, /^(1\.1|4\.1) /, `repository creation in "${part.title}"`);
    if (/git push -u origin main/.test(text)) assert.match(part.title, /^5\.9 /);
  }
  // The first push to main comes after the originals and the secrets.
  assert.ok(action('5.7').title !== '' && actions.indexOf(action('5.7')) < actions.indexOf(action('5.9')));
  assert.ok(actions.indexOf(action('5.8')) < actions.indexOf(action('5.9')));
  assert.match(action('5.10').body, /gh workflow disable refresh\.yml/);
});

test('the four GitHub secrets and the Cloudflare names are the ones the workflows and the setup script use', () => {
  const required = [...deploy.matchAll(/^ {6}([A-Z0-9_]+):\n {8}required: true/gm)].map((match) => match[1]).sort();
  assert.deepEqual(required, ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);
  const envExample = read('.env.local.example');
  for (const name of required) {
    assert.ok(operations.includes(name), `OPERATIONS.md names ${name}`);
    assert.match(envExample, new RegExp(`^${name}=`, 'm'));
    assert.ok(fences(action('5.8').body).join('\n').includes(`gh secret set ${name} --repo ba3a/ba3adev`), `${name} is set in 5.8`);
  }
  // Names of all variables the document mentions exist in .env.local.example.
  for (const name of new Set(operations.match(/\b(?:CLOUDFLARE|R2)_[A-Z0-9_]+\b/g) ?? [])) {
    assert.match(envExample, new RegExp(`^${name}=`, 'm'), `${name} is in .env.local.example`);
  }
  for (const name of ['ba3a-dev', 'my-ba3a-dev', 'ba3a-media', 'ba3a.dev', 'my.ba3a.dev']) {
    assert.ok(operations.includes(name), `OPERATIONS.md names ${name}`);
  }
  assert.ok(deploy.includes('--project-name ba3a-dev') && deploy.includes('--project-name my-ba3a-dev'));
  assert.match(read('coffer.yaml'), /bucket: ba3a-media/);
});

test('the wrangler pin named in the document is the one in deploy.yml', () => {
  const pin = /WRANGLER_VERSION: (\d+\.\d+\.\d+)/.exec(deploy)?.[1];
  assert.ok(pin, 'deploy.yml pins wrangler');
  assert.ok(operations.includes(`${pin}`), 'OPERATIONS.md names the pin');
  assert.ok(operations.includes(`npm view wrangler@${pin} version`), 'the check command uses the pin');
  assert.match(operations, /unverified|not checked/i, 'it says the pin was not verified');
});

test('the topics the runbook must cover are all there', () => {
  /** @type {[string, RegExp][]} */
  const topics = [
    ['R2 is enabled first', /Enable R2/],
    ['the bucket', /ba3a-media/],
    ['the originals are pushed before the first push to main', /before the first push to `main`/],
    ['the R2 S3 token', /R2 API token|Create API token/],
    ['the dry run comes before the real run and the repeat', /dry run[\s\S]*Run the setup script, then again/i],
    ['"Nothing to do" confirms the repeat', /Nothing to do: everything exists already/],
    ['a narrower token for CI', /narrower token/],
    ['the Pages projects and the custom domains', /Pages projects `ba3a-dev` and `my-ba3a-dev`/],
    ['the DNS CNAME check', /proxied CNAME/],
    ['actionlint', /actionlint/],
    ['JDK 21', /JDK 21/],
    ['the executable bit of gradlew', /gradlew[\s\S]*100755|100755[\s\S]*gradlew/],
    ['the content security policy', /content-security-policy/i],
    ['build-info.json is not cached', /no-cache/],
    ['the reference is served without a policy', /without a policy/],
    ['Refresh stays disabled until the first deploy is green', /Refresh workflow disabled until the first Deploy is green/],
    ['Refresh is enabled by hand', /Enable workflow/],
    ['the Refresh timing', /every 15 minutes[\s\S]*20 to 30 minutes[\s\S]*within an hour/],
    ['the keepalive rules', /30 days[\s\S]*1st of the month[\s\S]*best effort/],
    ['the manual recovery', /enable the workflow by hand[\s\S]*real commit/],
    ['the repository stays public', /Keep the repository public/],
    ['a W3C validator outage only warns', /W3C validator outage only warns/],
    ['npm test is not run before a deploy', /`npm test` is not run before a deploy/],
    ['the first npm install sets core.hooksPath', /first `npm install`[^.]*`core\.hooksPath`/],
    ['Lighthouse with the mobile profile, after asking', /Lighthouse[\s\S]*mobile[\s\S]*With your permission/],
    ['the seed posts and photos', /Replace the seed content[\s\S]*Photos/],
    ['the open confirmations', /Open questions for you[\s\S]*Faultory[\s\S]*LinkedIn[\s\S]*press kit/],
    ['analytics are off', /Analytics are off[\s\S]*coffer\.yaml[\s\S]*AUTHORING\.md/],
    ['the new tool project checklist', /\(AUTHORING\.md#adding-a-new-tool-project\)/],
    ['the blog ids stay', /blog ids `devlog` and `blog`/],
    ['no root LICENSE without the README sentence', /root `LICENSE`[\s\S]*`README\.md`/],
    ['the constraint on exports', /ERR_PACKAGE_PATH_NOT_EXPORTED/],
    ['the constraint on the files of a git dependency', /`files`[\s\S]*docs/],
  ];
  for (const [label, pattern] of topics) assert.match(operations, pattern, label);
});

test('every relative link leads to a file and, for Markdown, to a heading', () => {
  let checked = 0;
  for (const match of withoutFences(operations).matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [path, anchor] = target.split('#');
    const file = path === '' ? join(root, 'OPERATIONS.md') : resolve(root, path);
    assert.ok(existsSync(file), `the link "${target}" leads to ${relative(root, file)}, which does not exist`);
    if (anchor !== undefined && file.endsWith('.md')) {
      assert.ok(anchorsOf(readFileSync(file, 'utf8')).includes(anchor), `the link "${target}" leads to a heading that does not exist`);
    }
    checked += 1;
  }
  assert.ok(checked >= 8, `${checked} links checked`);
});

test('every npm script and repository path the document names exists', () => {
  for (const match of operations.matchAll(/\bnpm run ([\w:-]+)/g)) {
    assert.ok(match[1] in packageJson.scripts, `"npm run ${match[1]}" exists in package.json`);
  }
  const roots = /^(scripts|deploy|content|themes|generators|build-support|\.github)\//;
  let checked = 0;
  for (const match of operations.matchAll(/`([^`\s]+)`/g)) {
    const token = match[1].replace(/\/$/, '');
    if (token.includes('{') || token.includes('*') || token.includes('<') || token.includes('...') || token.includes('=')) continue;
    if (roots.test(token) || ['coffer.yaml', 'media.lock.json', '.env.local.example', 'README.md', 'AUTHORING.md', 'package.json', 'package-lock.json'].includes(token)) {
      assert.ok(existsSync(join(root, token)), `OPERATIONS.md names \`${token}\`, which does not exist`);
      checked += 1;
    }
  }
  assert.ok(checked >= 20, `${checked} paths checked`);
});

test('the deploy workflow and the setup script point at OPERATIONS.md without promising it for later', () => {
  const setup = read('scripts/cloudflare-setup.mjs');
  for (const [name, text] of /** @type {[string, string][]} */ ([['deploy.yml', deploy], ['cloudflare-setup.mjs', setup]])) {
    assert.match(text, /OPERATIONS\.md/, name);
    assert.doesNotMatch(text, /final step|written in the|will be written/i, `${name} does not say OPERATIONS.md is still to be written`);
  }
  assert.match(deploy, /see OPERATIONS\.md\./);
});

test('every mention of OPERATIONS.md in the other Markdown files is a link', () => {
  for (const name of ['AUTHORING.md', 'README.md']) {
    const text = withoutFences(read(name));
    assert.match(text, /\]\(OPERATIONS\.md[^)]*\)/, `${name} links to OPERATIONS.md`);
    const rest = text.replace(/\[OPERATIONS\.md\]\(OPERATIONS\.md[^)]*\)/g, '');
    assert.doesNotMatch(rest, /OPERATIONS\.md/, `${name} has a plain-text mention`);
  }
});

test('the changelog is ready to date, as the release step expects', () => {
  const changelog = read('coffer/CHANGELOG.md');
  assert.match(changelog, /^## 0\.1\.0 - YYYY-MM-DD$/m);
  assert.equal(JSON.parse(read('coffer/package.json')).version, '0.1.0');
  assert.match(operations, /git tag -a v0\.1\.0/);

  const dir = mkdtempSync(join(tmpdir(), 'operations-test-'));
  try {
    writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
    const command = fences(action('1.6').body)[0].split('\n').find((line) => line.startsWith('sed -i'));
    assert.ok(command, 'action 1.6 has the sed command');
    const result = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const dated = readFileSync(join(dir, 'CHANGELOG.md'), 'utf8');
    assert.match(dated, /^## 0\.1\.0 - \d{4}-\d{2}-\d{2}$/m);
    assert.doesNotMatch(dated, /YYYY-MM-DD/);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('the package.json edit of action 2.2 produces the pinned dependency and no workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-test-'));
  try {
    writeFileSync(join(dir, 'package.json'), read('package.json'));
    const command = fences(action('2.2').body)[0].split('\n').find((line) => line.startsWith('node -e'));
    assert.ok(command, 'action 2.2 has the node command');
    const result = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const edited = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    assert.equal(edited.workspaces, undefined);
    assert.deepEqual(edited.dependencies, { coffer: 'github:ba3a/coffer#v0.1.0' });
    assert.equal(edited.scripts.test, 'npm run test:scripts && npm run test:generators && npm run test:sites');
    assert.equal(edited.scripts.typecheck, undefined);
    assert.equal(edited.scripts['check:standalone'], undefined);
    assert.deepEqual(edited.devDependencies, packageJson.devDependencies);
    assert.equal(edited.scripts.build, packageJson.scripts.build);
    assert.ok(readFileSync(join(dir, 'package.json'), 'utf8').endsWith('}\n'));
    // The files removed with git rm exist now (this test is one of them), and the runbook names them all.
    const removed = ['scripts/check-coffer-standalone.mjs', 'scripts/test/check-coffer-standalone.test.mjs', 'scripts/test/operations.test.mjs'];
    const gitRm = fences(action('2.2').body).join('\n').split('\n').find((line) => line.startsWith('git rm '));
    assert.ok(gitRm, 'action 2.2 has the git rm command');
    for (const file of removed) {
      assert.ok(gitRm.split(' ').includes(file), `${file} is removed by 2.2`);
      assert.ok(existsSync(join(root, file)), `${file} exists before the split`);
    }
    assert.match(action('2.2').body, /operations\.test\.mjs`\. That test guards this runbook/, 'the runbook says why this test goes');
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

/** The files outside coffer/ that refer to the engine's folder: an import, a path built with join(), or a `coffer/...` mention. */
const ENGINE_REFERENCE = /(?<![\w.@/-])coffer\/(?!yaml\b)|\.\.\/coffer\/|join\((?:root|repository), 'coffer'/;

/** Files that match the pattern without referring to the engine's folder, or that the runbook deals with in another way. */
const NOT_ABOUT_THE_ENGINE_FOLDER = new Set([
  'scripts/test/make-placeholders.test.mjs', // 'coffer/card' is the key of the card picture of the project coffer
  'scripts/split-coffer.sh', // the script that splits the folder
  'scripts/test/split-coffer.test.mjs',
  'scripts/test/operations.test.mjs',
]);

/**
 * @param {string} directory
 * @param {string[]} found
 * @param {string} base The directory that holds `directory`.
 * @returns {string[]} The text files below the directory, as paths relative to the base.
 */
function textFiles(directory, found = [], base = root) {
  for (const entry of readdirSync(join(base, directory))) {
    if (['node_modules', '.git', '.cache', 'dist', '.coffer'].includes(entry)) continue;
    const path = `${directory}/${entry}`;
    if (statSync(join(base, path)).isDirectory()) textFiles(path, found, base);
    else if (/\.(mjs|js|md|yaml|yml|njk|css|json|sh)$/.test(entry) && !/(package-lock|media\.lock)\.json$/.test(entry)) found.push(path);
  }
  return found;
}

test('step 2 names every file that refers to the folder of the engine', () => {
  const step = steps.find((part) => part.title.startsWith('2.'));
  assert.ok(step);
  const stepText = parts
    .filter((part) => part.line >= step.line && part.line < (steps.find((candidate) => candidate.line > step.line)?.line ?? Infinity))
    .map((part) => part.body)
    .join('\n');
  const files = [
    ...['scripts', 'generators', 'themes', 'deploy', '.github', 'content'].flatMap((directory) => textFiles(directory)),
    'AUTHORING.md',
    'README.md',
    'coffer.yaml',
    'package.json',
  ];
  const references = files.filter((file) => !NOT_ABOUT_THE_ENGINE_FOLDER.has(file) && ENGINE_REFERENCE.test(read(file)));
  assert.ok(references.length >= 30, `${references.length} files refer to the folder`);
  const missing = references.filter((file) => !stepText.includes(file));
  assert.deepEqual(missing, [], 'these files refer to the engine folder but step 2 does not name them');
  // And the other way round: a named script or test still has a reference, or is deleted by the step.
  for (const file of stepText.match(/`((?:scripts|generators|themes|content)\/[^`\s]+)`/g) ?? []) {
    const path = file.slice(1, -1);
    if (path.includes('*') || path.includes('{')) continue;
    assert.ok(existsSync(join(root, path)), `${path} named in step 2 exists`);
  }
});

test('the sed commands of action 2.3 do what the runbook says, on a copy of the files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'operations-test-'));
  try {
    for (const name of ['scripts', 'generators', 'themes']) cpSync(join(root, name), join(dir, name), { recursive: true });
    for (const name of ['AUTHORING.md', 'README.md', 'coffer.yaml']) cpSync(join(root, name), join(dir, name));
    // The text files of the other folders that the final check of 2.6 reads.
    for (const name of ['content', 'deploy', '.github', 'build-support']) {
      cpSync(join(root, name), join(dir, name), {
        recursive: true,
        filter: (source) => statSync(source).isDirectory() || /\.(mjs|js|md|yaml|yml|njk|css|json|sh)$/.test(source),
      });
    }
    // Step 2.2 deletes these files first: the standalone check with its test, and this very test, which cannot pass after the split.
    rmSync(join(dir, 'scripts', 'check-coffer-standalone.mjs'));
    rmSync(join(dir, 'scripts', 'test', 'check-coffer-standalone.test.mjs'));
    rmSync(join(dir, 'scripts', 'test', 'operations.test.mjs'));

    const commands = fences(action('2.3').body)[0].split('\n').filter((line) => line.trim() !== '');
    assert.equal(commands.length, 5);
    for (const command of commands) {
      const result = spawnSync('sh', ['-c', command], { cwd: dir, encoding: 'utf8' });
      assert.equal(result.status, 0, `${command}\n${result.stderr}`);
    }

    const changed = ['scripts', 'generators', 'themes'].flatMap((name) => textFiles(name, [], dir)).concat(['AUTHORING.md', 'README.md', 'coffer.yaml']);
    const stale = [];
    for (const file of changed) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const text = readFileSync(path, 'utf8');
      for (const [number, line] of text.split('\n').entries()) {
        if (/\.\.\/coffer\/src\/|join\((?:root|repository), 'coffer'|read\('coffer\/|(?<![\w.@/-])coffer\/docs\//.test(line) && !/RegExp|assert\.(match|doesNotMatch)|const ENGINE_REFERENCE/.test(line)) {
          stale.push(`${file}:${number + 1}: ${line.trim().slice(0, 100)}`);
        }
      }
    }
    assert.deepEqual(stale, [], 'no reference to the engine folder is left that the commands should have changed');

    // The final check of 2.6 reports what the commands cannot change, and 2.4 names every one of those files for a hand edit.
    const grep = fences(action('2.6').body)[0].split('\n').find((line) => line.startsWith('git grep'));
    assert.ok(grep, 'action 2.6 has the git grep command');
    assert.doesNotMatch(grep, /operations\.test/, 'the grep does not exclude the test that action 2.2 deletes');
    const found = spawnSync('sh', ['-c', grep.replace('git grep', 'git grep --no-index')], { cwd: dir, encoding: 'utf8' });
    assert.ok(found.status === 0 || found.status === 1, found.stderr);
    const leftovers = [...new Set(found.stdout.split('\n').filter(Boolean).map((line) => line.slice(0, line.indexOf(':'))))];
    assert.ok(leftovers.length >= 5, `the grep reports ${leftovers.length} files before the hand edits`);
    const byHand = action('2.4').body;
    assert.deepEqual(
      leftovers.filter((file) => !byHand.includes(`\`${file}\``)),
      [],
      'the grep reports files that action 2.4 does not name',
    );
    // The patterns of the grep do not match what the commands of 2.3 wrote.
    assert.doesNotMatch(found.stdout, /node_modules\/coffer|'node_modules', 'coffer'/, 'the installed engine is not reported');

    // Every import of the installed engine leads to a file that exists in coffer/, and the changed scripts still parse.
    let imports = 0;
    for (const file of changed.filter((name) => name.endsWith('.mjs'))) {
      const text = readFileSync(join(dir, file), 'utf8');
      for (const match of text.matchAll(/(?:\.\.\/)+node_modules\/coffer\/(src\/[\w./-]+\.js)/g)) {
        assert.ok(existsSync(join(root, 'coffer', match[1])), `${file} imports coffer/${match[1]}, which exists`);
        imports += 1;
      }
      const check = spawnSync(process.execPath, ['--check', join(dir, file)], { encoding: 'utf8' });
      assert.equal(check.status, 0, `${file} still parses: ${check.stderr}`);
    }
    assert.ok(imports >= 15, `${imports} imports of the installed engine`);

    // The links to the docs point at the tag and keep their file names.
    const authoring = readFileSync(join(dir, 'AUTHORING.md'), 'utf8');
    assert.match(authoring, /\]\(https:\/\/github\.com\/ba3a\/coffer\/blob\/v0\.1\.0\/docs\/README\.md\)/);
    assert.doesNotMatch(authoring, /https:\/\/github\.com\/ba3a\/coffer\/blob\/v0\.1\.0\/docs\/https/);
    for (const match of authoring.matchAll(/blob\/v0\.1\.0\/docs\/([\w.-]+\.md)/g)) {
      assert.ok(existsSync(join(root, 'coffer', 'docs', match[1])), `the page docs/${match[1]} exists in the engine`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('the runbook lives next to the files it names: the split script is executable text with the options it mentions', () => {
  assert.ok(existsSync(join(root, 'scripts', 'split-coffer.sh')));
  const script = read('scripts/split-coffer.sh');
  for (const option of operations.match(/split-coffer\.sh (--[a-z]+)/g) ?? []) {
    assert.ok(script.includes(option.split(' ')[1]), `the script knows ${option}`);
  }
  assert.equal(dirname('scripts/split-coffer.sh'), 'scripts');
});

test('the checks of the review: git credentials, npm pack output, a labelled branch change, files to keep private, the link threshold', () => {
  // 0.1 makes gh the credential helper, because 1.3 pushes over HTTPS by URL.
  assert.match(fences(action('0.1').body).join('\n'), /^gh auth setup-git$/m);
  assert.match(read('scripts/split-coffer.sh'), /https:\/\/github\.com\/ba3a\/coffer\.git/);
  // npm writes the list of files to stderr, so the pipe needs 2>&1.
  const pack = fences(action('1.4').body).join('\n').split('\n').find((line) => line.startsWith('npm pack'));
  assert.ok(pack, 'action 1.4 has the npm pack command');
  assert.match(pack, /^npm pack --dry-run 2>&1 \| grep -E /);
  assert.match(action('1.4').body, /both lines must be printed/);
  // 2.1 creates a branch, so its title is not "read only".
  assert.doesNotMatch(action('2.1').title, /read only/i);
  assert.match(fences(action('2.1').body).join('\n'), /^git switch -c chore\/use-coffer-0\.1\.0/m);
  // 4.1 asks the user to decide about the tracked files that are not part of the sites.
  for (const file of ['site-spec.md', '.claude/settings.json', '.claude/specloop/config.json']) {
    assert.ok(action('4.1').body.includes(`\`${file}\``), `4.1 asks about ${file}`);
  }
  // The link test of AUTHORING.md counts links; 2.4 lowers its threshold to what is left after 2.3.
  assert.ok(action('2.4').body.includes('`checked >= 20`'));
  assert.ok(read('scripts/test/authoring-docs.test.mjs').includes('checked >= 20, `only ${checked} links were checked`'), 'the threshold named in 2.4 exists');
  assert.ok(action('2.4').body.includes('`checked >= 5`'));
});
