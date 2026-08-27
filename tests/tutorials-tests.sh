#!/bin/bash
# Validate a tutorial by extracting and running its CLI commands, joining
# multi-line commands with backslash continuation.
#
# Usage: ./tutorials-tests.sh <tutorial-file.md>
#
# Environment:
#   SOAT_BASE_URL   Server base URL (required)
#   VERBOSE         Set to 1 for verbose output
#
# Special comment annotations in the tutorial markdown (inline after commands):
#   # → 403         Expect a non-zero exit (the number is the HTTP status code).
#                   The command is run; a zero exit is treated as an error.
#   # → ignore      Run the command but ignore its exit code entirely.
#   # → retry N     Re-run until it exits 0, up to N attempts, 1s apart. Prints
#                   the elapsed wall-clock, since N attempts is not N seconds —
#                   each also pays a CLI round trip. For steps slow to converge,
#                   not steps whose outcome an LLM decides; make those
#                   deterministic instead.
#
# Non-interactive profile handling: "soat login-user" output is captured and its
# token written to a profile file directly, so a later "soat configure" line is
# skipped and "--profile X" commands are rewritten to use SOAT_TOKEN.

set -e

TUTORIAL_FILE="${1:?Usage: $0 <tutorial-file.md>}"
VERBOSE="${VERBOSE:-0}"

if [[ ! -f "$TUTORIAL_FILE" ]]; then
  echo "Error: File not found: $TUTORIAL_FILE"
  exit 1
fi

# Ensure required environment
if [[ -z "$SOAT_BASE_URL" ]]; then
  echo "Error: SOAT_BASE_URL not set. Run: export SOAT_BASE_URL=http://localhost:5047"
  exit 1
fi

echo "=========================================="
echo "Validating tutorial: $TUTORIAL_FILE"
echo "SOAT_BASE_URL: $SOAT_BASE_URL"
echo "=========================================="
echo ""

CMDS_FILE=$(mktemp)

cleanup() {
  jobs -pr | xargs -r kill 2>/dev/null || true
  rm -f "$CMDS_FILE"
}

trap cleanup EXIT

# Extract bash code blocks from CLI tabs, joining continuations.
#
# Annotations are recognized only on their own line, immediately BEFORE the
# command they apply to. A trailing inline `# → ...` is not split out; it reaches
# the shell as an ordinary comment and the annotation is lost.
awk '
  /value="cli"/ { in_cli_tab = 1; next }
  in_cli_tab && /<\/TabItem>/ { in_cli_tab = 0; next }
  in_cli_tab && /^```bash$/ { in_code = 1; next }
  in_cli_tab && /^```$/ { in_code = 0; next }
  in_code { print }
' "$TUTORIAL_FILE" > "$CMDS_FILE"

if [[ ! -s "$CMDS_FILE" ]]; then
  echo "Error: No CLI commands found in $TUTORIAL_FILE"
  exit 1
fi

if [[ "$VERBOSE" == "1" ]]; then
  echo "Extracted raw commands:"
  echo "---"
  cat "$CMDS_FILE"
  echo "---"
  echo ""
fi

# Parse raw lines into COMMANDS[], each entry "<annotation>|<cmd>" where the
# annotation is "" (succeed), "expect-fail", or "ignore".
declare -a COMMANDS
CURRENT_CMD=""
CURRENT_ANNOTATION=""   # annotation harvested from inline # → ... comment
NEXT_ANNOTATION=""      # annotation waiting to be applied to the NEXT command
PENDING_CONFIGURE=""    # profile name waiting to be saved after login
HEREDOC_DELIM=""
HEREDOC_PATTERN="<<-?[[:space:]]*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?$"

