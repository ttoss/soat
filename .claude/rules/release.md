# Release Process

Releases are fully automated once a release PR is merged into `main`. This document explains how to prepare and trigger a release from a Claude Code session.

## Release Flow

### 1. Release PR (no re-validation)

Open a release PR (conventionally `release/vX.Y.Z` → `main`, though the branch name itself
drives nothing) by running `pnpm lerna version` locally or in a Claude Code session, with a
PR title that starts with `chore(release):`.

`pr.yml` skips `build-test-and-deploy`, `smoke-test`, and `tutorials-test` (and the
`changes`/`docs-lint` jobs) whenever the PR title starts with `chore(release):` —
`if: "!startsWith(github.event.pull_request.title, 'chore(release):')"` on each job. The
commits a release PR bundles were already validated on `main` before the version bump;
re-running the full suite (which includes the slow smoke and tutorials stacks) on a
changelog/version-only diff is redundant. `all-checks` treats a `skipped` dependency the
same as `success`, so the required status check still passes.

This means branch protection does **not** re-validate a release PR's contents — it passes
on the strength of the title alone. Get the title right (`chore(release): ...`) or the
full suite runs unnecessarily; conversely, never put unreviewed non-release code on a
branch with that PR title, since CI will wave it through.

### 2. Merge → automated release

When the release PR is merged, the `chore(release): publish packages` commit lands on `main` and triggers `main.yml`:

```
push-release-tag   →   release (npm publish + website deploy)   →   publish-docker
```

- `build-and-test`, `smoke-test`, and `tutorials-test` are **skipped** on non-release commits; they only run when the commit message starts with `chore(release):`.
- `push-release-tag` pushes the `vX.Y.Z` git tag.
- `release` publishes `@soat/sdk` and `@soat/cli` to npm and deploys the website.
- `publish-docker` builds and pushes the Docker image to Docker Hub.

## Running a Release from a Claude Code Session

Branch protection prevents direct pushes to `main`, so releases go through a PR.

### Step 1 — Fetch tags

Lerna determines the changelog range and version bump from the last git tag. Always fetch tags before running lerna, otherwise it will fall back to including all commits and produce duplicate changelog entries:

```bash
git fetch --tags origin
```

### Step 2 — Patch engines (environment workaround)

This environment runs Node 22 / pnpm 10 but the project declares `^24` / `^11`. Temporarily relax the constraint before running lerna:

```bash
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.engines.node = '>=22.0.0';
pkg.engines.pnpm = '>=10.0.0';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
```

### Step 3 — Run lerna version

Always pass `--no-push` — branch protection blocks direct pushes to `main`, and the PR flow handles the push. Never run lerna without `--no-push` or it will attempt (and fail) to push to `main` directly.

If no bump type is specified, lerna reads the commit history with `--conventional-commits` and determines the correct bump automatically (patch / minor / major):

```bash
pnpm lerna version --yes --no-push
```

To force a specific bump:

```bash
pnpm lerna version patch --yes --no-push   # 0.6.9 → 0.6.10
pnpm lerna version minor --yes --no-push   # 0.6.9 → 0.7.0
pnpm lerna version major --yes --no-push   # 0.6.9 → 1.0.0
```

Lerna will create a `chore(release): publish packages` commit and tag locally.

#### `--dry-run` is not side-effect-free — reset before the real run

**`--dry-run` skips the commit, the tag and the push. It does *not* skip the file
writes.** It still writes the bumped version into `lerna.json`, into every
`package.json`, and appends the new entry to every `CHANGELOG.md` — only the git
operations are gated on the flag (verified in `@lerna-lite/version` 5.4.1, the
version this repo pins, and still true in 5.5.0).

So a preview followed by a real run bumps **twice**, and the release tags a
version one step past the intended one, skipping a number entirely:

```bash
# starting from a clean main at 0.22.1
pnpm lerna version --yes --no-push --dry-run
# → "current project version 0.22.1", proposes 0.22.1 => 0.23.0
#   ...and silently writes 0.23.0 to lerna.json + every package.json + CHANGELOGs

pnpm lerna version --yes --no-push
# → "current project version 0.23.0" (!), produces 0.23.0 => 0.24.0
#   commits and tags v0.24.0 — v0.23.0 is never released, and the v0.24.0
#   changelog covers the range that belonged to v0.23.0
```

