#!/bin/bash
# The previous release (`ttoss/soat:<latest CHANGELOG version>`) boots on its
# own schema, keeps serving while this checkout's `migrate.mjs run` changes it,
# then passes its own smoke tests: `.claude/rules/postgresdb.md`, first section.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

previous="$(grep -m1 -oE '^#+ \[[0-9]+\.[0-9]+\.[0-9]+\]' CHANGELOG.md | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')"
tag="v$previous"
image="ttoss/soat:$previous"
project="soat-previous-release"
echo "Previous release: $previous"

if ! git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null; then
  git fetch --no-tags --depth=1 origin "+refs/tags/$tag:refs/tags/$tag"
fi

work="$(mktemp -d)"
git worktree add --detach "$work/soat" "$tag" >/dev/null

# The published image replaces the release's own build of `server` and `worker`.
cat >"$work/override.yml" <<EOF
services:
  server:
    image: $image
    build: !reset null
  worker:
    image: $image
    pull_policy: missing
EOF

compose=(docker compose -p "$project"
  -f "$work/soat/tests/docker-compose.smoke.yml" -f "$work/override.yml")
# This checkout's `server`, with its environment, on the same network.
current=(docker compose -p "$project" -f "$root/tests/docker-compose.smoke.yml")

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    "${compose[@]}" logs --no-color --tail=200 server worker || true
  fi
  "${compose[@]}" down --volumes --remove-orphans || true
  git worktree remove --force "$work/soat" || true
  rm -rf "$work"
}
trap cleanup EXIT

docker pull "$image"
"${current[@]}" build server
"${compose[@]}" build smoke-test

# The previous release migrates a fresh database itself, as it does in production.
"${compose[@]}" up -d --wait server worker

"${current[@]}" run --rm --no-deps -T server node packages/server/dist/migrate.mjs run

"${compose[@]}" run --rm smoke-test
