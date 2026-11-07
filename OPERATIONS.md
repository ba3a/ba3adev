# Operations

The go-live runbook and the notes for running the two sites. Writing posts is in [AUTHORING.md](AUTHORING.md).

Nothing in this file has been run. The work that built this repository created no GitHub repository, pushed nothing and called no Cloudflare or GitHub service. You run the steps below, in order. Every action is marked **User confirms before running.**: read the command, check the names, then run it yourself.

Conventions:

- Commands are for a POSIX shell. On Windows use Git Bash (it has `sh`, `sed`, `xargs` and `git subtree`).
- `<...>` is a value you fill in. Secrets are never put on a command line: `gh secret set NAME` asks for the value, and `.env.local` is git-ignored.
- GitHub owner `ba3a`. Repositories: `ba3a/coffer` (the engine), `ba3a/ba3adev` (this repository, the content), `ba3a/roto` and `ba3a/specloop` (projects, already public).
- Cloudflare names: Pages projects `ba3a-dev` and `my-ba3a-dev`, R2 bucket `ba3a-media`, custom domains `ba3a.dev` and `my.ba3a.dev`.

| Step | What | Where |
| ---- | ---- | ----- |
| 0 | Checks, merge to `main`, verify the pins | this repository |
| 1 | Publish the engine as `ba3a/coffer` and tag `v0.1.0` | `ba3a/coffer` |
| 2 | Use the tagged engine here and drop `coffer/` | this repository |
| 3 | Add a "Core types" section to the roto guides | `ba3a/roto` |
| 4 | Create the public content repository | `ba3a/ba3adev` |
| 5 | Cloudflare, secrets, originals, first push | Cloudflare, `ba3a/ba3adev` |
| 6 | Deploy and check the live sites | `ba3a/ba3adev` |
| 7 | Upgrade the engine later | this repository |

