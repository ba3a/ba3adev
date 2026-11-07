#!/bin/sh
# Splits the history of coffer/ into a branch of its own, with the files of coffer/ at the root,
# so that the branch can become the first content of the repository ba3a/coffer.
#
# Usage: sh scripts/split-coffer.sh [--push] [--replace]
#        sh scripts/split-coffer.sh --help
#
# Without options the script only works inside this repository: it runs
# `git subtree split --prefix=coffer -b coffer-export`, which writes the local branch
# `coffer-export` and nothing else. It does not contact any remote.
#
#   --push      also push the branch to the main branch of https://github.com/ba3a/coffer.git
#               (an address, not a configured remote; never a forced push). The repository must
#               exist already. Nothing is pushed without this option.
#   --replace   move an existing coffer-export branch to the fresh split. Without it, a branch
#               that points somewhere else is left alone and the script stops. A branch that
#               already points at the fresh split is fine.
#
# The script refuses to run when the working tree has changes (modified, staged or untracked
# files), so that what you split is what is committed, and the result is the same on every run.
#
# See OPERATIONS.md, step 1, for where this fits in the go-live.

set -eu

prefix=coffer
branch=coffer-export
url=https://github.com/ba3a/coffer.git
push=0
replace=0

usage() {
  printf '%s\n' 'Usage: sh scripts/split-coffer.sh [--push] [--replace]'
}

fail() {
  printf 'split-coffer: %s\n' "$1" >&2
  exit "${2:-1}"
}

for argument in "$@"; do
  case $argument in
    --push) push=1 ;;
    --replace) replace=1 ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      fail "unknown option: $argument" 2
      ;;
  esac
done

root=$(git rev-parse --show-toplevel 2>/dev/null) || fail 'not inside a git repository'
cd "$root"

git rev-parse --verify --quiet HEAD >/dev/null || fail 'the repository has no commit yet'
git cat-file -e "HEAD:$prefix" 2>/dev/null || fail "HEAD has no $prefix/ directory to split"

dirty=$(git status --porcelain)
if [ -n "$dirty" ]; then
  printf '%s\n' "$dirty" >&2
  fail 'the working tree has changes (listed above); commit, stash or remove them first'
fi

if git show-ref --verify --quiet "refs/heads/$branch"; then
  # The same history always gives the same split, so compare before touching the branch.
  fresh=$(git subtree split --prefix="$prefix") || fail 'git subtree split failed (is git-subtree installed?)'
  current=$(git rev-parse "refs/heads/$branch")
  if [ "$current" != "$fresh" ]; then
    [ "$replace" = 1 ] || fail "the branch $branch exists and points elsewhere; use --replace to move it to the fresh split"
    git branch --force "$branch" "$fresh"
  fi
else
  git subtree split --prefix="$prefix" -b "$branch" >/dev/null || fail 'git subtree split failed (is git-subtree installed?)'
fi

git cat-file -e "$branch:package.json" 2>/dev/null || fail "the branch $branch has no package.json at its root"
if git cat-file -e "$branch:$prefix" 2>/dev/null; then
  fail "the branch $branch still has a $prefix/ directory"
fi

printf 'Branch %s: %s commits, tip %s\n' "$branch" "$(git rev-list --count "$branch")" "$(git rev-parse --short "$branch")"

if [ "$push" = 1 ]; then
  printf 'Pushing %s to %s (main)\n' "$branch" "$url"
  git push "$url" "$branch:refs/heads/main"
else
  printf 'Nothing was pushed. To publish it, after the repository exists, run: sh scripts/split-coffer.sh --push\n'
fi
