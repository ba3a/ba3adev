# roto-mini

A small, hand-written stand-in for the `ba3a/roto` repository, used by
`scripts/site-test/roto-docs.test.mjs`:

- `repo/docs/` is a guide that names roto-core types in inline code. The real
  guides of roto name none yet, so this is how the linking from guides to the
  reference is verified until they do.
- `repo/roto-core/build/dokka/html/` is a tiny copy of the shape of the HTML
  that Dokka 2 writes for `roto-core` (`scripts/pages.json` holds records taken
  from a real run, the pages are reduced to a heading and a signature).
- `repo/fake-gradle.mjs` prints what Gradle prints for declarations without
  KDoc, so the build report can be checked without running Gradle.
