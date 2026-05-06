#!/bin/bash
# Run tutorial validation for all (or one) tutorials.
#
# Reads TUTORIALS_DIR for *.md files, skips entries listed in
# IGNORE_FILE (tests/.tutorialsignore), then runs tutorials-tests.sh for each.
#
# Usage inside Docker (via docker-compose.tutorials.yml):
#   bash /run-tutorials.sh
#
# Environment:
#   SOAT_BASE_URL    Server base URL (required)
#   TUTORIAL_ID      If set, run only the tutorial with this base name
#                    (filename without .md), e.g. TUTORIAL_ID=permissions
#   TUTORIALS_DIR    Directory containing *.md tutorial files
#                    (default: /tutorials)
#   IGNORE_FILE      Path to tests/.tutorialsignore
#                    (default: /repo/tests/.tutorialsignore)
#   TUTORIALS_SH     Path to tutorials-tests.sh
#                    (default: /tutorials-tests.sh)
#   VERBOSE          Set to 1 for verbose output (default: 0)

set -e

SOAT_BASE_URL="${SOAT_BASE_URL:?SOAT_BASE_URL is required}"
TUTORIALS_DIR="${TUTORIALS_DIR:-/tutorials}"
IGNORE_FILE="${IGNORE_FILE:-/repo/tests/.tutorialsignore}"
TUTORIALS_SH="${TUTORIALS_SH:-/tutorials-tests.sh}"
VERBOSE="${VERBOSE:-0}"

# ---------------------------------------------------------------------------
# Build ignore set from IGNORE_FILE (strip comments and blank lines).
# ---------------------------------------------------------------------------
declare -A IGNORED
if [[ -f "$IGNORE_FILE" ]]; then
  while IFS= read -r line; do
    # strip leading/trailing whitespace
    line=$(echo "$line" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    IGNORED["$line"]=1
  done < "$IGNORE_FILE"
fi

# ---------------------------------------------------------------------------
# Collect tutorial files.
# ---------------------------------------------------------------------------
declare -a TO_RUN

if [[ -n "$TUTORIAL_ID" ]]; then
  # Run a single specific tutorial
  target="${TUTORIALS_DIR}/${TUTORIAL_ID}.md"
  if [[ ! -f "$target" ]]; then
    echo "ERROR: Tutorial not found: $target" >&2
    exit 1
  fi
  TO_RUN=("$target")
else
  # Discover all *.md files, sort for deterministic order
  while IFS= read -r -d '' file; do
    base=$(basename "$file" .md)
    if [[ -n "${IGNORED[$base]}" ]]; then
      echo "(skipping ignored tutorial: $base)"
      continue
    fi
    TO_RUN+=("$file")
  done < <(find "$TUTORIALS_DIR" -maxdepth 1 -name '*.md' -print0 | sort -z)
fi

if [[ ${#TO_RUN[@]} -eq 0 ]]; then
  echo "No tutorials to run."
  exit 0
fi

echo "=========================================="
echo "Tutorials to run: ${#TO_RUN[@]}"
for f in "${TO_RUN[@]}"; do echo "  - $(basename "$f")"; done
echo "=========================================="
echo ""

# ---------------------------------------------------------------------------
# Bootstrap admin user (idempotent — 409 is fine).
# ---------------------------------------------------------------------------
echo "=== Bootstrapping admin user ==="
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${SOAT_BASE_URL}/api/v1/users/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}')
if [ "$STATUS" = "201" ] || [ "$STATUS" = "409" ]; then
  echo "Bootstrap status: $STATUS — ok"
else
  echo "ERROR: Bootstrap returned HTTP $STATUS" >&2
  exit 1
fi
echo ""

# ---------------------------------------------------------------------------
# Run each tutorial.
# ---------------------------------------------------------------------------
PASS=0
FAIL=0
FAILED_TUTORIALS=()

for tutorial in "${TO_RUN[@]}"; do
  name=$(basename "$tutorial" .md)
  echo "=========================================="
  echo "Running tutorial: $name"
  echo "=========================================="
  set +e
  bash "$TUTORIALS_SH" "$tutorial"
  rc=$?
  set -e
  if [[ $rc -eq 0 ]]; then
    echo ""
    echo "✅ $name passed"
    PASS=$((PASS + 1))
  else
    echo ""
    echo "❌ $name FAILED (exit $rc)"
    FAIL=$((FAIL + 1))
    FAILED_TUTORIALS+=("$name")
  fi
  echo ""
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo "=========================================="
echo "Results: $PASS passed, $FAIL failed"
if [[ ${#FAILED_TUTORIALS[@]} -gt 0 ]]; then
  echo "Failed tutorials:"
  for t in "${FAILED_TUTORIALS[@]}"; do echo "  - $t"; done
  echo "=========================================="
  exit 1
fi
echo "All tutorials passed."
echo "=========================================="