Nothing in the output flags this; the second run's `current project version` line
is the only tell, and it reads like normal output. It bit the v0.23.0 cut (#1017).

**Always discard the working tree after a dry run, before the real one:**

```bash
pnpm lerna version --yes --no-push --dry-run   # preview
git checkout -- .                              # MANDATORY — undo the version writes
git status --porcelain                         # must print nothing
pnpm lerna version --yes --no-push             # the real run
```

`git checkout -- .` only restores tracked files, which is all lerna touches here.
Before the real run, confirm the version lerna reports as *current* matches the
last release tag (`git describe --tags --abbrev=0`); if it is already one bump
ahead, a dry run leaked and the tree was not reset.

If you notice it only after the real run committed and tagged:

```bash
git tag -d "v$(node -e "console.log(require('./lerna.json').version)")"
git reset --hard origin/main
# then re-run from Step 2
```

### Step 4 — Restore engines

```bash
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.engines.node = '^24.0.0';
pkg.engines.pnpm = '^11.0.0';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
" && git add package.json && git commit --amend --no-edit
```

`git commit --amend` rewrites the commit lerna just tagged, so the local tag lerna created in Step 3 (e.g. `v0.15.14`) is now orphaned — it still points at the pre-amend commit, which no longer exists on the branch. Delete it before pushing; it would otherwise sit as a stale local ref that doesn't match what CI eventually tags (`push-release-tag` in `main.yml` creates the real `vX.Y.Z` tag from the merged commit, so the local one is pure noise at this point):

```bash
git tag -d "v$(node -e "console.log(require('./lerna.json').version)")"
```

### Step 5 — Push to a release branch and open a PR

```bash
git checkout -b release/vX.Y.Z
git push -u origin release/vX.Y.Z
# open PR targeting main
```

The PR title must start with `chore(release):` — the release pipeline in `main.yml` is gated on `startsWith(github.event.head_commit.message, 'chore(release):')`. A title like `chore(release): publish packages` or `chore(release): v0.8.1` both work.

**Merge with "Squash and merge", not the default "Create a merge commit."** The gate checks the *commit that actually lands on `main`* — every job in `main.yml` (`build-and-test`, `smoke-test`, `tutorials-test`, `push-release-tag`, `release`, `publish-docker`) independently re-checks `startsWith(head_commit.message, 'chore(release):')`. A default GitHub merge commit is titled `Merge pull request #NNN from ...`, which does **not** match — every one of those jobs would be silently skipped (green ✅, but nothing runs: no tag, no npm publish, no Docker image). Squash merge with a commit title starting with `chore(release):` (the PR title already does) keeps the message correct. If the repo's branch protection requires an admin bypass merge here, the same rule still applies: whatever merge strategy is used, double-check the resulting `main` commit message starts with `chore(release):` before walking away.

Merge the PR once CI passes. The release pipeline runs automatically — but go verify the `main.yml` run actually started (not skipped) for the merge commit; a silently-skipped release is easy to miss since the PR itself still shows green.

## Breaking Changes

`lerna version` with `--conventional-commits` (already set in `lerna.json`) bumps to the next **major** version automatically when it detects a breaking change commit.

Mark a commit as a breaking change using either format:

```
feat!: remove deprecated token field

# or with a footer:
feat: change authentication flow

BREAKING CHANGE: the `token` field has been removed; use `api_key` instead.
```

Both trigger a major bump (`1.0.0` → `2.0.0`). Running `pnpm lerna version --yes` will pick this up from the commit history — no need to pass `major` explicitly.

> **Note:** The `!` shorthand (`feat!:`) only works with the `conventionalcommits` preset. The project currently uses the default `angular` preset in lerna.json. To use `!`, either switch `getChangelogConfig` to `conventionalcommits` or use the `BREAKING CHANGE:` footer instead.

## Useful lerna version flags

| Flag | Description |
|---|---|
| `--yes` | Skip confirmation prompts |
| `--dry-run` | Skips the commit/tag/push only — **still writes the bumped version to `lerna.json`, every `package.json` and every `CHANGELOG.md`.** Must be followed by `git checkout -- .` before a real run, or the release bumps twice ([see Step 3](#--dry-run-is-not-side-effect-free--reset-before-the-real-run)) |
| `--no-push` | Create commit and tag locally but do not push |
| `--force-publish` | Bump all packages regardless of changes |
| `--conventional-graduate` | Graduate a prerelease to stable (e.g. `1.0.0-alpha.0` → `1.0.0`) |
| `--conventional-prerelease` | Bump unreleased changes as a prerelease |

Full reference: https://github.com/lerna-lite/lerna-lite/blob/main/packages/version/README.md
