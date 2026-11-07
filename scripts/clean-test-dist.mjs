// Removes the output of the previous `npm run test:sites`, so that a stale file
// can never hide a problem in the next build. The paths are fixed and the script
// takes no arguments. On Windows an indexer or antivirus can hold a file for a
// moment, so a failed removal is retried.
//
// Besides the output it removes the stored results of the reference generators
// (`.cache/reference`). coffer keys such a result by the commit of the docs
// source and the configuration of the command, not by the contents of the
// generator script, so without this a change to a script in generators/ would
// not reach the tests until the source repository changed. The generators are
// fast; the clones of the docs sources (`.cache/repos`) are kept, so the tests
// fetch each repository once, not on every run.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const path of ['../.cache/test-dist', '../.cache/reference']) {
  rmSync(fileURLToPath(new URL(path, import.meta.url)), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
