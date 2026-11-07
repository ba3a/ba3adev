// Tests for scripts/build-summary.mjs, which turns the report of a build into the job summary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderBuildSummary, summarizeReportFile } from '../build-summary.mjs';

const script = fileURLToPath(new URL('../build-summary.mjs', import.meta.url));

test('an empty report says that nothing was found', () => {
  const text = renderBuildSummary({ errors: [], warnings: [], exactLocations: [], info: [] });
  assert.match(text, /^## Build report/);
  assert.match(text, /### Posts publishing exact locations\n\nNone\./);
  assert.match(text, /### Undocumented elements of the generated references\n\nNone\./);
  assert.doesNotMatch(text, /Other warnings|### Errors/);
});

test('exact locations are listed with their image and track counts', () => {
  const text = renderBuildSummary({
    exactLocations: [
      { site: 'my.ba3a.dev', file: 'content/my.ba3a.dev/hike/index.md', images: 3 },
      { site: 'my.ba3a.dev', file: 'content/my.ba3a.dev/ridge/index.md', images: 0, tracks: 1 },
    ],
  });
  assert.match(text, /2 post\(s\) publish exact locations/);
  assert.match(text, /- my\.ba3a\.dev: content\/my\.ba3a\.dev\/hike\/index\.md: 3 image\(s\)/);
  assert.match(text, /- my\.ba3a\.dev: content\/my\.ba3a\.dev\/ridge\/index\.md: 1 track\(s\)/);
});

test('undocumented elements are separated from the other warnings', () => {
  const text = renderBuildSummary({
    warnings: [
      { site: 'ba3a.dev', message: 'content/ba3a.dev/projects/roto/project.yaml: docs.reference: "ProjectPalette" has no documentation' },
      { site: 'my.ba3a.dev', message: 'content/my.ba3a.dev/tags.yaml: hiking: no published post uses this tag, entry ignored' },
    ],
  });
  const undocumented = text.slice(text.indexOf('### Undocumented'), text.indexOf('### Other warnings'));
  assert.match(undocumented, /1 element\(s\) without documentation/);
  assert.match(undocumented, /"ProjectPalette" has no documentation/);
  assert.doesNotMatch(undocumented, /hiking/);
  assert.match(text, /### Other warnings \(1\)\n\n- my\.ba3a\.dev: .*hiking/);
});

test('errors are shown when there are some, and Markdown characters in messages are neutralised', () => {
  const text = renderBuildSummary({ errors: [{ message: 'bad <b> `code` | pipe\nsecond line' }] });
  assert.match(text, /### Errors \(1\)/);
  assert.match(text, /- bad \\<b\\> \\`code\\` \\\| pipe second line/);
});

test('links, mentions and backslashes in messages are neutralised too', () => {
  const text = renderBuildSummary({ errors: [{ message: 'see [x](https://example.test) by @someone and a\\b' }] });
  assert.ok(text.includes('- see \\[x\\]\\(https://example.test\\) by \\@someone and a\\\\b'), text);
});

test('a missing or broken report file is explained, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'build-summary-'));
  try {
    assert.match(summarizeReportFile(join(dir, 'none.json')), /No build report was found/);
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{');
    assert.match(summarizeReportFile(broken), /could not be read/);
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ errors: [], warnings: [], exactLocations: [], info: [] }));
    const run = spawnSync(process.execPath, [script, '--report', good], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /## Build report/);
    assert.equal(spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' }).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
