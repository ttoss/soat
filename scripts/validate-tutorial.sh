#!/bin/bash
# Validate tutorial by extracting and running CLI commands
# Handles multi-line commands with backslash continuation
# Usage: ./validate-tutorial.sh <tutorial-file.md>

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
trap "rm -f $CMDS_FILE" EXIT

# Extract bash code blocks from CLI tabs with proper continuation handling
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

echo "Extracted commands:"
echo "---"
cat "$CMDS_FILE"
echo "---"
echo ""

# Parse commands: join lines ending with backslash, then execute
declare -a COMMANDS
CURRENT_CMD=""

while IFS= read -r line; do
  # Skip empty lines (but not in the middle of a multi-line command)
  if [[ -z "$line" ]]; then
    if [[ -n "$CURRENT_CMD" ]]; then
      COMMANDS+=("$CURRENT_CMD")
      CURRENT_CMD=""
    fi
    continue
  fi
  
  # Skip comment-only lines (but preserve inline comments)
  if [[ "$line" =~ ^[[:space:]]*# ]]; then
    continue
  fi
  
  # Append to current command
  if [[ "$line" =~ \\$ ]]; then
    # Line ends with backslash — continuation
    CURRENT_CMD+="${line%\\}"  # Remove trailing backslash and newline
  else
    # Complete command
    CURRENT_CMD+="$line"
    COMMANDS+=("$CURRENT_CMD")
    CURRENT_CMD=""
  fi
done < "$CMDS_FILE"

# Don't forget last command if file doesn't end with newline
if [[ -n "$CURRENT_CMD" ]]; then
  COMMANDS+=("$CURRENT_CMD")
fi

# Execute commands
STEP=0
for cmd in "${COMMANDS[@]}"; do
  ((STEP++))
  
  # Remove leading/trailing whitespace
  cmd=$(echo "$cmd" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  
  # Skip if empty after cleanup
  [[ -z "$cmd" ]] && continue
  
  if [[ "$VERBOSE" == "1" ]]; then
    echo "[Step $STEP] Running:"
    echo "  $cmd"
  else
    echo "[Step $STEP] $cmd"
  fi
  
  # Execute in the current shell so variables persist
  eval "$cmd" || {
    echo ""
    echo "❌ ERROR: Command failed at step $STEP"
    echo "   Command: $cmd"
    exit 1
  }
  
  echo ""
done

echo "=========================================="
echo "✓ Tutorial validation completed successfully"
echo "($STEP commands executed)"
echo "=========================================="