_flush_cmd() {
  local cmd="$1"
  local ann="$2"
  cmd=$(echo "$cmd" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  [[ -z "$cmd" ]] && return
  # Use pending forward annotation if none set for this command
  if [[ -z "$ann" && -n "$NEXT_ANNOTATION" ]]; then
    ann="$NEXT_ANNOTATION"
    NEXT_ANNOTATION=""
  fi
  COMMANDS+=("${ann}|${cmd}")
}

while IFS= read -r line; do
  if [[ -n "$HEREDOC_DELIM" ]]; then
    CURRENT_CMD+="$line"
    if [[ "$line" == "$HEREDOC_DELIM" ]]; then
      _flush_cmd "$CURRENT_CMD" "$CURRENT_ANNOTATION"
      CURRENT_CMD=""
      CURRENT_ANNOTATION=""
      HEREDOC_DELIM=""
    else
      CURRENT_CMD+=$'\n'
    fi
    continue
  fi

  # Extract inline annotation from standalone comment lines like "# → 403"
  if [[ "$line" =~ ^[[:space:]]*#[[:space:]]*→[[:space:]]*(.*) ]]; then
    hint="${BASH_REMATCH[1]}"
    if [[ -n "$CURRENT_CMD" ]]; then
      # Annotation applies to the command currently being built
      CURRENT_ANNOTATION="$hint"
    else
      # No command in progress — apply to the NEXT command to be flushed
      NEXT_ANNOTATION="$hint"
    fi
    continue
  fi

  # Skip pure comment lines (no → annotation)
  if [[ "$line" =~ ^[[:space:]]*# ]]; then
    continue
  fi

  # Prints 1 while a quote is still open, so the next line joins this command
  # rather than dispatching as its own — which is what lets a tutorial spread a
  # JSON argument over several lines.
  #
  # This used to count every `'` and call an odd total "open". A counter cannot
  # tell a quote from an apostrophe: one `Alice's` in a double-quoted argument
  # made the total odd, so the runner swallowed every later line and died on
  # `unexpected EOF` blaming a command that had already run fine.
  _open_quote() {
    printf '%s' "$CURRENT_CMD" | awk '
      BEGIN { q = "" }
      {
        n = length($0)
        for (i = 1; i <= n; i++) {
          c = substr($0, i, 1)
          # A backslash escapes the next character outside quotes and inside
          # double quotes; inside single quotes shell treats it literally.
          if ((q == "" || q == "\"") && c == "\\") { i++; continue }
          if (q == "") { if (c == "\047" || c == "\"") q = c }
          else if (c == q) { q = "" }
        }
      }
      END { print (q == "" ? 0 : 1) }
    '
  }

  # Empty line → flush current command (unless inside an unclosed quoted string)
  if [[ -z "$line" ]]; then
    if [[ -n "$CURRENT_CMD" ]]; then
      if [ "$(_open_quote)" = 1 ]; then
        CURRENT_CMD+=$'\n'
      else
        _flush_cmd "$CURRENT_CMD" "$CURRENT_ANNOTATION"
        CURRENT_CMD=""
        CURRENT_ANNOTATION=""
      fi
    fi
    continue
  fi

  # Continuation line (ends with backslash)
  if [[ "$line" =~ \\$ ]]; then
    CURRENT_CMD+="${line%\\} "
  else
    CURRENT_CMD+="$line"

    if [[ "$CURRENT_CMD" =~ $HEREDOC_PATTERN ]]; then
      HEREDOC_DELIM="${BASH_REMATCH[1]}"
      CURRENT_CMD+=$'\n'
      continue
    fi

    # If we're inside an unclosed quoted string, keep accumulating
    if [ "$(_open_quote)" = 1 ]; then
      CURRENT_CMD+=$'\n'
    else
      _flush_cmd "$CURRENT_CMD" "$CURRENT_ANNOTATION"
      CURRENT_CMD=""
      CURRENT_ANNOTATION=""
    fi
  fi
done < "$CMDS_FILE"

# Flush any trailing command
if [[ -n "$CURRENT_CMD" ]]; then
  _flush_cmd "$CURRENT_CMD" "$CURRENT_ANNOTATION"
fi

# ---------------------------------------------------------------------------
# Profile helper — writes ~/.soat/config.json without interactive prompts.
# ---------------------------------------------------------------------------
SOAT_CONFIG_DIR="${HOME}/.soat"

_write_profile() {
  local profile_name="$1"
  local token="$2"
  local base_url="${SOAT_BASE_URL}"
  mkdir -p "$SOAT_CONFIG_DIR"
  local config_file="${SOAT_CONFIG_DIR}/config.json"
  # Merge profile into existing config (or create new)
  if [[ -f "$config_file" ]]; then
    local existing
    existing=$(cat "$config_file")
    printf '%s\n' "$existing" | \
      jq --arg p "$profile_name" \
         --arg u "$base_url" \
         --arg t "$token" \
         '.[$p] = {baseUrl: $u, token: $t}' > "${config_file}.tmp" && \
      mv "${config_file}.tmp" "$config_file"
  else
    jq -n \
      --arg p "$profile_name" \
      --arg u "$base_url" \
      --arg t "$token" \
      '{($p): {baseUrl: $u, token: $t}}' > "$config_file"
  fi
  echo "(profile \"$profile_name\" saved to $config_file)"
}

# ---------------------------------------------------------------------------
# Execute commands
# ---------------------------------------------------------------------------
STEP=0
LAST_LOGIN_TOKEN=""
LAST_LOGIN_PROFILE=""   # profile name extracted from pending configure line

for entry in "${COMMANDS[@]}"; do
  annotation="${entry%%|*}"
  cmd="${entry#*|}"

  # Determine expect-fail from annotation
  expect_fail=0
  ignore_exit=0
  max_attempts=1
  if [[ "$annotation" =~ ^retry[[:space:]]+([0-9]+)$ ]]; then
    max_attempts="${BASH_REMATCH[1]}"
  elif [[ "$annotation" =~ ^[0-9]+$ ]] || [[ "$annotation" == "expect-fail" ]]; then
    expect_fail=1
  elif [[ "$annotation" == "ignore" ]]; then
    ignore_exit=1
  fi

  STEP=$((STEP + 1))

  # ------------------------------------------------------------------
  # Skip: "export SOAT_BASE_URL=..." — use the env var already set
  # in the environment (e.g. from Docker container config).
  # ------------------------------------------------------------------
  if [[ "$cmd" =~ ^export[[:space:]]+SOAT_BASE_URL= ]]; then
    echo "[Step $STEP] (skipping — SOAT_BASE_URL already set to: $SOAT_BASE_URL)"
    echo ""
    continue
  fi

  # "soat configure" is interactive, so it is skipped in favour of the token
  # captured from the most recent "soat login-user".
  if [[ "$cmd" =~ ^soat[[:space:]]+configure ]]; then
    profile_name="default"
    if [[ "$cmd" =~ --profile[[:space:]]+([^[:space:]]+) ]]; then
      profile_name="${BASH_REMATCH[1]}"
    fi
    if [[ -n "$LAST_LOGIN_TOKEN" ]]; then
      echo "[Step $STEP] (non-interactive) Writing profile \"$profile_name\" with last login token"
      _write_profile "$profile_name" "$LAST_LOGIN_TOKEN"
      LAST_LOGIN_TOKEN=""
    else
      echo "[Step $STEP] (skipping soat configure — no prior login token captured)"
    fi
    echo ""
    continue
  fi

  # ------------------------------------------------------------------
  # Rewrite: "soat login-user" → capture token for next configure step
  # ------------------------------------------------------------------
  if [[ "$cmd" =~ ^soat[[:space:]]+login-user ]]; then
    if [[ "$VERBOSE" == "1" ]]; then
      echo "[Step $STEP] Running (login, capturing token):"
      echo "  $cmd"
    else
      echo "[Step $STEP] $cmd"
    fi
    set +e
    login_output=$(eval "$cmd" 2>&1)
    login_exit=$?
    set -e
    if [[ $login_exit -ne 0 ]]; then
      echo ""
      echo "❌ ERROR: login command failed at step $STEP"
      echo "   Command: $cmd"
      echo "   Output:  $login_output"
      exit 1
    fi
    # Extract token from JSON output
    LAST_LOGIN_TOKEN=$(printf '%s\n' "$login_output" | jq -r '.token // empty' 2>/dev/null || true)
    if [[ -z "$LAST_LOGIN_TOKEN" ]]; then
      echo "WARNING: could not extract token from login output"
    fi
    echo "$login_output"
    echo ""
    continue
  fi

  if [[ "$VERBOSE" == "1" ]]; then
    echo "[Step $STEP] Running:"
    echo "  $cmd"
  else
    echo "[Step $STEP] $cmd"
  fi

  # Execute — retried when the command carries a "# → retry N" annotation.
  attempt=1
  retry_started_at=$SECONDS
  while true; do
    set +e
    eval "$cmd"
    exit_code=$?
    set -e

    if [[ $exit_code -eq 0 || $attempt -ge $max_attempts ]]; then
      break
    fi
    attempt=$((attempt + 1))
    echo "(exit $exit_code — retrying, attempt $attempt/$max_attempts)"
    sleep 1
  done

  if [[ $max_attempts -gt 1 && $exit_code -ne 0 ]]; then
    # An attempt is a 1s sleep plus a CLI round trip, so N attempts is not N
    # seconds, and the container's buffered stdout collapses CI timestamps to
    # the flush — without this number an exhausted budget and a broken feature
    # look identical.
    echo ""
    echo "❌ ERROR: Command failed after $max_attempts attempts ($((SECONDS - retry_started_at))s elapsed) at step $STEP"
    echo "   Command: $cmd"
    exit 1
  fi

  if [[ $ignore_exit -eq 1 ]]; then
    : # ignore
  elif [[ $expect_fail -eq 1 ]]; then
    if [[ $exit_code -eq 0 ]]; then
      echo ""
      echo "❌ ERROR: Expected command to fail (annotation: $annotation) but it succeeded at step $STEP"
      echo "   Command: $cmd"
      exit 1
    fi
    echo "(expected failure — ok)"
  else
    if [[ $exit_code -ne 0 ]]; then
      echo ""
      echo "❌ ERROR: Command failed (exit $exit_code) at step $STEP"
      echo "   Command: $cmd"
      exit 1
    fi
  fi

  echo ""
done

echo "=========================================="
echo "✓ Tutorial validation completed successfully"
echo "($STEP commands executed)"
echo "=========================================="
