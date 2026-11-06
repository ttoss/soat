---
paths:
  - "lerna.json"
  - "CHANGELOG.md"
  - ".github/workflows/**"
---

# Release Process

## Flow

1. Open a release PR (`release/vX.Y.Z` → `main`) titled `chore(release): …`.
   `pr.yml` skips build/smoke/tutorials on that title: never put unreviewed
   non-release code on it. It still runs `Release Lockfile` (frozen install);
   `main.yml` refuses to tag on a lockfile a frozen install rejects.
2. **Squash-merge.** Every `main.yml` job gates on
   `startsWith(head_commit.message, 'chore(release):')`; a merge commit
   (`Merge pull request …`) silently skips the release. Confirm the `main.yml`
   run ran.
3. `main.yml`: `release-test-gate` → build/smoke/tutorials → `push-release-tag`
   → `release` (npm publish via OIDC trusted publishing + website deploy) →
   `publish-docker`. The gate skips the three test jobs only when the release
   commit is version bumps and changelogs on a tree whose PR run passed every
   job; anything else (lockfile change, `package.json` edit beyond `version`,
   last PR merged while behind `main`) runs them.

### npm trusted publishing

No `NPM_TOKEN`; `id-token: write` on the `release` job. Each package registers
`ttoss` / `soat` / `main.yml` as trusted publisher on npmjs.com: update it there
before renaming `main.yml` or adding a package. A missing publisher is `404` on
the OIDC exchange (`ERR_PNPM_AUTH_TOKEN_EXCHANGE`), then `404` on the `PUT`.

## Cutting a release from a session

```bash
git fetch --tags origin                      # lerna needs the last tag

# environment runs Node 22 / pnpm 10; the project's pins are saved, then restored
ENGINES=$(node -p "JSON.stringify(require('./package.json').engines)")
node -e "
const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.engines.node='>=22.0.0';p.engines.pnpm='>=10.0.0';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');"

pnpm lerna version --yes --no-push           # or: patch | minor | major

ENGINES=$ENGINES node -e "
const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.engines=JSON.parse(process.env.ENGINES);
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');" \
  && git add package.json && git commit --amend --no-edit
git tag -d "v$(node -e "console.log(require('./lerna.json').version)")"  # orphaned by the amend; CI tags

git checkout -b release/vX.Y.Z
git push -u origin release/vX.Y.Z            # then open the PR
```

Always `--no-push`: branch protection blocks direct pushes to `main`.

### `--dry-run` still writes files

It skips only commit/tag/push; `lerna.json`, every `package.json` and
`CHANGELOG.md` are bumped, so a later real run bumps twice. After any dry run:

```bash
git checkout -- . && git status --porcelain   # must print nothing
```

Before the real run, lerna's "current project version" must equal
`git describe --tags --abbrev=0`. If a double bump already committed:
`git tag -d v<version> && git reset --hard origin/main`, then redo.

## Breaking changes

`--conventional-commits` bumps major on a `BREAKING CHANGE:` footer. Use the
footer, not `feat!:`: that needs the `conventionalcommits` preset and lerna.json
uses `angular`.

## Flags

| Flag | Effect |
|---|---|
| `--yes` | No prompts |
| `--dry-run` | No commit/tag/push, **still writes versions** |
| `--no-push` | Commit and tag locally only |
| `--force-publish` | Bump all packages |
| `--conventional-graduate` | Prerelease → stable |
| `--conventional-prerelease` | Bump as prerelease |

https://github.com/lerna-lite/lerna-lite/blob/main/packages/version/README.md
