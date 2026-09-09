# Release Process

## Flow

1. Open a release PR (`release/vX.Y.Z` → `main`) titled `chore(release): …`.
   `pr.yml` skips the build/smoke/tutorials jobs on that title, so never put
   unreviewed non-release code on such a PR.
2. **Squash-merge.** Every `main.yml` job gates on
   `startsWith(head_commit.message, 'chore(release):')`; a default merge commit
   (`Merge pull request …`) silently skips the whole release. After merging,
   confirm the `main.yml` run actually ran.
3. `main.yml`: `push-release-tag` → `release` (npm publish via OIDC trusted
   publishing + website deploy) → `publish-docker`.

### npm trusted publishing

No `NPM_TOKEN`; `id-token: write` on the `release` job. Each package registers
`ttoss` / `soat` / `main.yml` as its trusted publisher on npmjs.com, so renaming
`main.yml` or adding a package needs the publisher updated there first. A
missing publisher shows as `404` on the OIDC exchange
(`ERR_PNPM_AUTH_TOKEN_EXCHANGE`) then `404` on the `PUT`.

## Cutting a release from a session

```bash
git fetch --tags origin                      # lerna needs the last tag

# environment runs Node 22 / pnpm 10; project declares ^24 / ^11
node -e "
const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.engines.node='>=22.0.0';p.engines.pnpm='>=10.0.0';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');"

pnpm lerna version --yes --no-push           # or: patch | minor | major

node -e "
const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));
p.engines.node='^24.0.0';p.engines.pnpm='^11.0.0';
fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n');" \
  && git add package.json && git commit --amend --no-edit
git tag -d "v$(node -e "console.log(require('./lerna.json').version)")"  # orphaned by the amend; CI tags

git checkout -b release/vX.Y.Z
git push -u origin release/vX.Y.Z            # then open the PR
```

Always `--no-push`: branch protection blocks direct pushes to `main`.

### `--dry-run` still writes files

It skips commit/tag/push only; `lerna.json`, every `package.json` and every
`CHANGELOG.md` are bumped. A real run after an unreset dry run bumps twice and
skips a version. After any dry run:

```bash
git checkout -- . && git status --porcelain   # must print nothing
```

Before the real run, lerna's "current project version" must equal
`git describe --tags --abbrev=0`. If a double bump already committed:
`git tag -d v<version> && git reset --hard origin/main`, then redo.

## Breaking changes

`--conventional-commits` bumps major on a `BREAKING CHANGE:` footer. The `feat!:`
shorthand needs the `conventionalcommits` preset; lerna.json uses `angular`, so
use the footer.

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