After the steps: [things to know](#things-to-know), [replace the seed content](#replace-the-seed-content), [open questions](#open-questions-for-you), [a new tool project](#a-new-tool-project).

## 0. Before you start

### 0.1 Check the tools and the git credentials

**User confirms before running.**

```sh
node --version          # v24 or newer
git --version
git subtree -h          # prints the usage; "not a git command" means git-subtree is missing
gh auth status          # logged in as ba3a, with repo and workflow scopes
java -version           # 21, needed by npm test and the roto reference
```

The first block only reads. The pushes in 1.3, 1.4 and 3.2 go over HTTPS and need credentials; without a credential helper they prompt or fail. This command makes `gh` the git credential helper for github.com, and changes your global git configuration:

**User confirms before running.**

```sh
gh auth setup-git
```

### 0.2 Merge the work into `main`

The work lives on `specloop/ba3a-dev-personal-site`. The first push to GitHub is `main`.

**User confirms before running.**

```sh
git status --short                                  # prints nothing
git switch main
git merge --ff-only specloop/ba3a-dev-personal-site
```

### 0.3 Verify the pins and lint the workflows (read only)

The wrangler version in `.github/workflows/deploy.yml` (`WRANGLER_VERSION`, 4.20.0) was not checked against the registry, and neither were the versions of the actions. A wrong pin makes the first deploy fail.

**User confirms before running.**

```sh
npm view wrangler@4.20.0 version        # prints 4.20.0; an error means the pin is wrong
npm view wrangler dist-tags.latest      # newest version, to decide whether to move the pin
grep -h "uses:" .github/workflows/*.yml | sort -u
gh api repos/actions/checkout/git/ref/tags/v7 --jq .ref   # repeat for every owner/repo@tag listed above
actionlint .github/workflows/*.yml      # install from https://github.com/rhysd/actionlint
```

To move the pin, change the number of `WRANGLER_VERSION` in `deploy.yml` (nothing else mentions it besides a test that reads the same line).

### 0.4 Check the roto repository (read only)

The roto reference runs `./gradlew` in a clone of `ba3a/roto` on a Linux runner with JDK 21, so the wrapper must be executable in git.

**User confirms before running.**

```sh
git clone https://github.com/ba3a/roto.git ../roto
git -C ../roto ls-files -s gradlew      # must start with 100755
```

If it says `100644`, fix it in step 3: `git -C ../roto update-index --chmod=+x gradlew` and commit it together with the guide change.

## 1. Publish the engine as ba3a/coffer

### 1.1 Create the public repository

**User confirms before running.**

```sh
gh repo create ba3a/coffer --public --description "A static site engine for a person who makes things and writes about them."
```

Create it empty: no README, no license, no `.gitignore`.

### 1.2 Split the history of `coffer/` into a local branch

[`scripts/split-coffer.sh`](scripts/split-coffer.sh) runs `git subtree split --prefix=coffer -b coffer-export`. It makes only the local branch `coffer-export`, with the files of `coffer/` at its root, and contacts no remote. It stops when the working tree has changes. It takes about a minute on Windows.

**User confirms before running.**

```sh
sh scripts/split-coffer.sh
git log --oneline coffer-export | head
git ls-tree --name-only coffer-export     # package.json, src, docs, ... and no coffer/ directory
```

### 1.3 Push the branch to the new repository

The script pushes only when you give `--push`. It pushes `coffer-export` to `main` of `https://github.com/ba3a/coffer.git`, never forced.

**User confirms before running.**

```sh
sh scripts/split-coffer.sh --push
```

The first CI run of `ba3a/coffer` fails at `npm ci`: the repository has no lock file yet. That is expected.

### 1.4 Generate the lock file and ship the docs with the package

A git dependency installs only what the `files` list of `package.json` names (plus `package.json` and the readme), and `files` does not name `docs/` or `CHANGELOG.md`. The tests in this repository read `docs/` of the engine after the split (step 2), so add both to `files` now, before the tag.

**User confirms before running.**

```sh
git clone https://github.com/ba3a/coffer.git ../coffer-repo
cd ../coffer-repo
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.files.push('docs','CHANGELOG.md');fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
npm install                                # writes package-lock.json
npm pack --dry-run 2>&1 | grep -E "docs/README.md|CHANGELOG.md"     # npm lists the files on stderr; both lines must be printed
npm test
git add package.json package-lock.json
git commit -m "build: Add the lock file and ship the docs and the changelog with the package"
git push origin main
```

### 1.5 Wait for the CI of ba3a/coffer (read only)

The lock file was made on one system. CI runs on Ubuntu and Windows, so both jobs passing shows that it works on both.

**User confirms before running.**

```sh
gh run list --repo ba3a/coffer --limit 3
gh run watch --repo ba3a/coffer <id of the newest run>
```

Do not go on until both jobs of the newest run are green.

### 1.6 Date the release, tag and push `v0.1.0`

The changelog has the heading `## 0.1.0 - YYYY-MM-DD`, and `package.json` says `0.1.0`.

**User confirms before running.**

```sh
sed -i "s/^## 0\.1\.0 - YYYY-MM-DD$/## 0.1.0 - $(date +%F)/" CHANGELOG.md
git diff CHANGELOG.md
git commit -am "docs: Date the 0.1.0 release"
git push origin main
gh run watch --repo ba3a/coffer <id of the newest run>     # green again
git tag -a v0.1.0 -m "coffer 0.1.0"
git push origin v0.1.0
git ls-remote --tags origin v0.1.0
cd -
```

Later, delete the helper branch and clone: `git branch -D coffer-export` and remove `../coffer-repo`.

## 2. Use the tagged engine in this repository

Until now `coffer/` is a workspace member. The tag exists, so the sites depend on it and `coffer/` goes.

**Constraints that come from the layout:**

- The `exports` of coffer allow only `.` and `./package.json`. A bare import such as `coffer/src/config.js` fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. The repository scripts and tests use the internals of the engine, so they import by file path: `../node_modules/coffer/src/...`. A relative path is not subject to `exports`.
- `node_modules/coffer` holds only the files in `files` of coffer's `package.json` (`bin`, `src`, `theme`, `i18n`, `LICENSE`, `NOTICE`, plus `docs` and `CHANGELOG.md` after step 1.4). `.github/`, `test/` and `example/` are not there.
- Documentation links such as `coffer/docs/images.md` no longer lead to a file in this repository. They become GitHub links to the tag.
- Unverified: npm may record `resolved` as `git+ssh://git@github.com/ba3a/coffer.git#<commit>` for the `github:` form. A CI runner has no SSH key. Check `package-lock.json` after `npm install`; if it says `git+ssh`, change the dependency to `git+https://github.com/ba3a/coffer.git#v0.1.0` and run `npm install` again.

### 2.1 Check the tag exists and make a branch

**User confirms before running.**

```sh
git ls-remote --tags https://github.com/ba3a/coffer.git v0.1.0     # reads only; must print a line
git switch -c chore/use-coffer-0.1.0                               # makes the working branch
```

### 2.2 Switch the dependency, remove the workspace and the engine scripts

This edits `package.json`: removes `workspaces`, adds `"coffer": "github:ba3a/coffer#v0.1.0"` to `dependencies`, drops `npm test -w coffer` from `test`, and removes the scripts `typecheck` and `check:standalone`. It also deletes the two files of the standalone check, which exist only for the `coffer/` folder (the engine's own CI replaces it), and `scripts/test/operations.test.mjs`. That test guards this runbook while the engine is still in `coffer/`: it checks the numbering of the steps, the file lists of step 2 and the `sed` lines of 2.3 on a copy of the files. After the split it cannot pass, because it reads `coffer/` itself, so it goes with the folder.

**User confirms before running.**

```sh
node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));delete p.workspaces;p.dependencies={coffer:'github:ba3a/coffer#v0.1.0'};p.scripts.test='npm run test:scripts && npm run test:generators && npm run test:sites';delete p.scripts.typecheck;delete p.scripts['check:standalone'];fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
git rm scripts/check-coffer-standalone.mjs scripts/test/check-coffer-standalone.test.mjs scripts/test/operations.test.mjs
```

### 2.3 Point the scripts and tests at the installed engine

Run these in this order, from the repository root. The first line is the imports, the second the paths built with `join(root, 'coffer', ...)` and `join(repository, 'coffer', ...)`, the third the reads of `coffer/...` files, the last two the links and mentions of `coffer/docs/` in Markdown, comments and configuration. Mentions that are not links get the address without `https://`, because `scripts/make-placeholders.mjs` must contain no URL (its test checks that).

**User confirms before running.**

```sh
grep -rlE "\.\./coffer/src/" scripts generators | xargs sed -i -E 's#((\.\./)+)coffer/src/#\1node_modules/coffer/src/#g'
grep -rlE "join\((root|repository), 'coffer'" scripts | xargs sed -i -E "s#join\((root|repository), 'coffer'#join(\1, 'node_modules', 'coffer'#g"
grep -rlF "read('coffer/" scripts | xargs sed -i "s#read('coffer/#read('node_modules/coffer/#g"
sed -i 's#](coffer/docs/#](https://github.com/ba3a/coffer/blob/v0.1.0/docs/#g' AUTHORING.md README.md
grep -rlE "coffer/docs/" AUTHORING.md README.md themes coffer.yaml generators scripts | xargs sed -i -E 's#(^|[^/[:alnum:]_.-])coffer/docs/#\1github.com/ba3a/coffer/blob/v0.1.0/docs/#g'
```

Files these lines change:

- Imports of `../coffer/src/...`: `generators/test/specloop-reference.test.mjs`, `scripts/build-summary.mjs`, `scripts/cloudflare-setup.mjs`, `scripts/make-placeholders.mjs`, `scripts/prepare-deploy.mjs`, `scripts/prepare.mjs`, `scripts/site-test/projects.test.mjs`, `scripts/site-test/roto-docs.test.mjs`, `scripts/test/authoring-docs.test.mjs`, `scripts/test/media-config.test.mjs`, `scripts/test/seed-photos.test.mjs`, `scripts/test/smoke-test.test.mjs`.
- Paths into the engine folder: `scripts/prepare.mjs` (the `coffer` executable), `scripts/site-test/ba3a-theme.test.mjs` and `scripts/site-test/my-theme.test.mjs` (the engine theme), `scripts/site-test/seed-posts.test.mjs` (the executable), `scripts/test/authoring-docs.test.mjs` (executable, `package.json`, `LICENSE`, `docs/posts.md`), `scripts/test/refresh-workflow.test.mjs` (`src/cli.js`, `docs/scheduling.md`), `scripts/site-test/coffer-docs.test.mjs` (the `docs` folder).
- Links and mentions of `coffer/docs/`: `AUTHORING.md`, `README.md`, `coffer.yaml`, `generators/specloop-reference.mjs`, `scripts/make-placeholders.mjs`, `scripts/site-test/roto-docs.test.mjs`, `scripts/site-test/specloop-docs.test.mjs`, and the comments of `themes/ba3a/README.md`, `themes/ba3a/theme.yaml`, `themes/ba3a/assets/ba3a.css`, `themes/ba3a/templates/base.njk`, `themes/my/README.md`, `themes/my/theme.yaml`, `themes/my/assets/my.css`, `themes/my/templates/base.njk`.

### 2.4 Edit by hand what the commands cannot do

**User confirms before running.**

1. `content/ba3a.dev/projects/coffer/project.yaml`: replace everything from the comment `# The docs are built from the engine's own folder ...` (above `docs:`) down to the line `github: ba3a/coffer` with this, and keep `guides` as it is. The address gives the GitHub repository, so `github:` goes, and so does the GO-LIVE comment. Delete the comment `# The repository does not exist yet: ...` above `repo:` too. Then set the real `status` (see [open questions](#open-questions-for-you)).

   ```yaml
   # The guides are the files of docs/ in ba3a/coffer. docs/README.md is the
   # documentation index, and `order` follows the table of contents in that README.
   # There is no reference for now; a later edit of this file can add one.
   docs:
     source:
       git: https://github.com/ba3a/coffer.git
       ref: main
   ```

2. `scripts/site-test/coffer-docs.test.mjs`: the first test describes the folder source; make it expect `{ git: 'https://github.com/ba3a/coffer.git', ref: 'main' }`, no `github` key, and no `GO-LIVE` comment, and drop the `existsSync` of the folder. In the second test, expect `project.docs.source.type === 'git'`, and in its last `deepEqual` write "docs folder" instead of "coffer/docs" in the message. Replace the header comment about the folder source (the paragraph that says the repository does not exist yet) with the line `// The docs source of coffer is a git address, like the ones of roto and specloop.` The reads of the docs folder already point at `node_modules/coffer/docs` after step 2.3, which is why step 1.4 adds `docs` to `files`.
3. `scripts/test/deploy-workflow.test.mjs`: the test "every action is pinned ..." reads `coffer/.github/workflows/ci.yml`, which the package does not contain. Remove the comparison with the engine's CI and keep the pin check.
4. `scripts/test/authoring-docs.test.mjs`: remove `coffer` from the `roots` expression ("every repository path the documents name in code exists") and `'coffer/'` from the list in the README test. In the test "every relative link of the documents leads to a file ...", change `checked >= 20` to `checked >= 5`: the links into `coffer/docs/` became absolute in 2.3 and are no longer checked, which leaves 6 relative links.
5. `README.md`: delete the row `coffer/` from the structure table and the row `npm run typecheck` from the commands table; replace the sentence "The engine, coffer, lives in [coffer/](coffer/README.md) for now ..." with "The engine, coffer, is a separate project, [ba3a/coffer](https://github.com/ba3a/coffer), pinned in `package.json`."; in the licenses list, link `LICENSE` and `NOTICE` to `https://github.com/ba3a/coffer/blob/v0.1.0/LICENSE` and `.../NOTICE` and say "The engine, coffer,"; drop `check:standalone` from the list of scripts. `README.md` and `AUTHORING.md` say that the engine tests take about 13 minutes (`grep -n "13 minutes" README.md AUTHORING.md`); `npm test` no longer runs them, so fix the numbers after your first run.
6. `themes/my/i18n/ru.yaml`: the comment names `coffer/i18n/ru.yaml`; write "`i18n/ru.yaml` of coffer" instead.
7. `AUTHORING.md`, line 3: the link text `[coffer/docs]` becomes `[the coffer docs]`. Nothing else in it mentions the folder after step 2.3; check with the command in 2.6.

### 2.5 Remove the folder, install and test

`npm install` runs `scripts/prepare.mjs`, which sets `core.hooksPath` (hooks for the media originals) and pulls originals when `.env.local` has credentials. `npm test` needs a network and JDK 21 and takes about 14 minutes.

**User confirms before running.**

```sh
git rm -r --quiet coffer
rm -rf coffer
npm install
grep -n "ba3a/coffer" package-lock.json | head -3      # see the constraint about git+ssh above
npm test
```

### 2.6 Check for leftovers, then commit

**User confirms before running.**

```sh
git grep -nE "(^|[^/[:alnum:]_.-])coffer/($|[^[:alnum:]_.-]|(src|bin|docs|theme|i18n|test|example|LICENSE|NOTICE|CHANGELOG|README|package\.json))|(root|repository), 'coffer'|\.\./coffer" -- . ":!OPERATIONS.md" ":!package-lock.json" ":!scripts/split-coffer.sh" ":!scripts/test/split-coffer.test.mjs"
git add -A
git commit -m "build: Use coffer 0.1.0 from its own repository"
git switch main
git merge --ff-only chore/use-coffer-0.1.0
```

The `git grep` finds a `coffer/` folder reference, or a path built for it, that is not part of an address or of `node_modules/coffer/...`. It must print nothing after 2.3 and 2.4. A line it prints is a reference that still needs an edit. The split script and its test are left out on purpose: they describe the split and keep working. You may delete them once the split is done. Then edit this file: mark steps 1 and 2 as done, or delete them.

## 3. Add "Core types" to the roto guides

The guide-to-reference links need a roto-core type name in the guides, and the current guides name none. Inline code that is exactly the name of one type becomes a link to its reference page on the live site, or `[text](ref:Name)` links explicitly.

### 3.1 Write the section

**User confirms before running.**

In `../roto/docs/pipeline.md` (cloned in 0.4) add a section like this, with the types you want to feature. These exist in `roto-core` today: `Project`, `ProjectConfig`, `Profile`, `Clip`, `ClipPipeline`, `Palette`, `Raster`, `IndexedRaster`, `AseSprite`, `Publisher`, `StageCache`. Inline code that finds more than one symbol is not linked, and nothing is reported; check on the live page that each name became a link, and use the qualified name (`com.roto.core.project.Project`) otherwise.

```markdown
## Core types

The pipeline is built from a few types of `roto-core`:

- `Project` and `ProjectConfig` describe a project and its settings.
- `ClipPipeline` runs the stages on a `Clip`.
- `IndexedRaster` and `Palette` hold the pixel art.
- `AseSprite` is the Aseprite file the pipeline writes.
```

If 0.4 showed mode `100644` for `gradlew`, fix it in the same commit with `git -C ../roto update-index --chmod=+x gradlew`.

### 3.2 Commit and push to roto

**User confirms before running.**

```sh
cd ../roto
git add -A
git commit -m "docs: Name the core types in the pipeline guide"
git push origin main
cd -
```

The links appear on the live site after the next deploy: the first deploy of step 6 (or a refresh run after it) rebuilds the docs from roto's `main`.

## 4. Create the public content repository

The repository is public by decision, and the keepalive described under [things to know](#things-to-know) is written for a public repository. Keep it public.

### 4.1 Create it and add the remote, without pushing

Do not push `main` yet. A push to `main` starts the Deploy workflow, which needs the secrets and the originals from step 5. Secrets can be created only after the repository exists, which is why it is created first.

Everything tracked in git becomes public, with its history. Decide before the first push whether these tracked files belong there: `site-spec.md` (the planning document of the sites), `.claude/settings.json` and `.claude/specloop/config.json` (settings of the tools that built the repository). To keep one out, run `git rm --cached <file>` and commit it (on `main`, before 5.9), then add it to `.gitignore`; the file stays on disk, but stays in the earlier commits of the history.

**User confirms before running.**

```sh
gh repo create ba3a/ba3adev --public --description "Content, themes and configuration of ba3a.dev and my.ba3a.dev"
git remote add origin https://github.com/ba3a/ba3adev.git
git remote -v
```

## 5. Cloudflare, secrets, originals and the first push

### 5.1 Enable R2 (in the dashboard)

**User confirms before running.**

Cloudflare dashboard, R2 Object Storage, enable R2 for the account. Cloudflare may ask for a payment method even for the free tier. The bucket is made by the script in 5.4. Note the Account ID (right side of the dashboard home page).

### 5.2 Create a token for the setup script

**User confirms before running.**

Dashboard, My Profile, API Tokens, Create Custom Token, with the permissions the script prints: Account / Cloudflare Pages / Edit; Account / Workers R2 Storage / Edit; Zone / DNS / Edit for `ba3a.dev`; Zone / Zone / Read for `ba3a.dev` if Cloudflare asks for it. Then:

```sh
cp .env.local.example .env.local
# edit .env.local: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
```

### 5.3 Dry run of the setup script

It prints the plan and, with credentials, only reads. It never writes with `--dry-run`.

**User confirms before running.**

```sh
node scripts/cloudflare-setup.mjs --dry-run
```

### 5.4 Run the setup script, then again

[`scripts/cloudflare-setup.mjs`](scripts/cloudflare-setup.mjs) creates the Pages projects `ba3a-dev` and `my-ba3a-dev` (production branch `main`), attaches the custom domains and creates the private bucket `ba3a-media`. It is idempotent: the second run must print "Nothing to do: everything exists already."

**User confirms before running.**

```sh
node scripts/cloudflare-setup.mjs
node scripts/cloudflare-setup.mjs
```

### 5.5 Check the domains and DNS

A custom domain stays "pending" for a few minutes. Dashboard, Workers & Pages, each project, Custom domains: both must become "Active". If one stays pending, open the zone `ba3a.dev`, DNS, Records: there must be a proxied CNAME from `@` (`ba3a.dev`) to `ba3a-dev.pages.dev` and from `my` to `my-ba3a-dev.pages.dev`. Create a missing one by hand.

**User confirms before running.**

### 5.6 Create the R2 token for the media store and put the keys in `.env.local`

**User confirms before running.**

Dashboard, R2, Manage R2 API Tokens, Create API token, Object Read & Write, limited to the bucket `ba3a-media`. Put the Access Key ID and the Secret Access Key into `.env.local` as `R2_ACCESS_KEY_ID` and `R2_SECRET_ACCESS_KEY`. Then remove `CLOUDFLARE_API_TOKEN` from `.env.local` (the media store does not read it). Optionally create a second R2 token with Object Read only for CI: the deploy only pulls.

### 5.7 Upload the originals to R2 (before the first push to `main`)

The deploy pulls the originals the lock file lists and stops if the bucket lacks them. The pre-push hook uploads them on every push too (it was installed by `npm install` in step 2), but upload them now, so that the first deploy cannot fail for this reason.

**User confirms before running.**

```sh
npx coffer media status
npx coffer media push
npx coffer media status       # nothing missing
```

### 5.8 Create the four GitHub Actions secrets

Names, as the workflows use them: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. For `CLOUDFLARE_API_TOKEN` use a narrower token than the one from 5.2: create a new custom token with only Account / Cloudflare Pages / Edit (this is what `wrangler pages deploy` needs; unverified: if the deploy fails with an authentication error, add Account / Account Settings / Read). Then revoke the setup token from 5.2. Use the read-only R2 token for the two `R2_` secrets if you made one.

**User confirms before running.**

```sh
gh secret set CLOUDFLARE_API_TOKEN --repo ba3a/ba3adev
gh secret set CLOUDFLARE_ACCOUNT_ID --repo ba3a/ba3adev
gh secret set R2_ACCESS_KEY_ID --repo ba3a/ba3adev
gh secret set R2_SECRET_ACCESS_KEY --repo ba3a/ba3adev
gh secret list --repo ba3a/ba3adev
```

Each command asks for the value and does not echo it.

### 5.9 Push `main`

Everything the first deploy needs exists now: the bucket with the originals, the secrets, the Pages projects and the domains. The push runs the pre-push hook (it uploads missing originals and aborts the push on a failure), then starts the Deploy workflow.

Run 5.10 immediately afterwards.

**User confirms before running.**

```sh
git push -u origin main
```

### 5.10 Keep the Refresh workflow disabled until the first Deploy is green

Without a live `build-info.json`, every Refresh run (every 15 minutes) would start a deployment of its own. Disabling by hand is respected by the keepalive.

**User confirms before running.**

```sh
gh workflow disable refresh.yml --repo ba3a/ba3adev
```

## 6. Deploy and check the live sites

### 6.1 Watch the first deploy (read only)

The push in 5.9 started it. The last line starts one by hand.

**User confirms before running.**

```sh
gh run list --repo ba3a/ba3adev --workflow deploy.yml --limit 3
gh run watch --repo ba3a/ba3adev <id>
# to start one by hand: gh workflow run deploy.yml --repo ba3a/ba3adev --ref main
```

The steps in order: originals pulled, build, `coffer check --w3c`, build report in the job summary, `Deploy ba3a.dev`, `Deploy my.ba3a.dev`, `Smoke test the live sites`.

### 6.2 Check the smoke test (read only)

The step "Smoke test the live sites" passes only when both sites answer over HTTPS: the home page 200, `/devlog` redirecting to `/devlog/`, an unknown address 404 in the right language, and `build-info.json` carrying this run's build time.

**User confirms before running.**

```sh
gh run view --repo ba3a/ba3adev <id> --log | grep -iE "smoke|ok |fail"
```

### 6.3 Post-deploy checks (read only)

**User confirms before running.**

```sh
curl -sI https://ba3a.dev/ | grep -i "content-security-policy"                  # one policy
curl -sI https://ba3a.dev/build-info.json | grep -i "cache-control"             # no-cache
curl -sI https://ba3a.dev/made/roto/docs/reference/ | grep -ci "content-security-policy"    # 0: the generated reference is served without a policy
curl -sI https://my.ba3a.dev/ | grep -i "content-security-policy"
```

If the third command prints 1, the rule `/made/*/docs/reference/*` in `deploy/_headers` does not match the folder address; add a second rule for `/made/*/docs/reference` with the same `! Content-Security-Policy` line, and redeploy. Also open the W3C result in the job summary: a W3C validator outage only warns, it does not fail the deploy.

### 6.4 Enable Refresh

Only when the first Deploy is green.

**User confirms before running.**

```sh
gh workflow enable refresh.yml --repo ba3a/ba3adev
```

Or: Actions tab, Refresh, "Enable workflow".

## 7. Upgrade coffer later

The sites pin a tag and never follow a branch.

**User confirms before running.**

```sh
git ls-remote --tags https://github.com/ba3a/coffer.git        # the newest tag, for example v0.2.0
# read https://github.com/ba3a/coffer/blob/v0.2.0/CHANGELOG.md, the sections "Changed" and "Removed" first
npm install github:ba3a/coffer#v0.2.0                          # updates package.json and the lock file
npm test
```

Before 1.0.0 a minor version may need a change in a site; the changelog says so. Commit `package.json` and `package-lock.json` together. To release coffer itself: in the engine repository move the "Unreleased" entries under a new `## x.y.z - date` heading, set the version in `package.json`, tag `vx.y.z` and push the tag.

## Things to know

- **Timing.** A Refresh run is scheduled every 15 minutes, GitHub may start it 5 to 15 minutes late, and a deploy takes a few minutes: a scheduled post appears in about 20 to 30 minutes, a change in a project's docs within an hour.
- **Keepalive.** GitHub disables scheduled workflows of a public repository after 60 days without activity. Refresh has a keepalive job, and `keepalive.yml` runs monthly. They call the "enable workflow" API when the workflow is older than 30 days or on the 1st of the month. This is best effort: GitHub does not document that the call restarts the 60-day clock. Manual recovery: enable the workflow by hand (Actions tab, Refresh, Enable workflow, or `gh workflow enable refresh.yml`), then make a real commit, which resets the clock for certain. Keep the repository public. See [If the scheduled workflow stops](AUTHORING.md#if-the-scheduled-workflow-stops).
- **`npm test` is not run before a deploy.** It takes about 14 minutes. The deploy runs the build, `coffer check` and the smoke test. Run `npm test` yourself before you push a change to scripts, themes or configuration.
- **Hooks.** The first `npm install` on a computer sets `core.hooksPath` to the coffer hooks: pre-commit refreshes `media.lock.json`, pre-push uploads originals and aborts the push when that fails, post-checkout and post-merge pull originals.
- **Stable ids.** Keep the blog ids `devlog` and `blog` and the project slugs as they are: they appear in addresses and in `npm run new`.
- **License.** Do not add a root `LICENSE` without editing the sentence in `README.md` that says there is none.
- **Analytics are off.** To turn on the Cloudflare Web Analytics beacon, edit `coffer.yaml` (the `analytics` key of a site), the "Analytics" section of [AUTHORING.md](AUTHORING.md#analytics) and the test in `scripts/test/authoring-docs.test.mjs` that expects them to be off.
- **Lighthouse.** The aim is 95 or more for performance and accessibility on a mobile profile, measured once and not a CI gate. With your permission, after the post `first` is published (remove `draft: true` from `content/ba3a.dev/devlog/first/index.md`, see below): `npx lighthouse@<exact version> https://ba3a.dev/devlog/first/ --only-categories=performance,accessibility --output=html --output-path=lighthouse-first.html` (the default profile is mobile; it needs Chrome and downloads the tool).

## Replace the seed content

Everything the sites show is a seed: drafts and placeholders, each with a `TODO: rewrite` comment.

- Texts: `content/ba3a.dev/home.md`, `content/ba3a.dev/projects/*/index.md` and `project.yaml`, `content/ba3a.dev/devlog/first` and `second`, `content/my.ba3a.dev/pervyj` and `vtoroj`, and the Russian strings with a `TODO: rewrite` in `themes/my/i18n/ru.yaml`. Find them with `grep -rn "TODO" content themes coffer.yaml`.
- Seed posts are drafts. A post is published when `draft: true` is removed from its front matter and its date is not in the future.
- Photos: the pictures in the seed posts are generated, with made-up GPS data. Replace the files in the post folders with real photographs (the hooks update `media.lock.json`). Tests that name the seed posts or photos must change with them: `scripts/make-placeholders.mjs`, `scripts/site-test/seed-posts.test.mjs`, `scripts/test/media-config.test.mjs` and `scripts/test/seed-photos.test.mjs`.
- Card pictures, logos and key art under `content/ba3a.dev/projects/` are generated placeholders, too (`scripts/make-placeholders.mjs`).

## Open questions for you

These were decided as defaults and need your confirmation:

- The site titles "ba3a.dev" and "ba3a" (`title` of the sites in `coffer.yaml`) and the heading of the home page (`title` in `content/ba3a.dev/home.md`).
- The Russian copy of the personal blog, its theme strings and the seed posts.
- The accent colour of the Faultory page (`accent` in `content/ba3a.dev/projects/faultory/project.yaml`).
- The statuses of specloop and coffer (`status` in their `project.yaml` files; one of idea, in-development, released, maintained, archived).
- The LinkedIn and email links (the two commented lines in `coffer.yaml`).
- The developer name of the Faultory press kit (`pressKit.developer`, now `TODO: developer name`).

## A new tool project

The full checklist, with a declaration to copy, is in [Adding a new tool project](AUTHORING.md#adding-a-new-tool-project). In short: the project repository is public and gets no token or webhook; add `content/ba3a.dev/projects/{slug}/` with `project.yaml`, `index.md` and a card picture; give `docs.source` as a `git` address with `ref`, the `guides`, and optionally a `reference`; register nothing else, because the Refresh workflow reads the configuration and polls the repository; run `npm run dev`, `npm run build` and `npm run check`. A reference that runs Gradle needs JDK 21, which the deploy workflow installs.
