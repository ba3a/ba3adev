// Removes the output of the previous `npm run test:sites`, so that a stale file
// can never hide a problem in the next build. The path is fixed and takes no
// arguments. On Windows an indexer or antivirus can hold a file for a moment,
// so a failed removal is retried.
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

rmSync(fileURLToPath(new URL('../.cache/test-dist', import.meta.url)), {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
});
