// Removes the output of the previous `npm run test:sites`, so that a stale file
// can never hide a problem in the next build. The paths are fixed and the script
// takes no arguments. On Windows an indexer or antivirus can hold a file for a
// moment, so a failed removal is retried.
//
// The stored results of the reference generators (`.cache/reference`) and the
// clones of the docs sources (`.cache/repos`) are kept. coffer keys a stored
// reference by the commit of the docs source, the configuration of the command
// and the contents of the scripts the command names through `{site}`, so an edit
// to a generator or to an init script in this repository is picked up without
// removing anything. Keeping them matters: the API reference of roto-core is a
// Gradle build that takes minutes.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

for (const path of ['../.cache/test-dist']) {
  rmSync(fileURLToPath(new URL(path, import.meta.url)), {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
