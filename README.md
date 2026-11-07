# ba3a.dev

This is the content repository of two static sites, built with the coffer engine and published to Cloudflare Pages by a push to `main`:

- **ba3a.dev** (English): projects, project documentation and a devlog.
- **my.ba3a.dev** (Russian): a personal blog about woodworking and hiking.

The engine, coffer, lives in [coffer/](coffer/README.md) for now and is meant to move to its own repository. Everything else here is configuration, themes and content for the two sites.

To write a post, add a project or set up a new computer, read [AUTHORING.md](AUTHORING.md).

To go live, run the sites or upgrade the engine, read [OPERATIONS.md](OPERATIONS.md).

## Structure

| Path | What it holds |
| ---- | ------------- |
| `content/ba3a.dev/`, `content/my.ba3a.dev/` | Posts, project declarations and texts, the home page, `tags.yaml` and `series.yaml` of each blog. |
| `themes/ba3a/`, `themes/my/` | The look of each site: templates, styles, fonts and strings. |
| `coffer.yaml` | The configuration of both sites and of the media store. |
| `media.lock.json` | The list, by content hash, of the original photos and videos, which are kept in a private R2 bucket and not in git. |
| `generators/` | Scripts that generate project references (for specloop). |
| `build-support/` | Files the project reference builds need (the Dokka setup for roto). |
| `scripts/` | Repository scripts: git hook setup, placeholder pictures, deploy preparation, the Cloudflare setup, the split of the engine into its own repository, and their tests. |
| `deploy/` | Response headers for Cloudflare Pages. |
| `.github/workflows/` | Deploy, scheduled refresh and keepalive workflows. |
| `coffer/` | The engine: source, tests, documentation (`coffer/docs/`) and its example site. |

## Commands

Install with `npm install` (see [AUTHORING.md](AUTHORING.md#set-up-a-new-computer) for the one setup step, `.env.local`). Node 24 is required.

| Command | What it does |
| ------- | ------------ |
| `npm run dev` | Previews both sites with live reload, drafts and scheduled posts included. |
| `npm run new -- devlog "Title"` | Creates a draft post (`blog` is the id of the blog of my.ba3a.dev). |
| `npm run build` | Builds both sites into `dist/`. |
| `npm run check` | Checks the finished build in `dist/`. |
| `npm test` | Runs the engine tests, the script and generator tests, and builds and checks both sites. |
| `npm run typecheck` | Type-checks the engine. |

`npm test` needs a network (the roto and specloop documentation is cloned from their public repositories), JDK 21 (the roto API reference is generated with Gradle and Dokka) and the seed photos, which it restores itself. The engine part takes around 13 minutes. Further scripts are `test:scripts`, `test:generators`, `test:sites` and `check:standalone`.

## Licenses

- The **content** of the sites (texts, photos, project pages) is all rights reserved. The footers of both sites say so.
- The **engine** in `coffer/` is released under the Apache License 2.0; see [coffer/LICENSE](coffer/LICENSE) and [coffer/NOTICE](coffer/NOTICE).
- The rest of the repository (themes, scripts, configuration) is not part of the engine and is not covered by its license. This repository has no license file of its own.
