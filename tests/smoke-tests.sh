#!/bin/sh
set -e

SERVER_URL="${SERVER_URL:-http://localhost:50477}"
BASE_URL="$SERVER_URL/api/v1"

# ── CLI setup ─────────────────────────────────────────────────────────────────
# Set env vars consumed by the CLI (no profile / config file needed)
# The SDK paths are relative to /api/v1 (per OpenAPI server URL)
export SOAT_BASE_URL="$SERVER_URL/api/v1"
SOAT_CLI="node /app/packages/cli/dist/esm/index.js"

expect_cli_error_status() {
  EXPECTED_STATUS="$1"
  shift

  set +e
  CLI_OUTPUT=$($SOAT_CLI "$@" 2>&1)
  CLI_EXIT=$?
  set -e

  if [ "$CLI_EXIT" -eq 0 ]; then
    echo "ERROR: Expected command '$*' to fail with status $EXPECTED_STATUS, but it succeeded" >&2
    echo "$CLI_OUTPUT" >&2
    exit 1
  fi

  CLI_STATUS=$(printf '%s\n' "$CLI_OUTPUT" | jq -r '.status // empty' 2>/dev/null)
  if [ "$CLI_STATUS" != "$EXPECTED_STATUS" ]; then
    echo "ERROR: Expected command '$*' to fail with status $EXPECTED_STATUS, got '$CLI_STATUS'" >&2
    echo "$CLI_OUTPUT" >&2
    exit 1
  fi
}

echo "=== Smoke test started ==="

# Remove unescaped control characters that may appear in LLM-generated text
# and break jq JSON parsing.
sanitize_json() {
  LC_ALL=C tr -d '\000-\037'
}

# 1. Bootstrap admin user (201 on first run, 409 if already exists)
echo "--- Bootstrapping admin user ---"
set +e
BOOTSTRAP_RESP=$($SOAT_CLI bootstrap-user --username admin --password 'Admin1234!' 2>&1)
BOOTSTRAP_EXIT=$?
set -e
if [ "$BOOTSTRAP_EXIT" -eq 0 ]; then
  BOOTSTRAP_STATUS=201
elif printf '%s\n' "$BOOTSTRAP_RESP" | jq -e '.status == 409' >/dev/null 2>&1; then
  BOOTSTRAP_STATUS=409
else
  echo "ERROR: Bootstrap failed" >&2
  echo "$BOOTSTRAP_RESP" >&2
  exit 1
fi
echo "Bootstrap status: $BOOTSTRAP_STATUS"

# 2. Login to get JWT token
echo "--- Logging in ---"
LOGIN_RESP=$($SOAT_CLI login-user --username admin --password 'Admin1234!')
TOKEN=$(echo "$LOGIN_RESP" | jq -r '.token')
ADMIN_USER_ID=$(echo "$LOGIN_RESP" | jq -r '.id')
if [ -z "$ADMIN_USER_ID" ] || [ "$ADMIN_USER_ID" = "null" ]; then
  echo "ERROR: Login response did not include user id" >&2
  echo "$LOGIN_RESP" >&2
  exit 1
fi
echo "Token: $(echo "$TOKEN" | cut -c1-20)..."

export SOAT_TOKEN="$TOKEN"
echo "CLI: $SOAT_CLI"

# 3. Create a project
echo "--- Creating project ---"
PROJECT_RESP=$($SOAT_CLI create-project --name smoke-test-project)
PROJECT_PUBLIC_ID=$(echo "$PROJECT_RESP" | jq -r '.id')
echo "Project id: $PROJECT_PUBLIC_ID"

# 3b. Policies module coverage
echo "--- Policies coverage ---"
POLICY_READ_RESP=$($SOAT_CLI create-policy \
  --document '{"statement":[{"effect":"Allow","action":["files:GetFile"]}]}' \
  --name smoke-read-policy)
POLICY_READ_ID=$(echo "$POLICY_READ_RESP" | jq -r '.id')
if [ -z "$POLICY_READ_ID" ] || [ "$POLICY_READ_ID" = "null" ]; then
  echo "ERROR: Failed to create read policy" >&2
  echo "$POLICY_READ_RESP" >&2
  exit 1
fi

POLICY_WRITE_RESP=$($SOAT_CLI create-policy \
  --document '{"statement":[{"effect":"Allow","action":["files:PutFile"]}]}' \
  --name smoke-write-policy)
POLICY_WRITE_ID=$(echo "$POLICY_WRITE_RESP" | jq -r '.id')
if [ -z "$POLICY_WRITE_ID" ] || [ "$POLICY_WRITE_ID" = "null" ]; then
  echo "ERROR: Failed to create write policy" >&2
  echo "$POLICY_WRITE_RESP" >&2
  exit 1
fi

# List policies
POLICY_LIST_RESP=$($SOAT_CLI list-policies)
if ! printf '%s\n' "$POLICY_LIST_RESP" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: LIST policies did not return an array" >&2
  echo "$POLICY_LIST_RESP" >&2
  exit 1
fi

# Get policy
POLICY_GET_RESP=$($SOAT_CLI get-policy --policy-id "$POLICY_READ_ID")
POLICY_GET_ID=$(printf '%s\n' "$POLICY_GET_RESP" | jq -r '.id')
if [ "$POLICY_GET_ID" != "$POLICY_READ_ID" ]; then
  echo "ERROR: GET policy returned mismatched id '$POLICY_GET_ID'" >&2
  exit 1
fi

# Update policy
POLICY_UPDATE_RESP=$($SOAT_CLI update-policy --policy-id "$POLICY_READ_ID" \
  --document '{"statement":[{"effect":"Allow","action":["files:GetFile","files:ListFiles"]}]}' \
  --name smoke-read-policy-updated)
if ! printf '%s\n' "$POLICY_UPDATE_RESP" | jq -e --arg id "$POLICY_READ_ID" '.id == $id' >/dev/null 2>&1; then
  echo "ERROR: PUT policy did not return updated policy" >&2
  echo "$POLICY_UPDATE_RESP" >&2
  exit 1
fi

# Attach policy to admin user
$SOAT_CLI attach-user-policies --user-id "$ADMIN_USER_ID" --policy_ids "[\"$POLICY_READ_ID\",\"$POLICY_WRITE_ID\"]"

# Get user policies
USER_POLICIES_RESP=$($SOAT_CLI get-user-policies --user-id "$ADMIN_USER_ID")
if ! printf '%s\n' "$USER_POLICIES_RESP" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: GET user policies did not return an array" >&2
  echo "$USER_POLICIES_RESP" >&2
  exit 1
fi
echo "Policies coverage: OK"

# 3c. API keys module coverage
echo "--- API keys coverage ---"
API_KEY_RESP=$($SOAT_CLI create-api-key \
  --name smoke-api-key \
  --project_id "$PROJECT_PUBLIC_ID" \
  --policy_ids "[\"$POLICY_READ_ID\"]")
API_KEY_ID=$(echo "$API_KEY_RESP" | jq -r '.id')
API_KEY_RAW=$(echo "$API_KEY_RESP" | jq -r '.key')
if [ -z "$API_KEY_ID" ] || [ "$API_KEY_ID" = "null" ]; then
  echo "ERROR: Failed to create api-key" >&2
  echo "$API_KEY_RESP" >&2
  exit 1
fi
if [ -z "$API_KEY_RAW" ] || [ "$API_KEY_RAW" = "null" ]; then
  echo "ERROR: Expected full api key on creation response" >&2
  echo "$API_KEY_RESP" >&2
  exit 1
fi

# GET api-key (key field must not appear)
API_KEY_GET_RESP=$($SOAT_CLI get-api-key --api-key-id "$API_KEY_ID")
if printf '%s\n' "$API_KEY_GET_RESP" | jq -e '.key' >/dev/null 2>&1; then
  echo "ERROR: key field must not appear in GET api-key response" >&2
  exit 1
fi

# UPDATE api-key
API_KEY_PUT_RESP=$($SOAT_CLI update-api-key --api-key-id "$API_KEY_ID" \
  --name smoke-api-key-updated \
  --policy_ids "[\"$POLICY_READ_ID\",\"$POLICY_WRITE_ID\"]")
API_KEY_UPDATED_NAME=$(printf '%s\n' "$API_KEY_PUT_RESP" | jq -r '.name')
if [ "$API_KEY_UPDATED_NAME" != "smoke-api-key-updated" ]; then
  echo "ERROR: PUT api-key did not update name" >&2
  echo "$API_KEY_PUT_RESP" >&2
  exit 1
fi

# Verify API key authentication works
set +e
SOAT_TOKEN="$API_KEY_RAW" $SOAT_CLI list-files >/dev/null 2>&1
API_KEY_AUTH_STATUS=$?
set -e
if [ "$API_KEY_AUTH_STATUS" != "0" ]; then
  echo "ERROR: API key auth failed" >&2
  exit 1
fi

# DELETE api-key
$SOAT_CLI delete-api-key --api-key-id "$API_KEY_ID"
expect_cli_error_status 404 get-api-key --api-key-id "$API_KEY_ID"
echo "API keys coverage: OK"

# Delete policies (cleanup + CRUD coverage)
$SOAT_CLI delete-policy --policy-id "$POLICY_READ_ID"
expect_cli_error_status 404 get-policy --policy-id "$POLICY_READ_ID"
echo "Policy DELETE coverage: OK"

# 3d. Secrets module coverage
echo "--- Secrets coverage ---"
SECRET_CREATE_RESP=$($SOAT_CLI create-secret \
  --project_id "$PROJECT_PUBLIC_ID" --name smoke-secret --value supersecretvalue)
SECRET_ID=$(echo "$SECRET_CREATE_RESP" | jq -r '.id')
if [ -z "$SECRET_ID" ] || [ "$SECRET_ID" = "null" ]; then
  echo "ERROR: Failed to create secret" >&2
  echo "$SECRET_CREATE_RESP" >&2
  exit 1
fi

SECRET_GET_RESP=$($SOAT_CLI get-secret --secret-id "$SECRET_ID")
if echo "$SECRET_GET_RESP" | jq -e '.value' >/dev/null 2>&1; then
  echo "ERROR: Secret value must not be returned" >&2
  echo "$SECRET_GET_RESP" >&2
  exit 1
fi

$SOAT_CLI update-secret --secret-id "$SECRET_ID" --name smoke-secret-updated --value updatedvalue

$SOAT_CLI delete-secret --secret-id "$SECRET_ID"

expect_cli_error_status 404 get-secret --secret-id "$SECRET_ID"
echo "Secrets coverage: OK"

# 3e. Actors module coverage
echo "--- Actors coverage ---"
ACTOR_CREATE_RESP=$($SOAT_CLI create-actor \
  --project_id "$PROJECT_PUBLIC_ID" --name smoke-actor --type customer --external_id smoke-ext-actor)
ACTOR_ID=$(echo "$ACTOR_CREATE_RESP" | jq -r '.id')
if [ -z "$ACTOR_ID" ] || [ "$ACTOR_ID" = "null" ]; then
  echo "ERROR: Failed to create actor" >&2
  echo "$ACTOR_CREATE_RESP" >&2
  exit 1
fi

$SOAT_CLI list-actors --project_id "$PROJECT_PUBLIC_ID"

$SOAT_CLI get-actor --actor-id "$ACTOR_ID"

$SOAT_CLI update-actor --actor-id "$ACTOR_ID" --name smoke-actor-updated

$SOAT_CLI delete-actor --actor-id "$ACTOR_ID"

expect_cli_error_status 404 get-actor --actor-id "$ACTOR_ID"
echo "Actors coverage: OK"

# 3f. Conversations module coverage
echo "--- Conversations coverage ---"
CONVO_ACTOR_RESP=$($SOAT_CLI create-actor \
  --project_id "$PROJECT_PUBLIC_ID" --name smoke-conversation-actor)
CONVO_ACTOR_ID=$(echo "$CONVO_ACTOR_RESP" | jq -r '.id')
if [ -z "$CONVO_ACTOR_ID" ] || [ "$CONVO_ACTOR_ID" = "null" ]; then
  echo "ERROR: Failed to create conversation actor" >&2
  echo "$CONVO_ACTOR_RESP" >&2
  exit 1
fi

CONVO_CREATE_RESP=$($SOAT_CLI create-conversation --project_id "$PROJECT_PUBLIC_ID")
CONVO_ID=$(echo "$CONVO_CREATE_RESP" | jq -r '.id')
if [ -z "$CONVO_ID" ] || [ "$CONVO_ID" = "null" ]; then
  echo "ERROR: Failed to create conversation" >&2
  echo "$CONVO_CREATE_RESP" >&2
  exit 1
fi

$SOAT_CLI list-conversations --project_id "$PROJECT_PUBLIC_ID"

CONVO_MSG_LIST_RESP=$($SOAT_CLI list-conversation-messages --conversation-id "$CONVO_ID")
if ! printf '%s\n' "$CONVO_MSG_LIST_RESP" | jq -e '((type == "array") or (type == "object" and (.data | type == "array")))' >/dev/null 2>&1; then
  echo "ERROR: LIST conversation messages did not return an array" >&2
  echo "$CONVO_MSG_LIST_RESP" >&2
  exit 1
fi

CONVO_ADD_MSG_RESP=$($SOAT_CLI add-conversation-message \
  --conversation-id "$CONVO_ID" --message "smoke conversation message" --actor_id "$CONVO_ACTOR_ID")
CONVO_DOC_ID=$(echo "$CONVO_ADD_MSG_RESP" | jq -r '.document_id')
if [ -z "$CONVO_DOC_ID" ] || [ "$CONVO_DOC_ID" = "null" ]; then
  echo "ERROR: Failed to add conversation message" >&2
  echo "$CONVO_ADD_MSG_RESP" >&2
  exit 1
fi

$SOAT_CLI remove-conversation-message --conversation-id "$CONVO_ID" --document-id "$CONVO_DOC_ID"

$SOAT_CLI update-conversation --conversation-id "$CONVO_ID" --status closed

$SOAT_CLI delete-conversation --conversation-id "$CONVO_ID"

expect_cli_error_status 404 get-conversation --conversation-id "$CONVO_ID"

$SOAT_CLI delete-actor --actor-id "$CONVO_ACTOR_ID"
echo "Conversations coverage: OK"

# 4. Upload a file via base64 (with path field)
echo "--- Uploading file ---"
echo "Hello, smoke test!" > /tmp/smoke.txt
SMOKE_FILE_B64=$(base64 /tmp/smoke.txt | tr -d '\n')
UPLOAD_RESP=$($SOAT_CLI upload-file-base64 \
  --project_id "$PROJECT_PUBLIC_ID" \
  --filename smoke.txt \
  --path /reports/smoke.txt \
  --content "$SMOKE_FILE_B64" \
  --content_type text/plain)
FILE_ID=$(echo "$UPLOAD_RESP" | jq -r '.id')
FILE_PATH=$(echo "$UPLOAD_RESP" | jq -r '.path')
echo "File id: $FILE_ID"
if [ "$FILE_PATH" != "/reports/smoke.txt" ]; then
  echo "ERROR: file path field expected '/reports/smoke.txt', got '$FILE_PATH'" >&2
  exit 1
fi
echo "File path: $FILE_PATH"

# 5. Get file metadata
echo "--- Getting file metadata ---"
GET_FILE_RESP=$($SOAT_CLI get-file --file-id "$FILE_ID")
GET_FILE_ID=$(printf '%s\n' "$GET_FILE_RESP" | jq -r '.id')
if [ "$GET_FILE_ID" != "$FILE_ID" ]; then
  echo "ERROR: GET file returned mismatched id '$GET_FILE_ID'" >&2
  exit 1
fi
echo "GET status: 200"

# 6. Download file and verify content
echo "--- Downloading file ---"
DOWNLOAD_RESP=$($SOAT_CLI download-file-base64 --file-id "$FILE_ID")
CONTENT=$(printf '%s\n' "$DOWNLOAD_RESP" | jq -r '.content' | base64 -d)
EXPECTED="Hello, smoke test!"
if [ "$CONTENT" != "$EXPECTED" ]; then
  echo "ERROR: Content mismatch. Got '$CONTENT', expected '$EXPECTED'" >&2
  exit 1
fi
echo "Content matches."

# 7. Update metadata
echo "--- Updating metadata ---"
PATCH_RESP=$($SOAT_CLI update-file-metadata --file-id "$FILE_ID" --metadata smoke-tested)
PATCH_ID=$(printf '%s\n' "$PATCH_RESP" | jq -r '.id')
if [ "$PATCH_ID" != "$FILE_ID" ]; then
  echo "ERROR: PATCH metadata did not update expected file" >&2
  exit 1
fi
echo "PATCH status: 200"

# 8. Delete file
echo "--- Deleting file ---"
$SOAT_CLI delete-file --file-id "$FILE_ID"
echo "DELETE status: 204"

# 9. Verify file is gone (404)
echo "--- Verifying deletion ---"
expect_cli_error_status 404 get-file --file-id "$FILE_ID"
echo "File correctly returns 404 after deletion."

# 10. Create first document (with path field)
echo "--- Creating first document ---"
DOC1_RESP=$($SOAT_CLI create-document \
  --project_id "$PROJECT_PUBLIC_ID" \
  --content "The quick brown fox jumps over the lazy dog" \
  --filename fox.txt \
  --path /animals/fox.txt)
DOC1_ID=$(echo "$DOC1_RESP" | jq -r '.id')
DOC1_PATH=$(echo "$DOC1_RESP" | jq -r '.path')
echo "Document 1 id: $DOC1_ID"
if [ "$DOC1_PATH" != "/animals/fox.txt" ]; then
  echo "ERROR: document path field expected '/animals/fox.txt', got '$DOC1_PATH'" >&2
  exit 1
fi
echo "Document 1 path: $DOC1_PATH"

# 11. Create second document
echo "--- Creating second document ---"
DOC2_RESP=$($SOAT_CLI create-document \
  --project_id "$PROJECT_PUBLIC_ID" \
  --content "Machine learning models require large amounts of training data" \
  --filename ml.txt \
  --path /tech/ml.txt)
DOC2_ID=$(echo "$DOC2_RESP" | jq -r '.id')
echo "Document 2 id: $DOC2_ID"

# 11b. Verify path persists on GET /documents/:id
echo "--- Verifying document path field on GET ---"
GET_DOC1_RESP=$($SOAT_CLI get-document --document-id "$DOC1_ID")
GET_DOC1_PATH=$(echo "$GET_DOC1_RESP" | jq -r '.path')
if [ "$GET_DOC1_PATH" != "/animals/fox.txt" ]; then
  echo "ERROR: GET document path expected '/animals/fox.txt', got '$GET_DOC1_PATH'" >&2
  exit 1
fi
echo "GET document path: OK"

# 11c. Search documents by path prefix
echo "--- Search documents by path prefix ---"
PATH_SEARCH_RESP=$($SOAT_CLI search-documents \
  --project_id "$PROJECT_PUBLIC_ID" \
  --paths '["/animals/"]')
PATH_SEARCH_COUNT=$(echo "$PATH_SEARCH_RESP" | jq '.documents | length')
if [ "$PATH_SEARCH_COUNT" -lt 1 ]; then
  echo "ERROR: path-prefix search returned $PATH_SEARCH_COUNT results, expected at least 1" >&2
  exit 1
fi
echo "Path-prefix search returned $PATH_SEARCH_COUNT result(s): OK"

# 12. Search documents
echo "--- Searching documents ---"
SEARCH_RESP=$($SOAT_CLI search-documents \
  --project_id "$PROJECT_PUBLIC_ID" \
  --search "fox animal jumping" \
  --limit 5)
SEARCH_COUNT=$(echo "$SEARCH_RESP" | jq '.documents | length')
if [ "$SEARCH_COUNT" -lt 1 ]; then
  echo "ERROR: Document search returned $SEARCH_COUNT results, expected at least 1" >&2
  exit 1
fi
echo "Search returned $SEARCH_COUNT result(s)."

# 13. Delete documents
echo "--- Deleting documents ---"
$SOAT_CLI delete-document --document-id "$DOC1_ID"
$SOAT_CLI delete-document --document-id "$DOC2_ID"
echo "Documents deleted."

# 14. Chat completion — 401 without auth
echo "--- Chat completion: 401 without auth ---"
SOAT_TOKEN=invalid expect_cli_error_status 401 create-chat-completion --messages '[{"role":"user","content":"hello"}]'
echo "401 without auth: OK"

# 15. Chat completion — 400 without messages
echo "--- Chat completion: 400 without messages ---"
expect_cli_error_status 400 create-chat-completion
echo "400 without messages: OK"

# 16. Chat completion — valid non-streaming request (Ollama fallback)
echo "--- Chat completion: valid request ---"
CHAT_RESP=$($SOAT_CLI create-chat-completion --messages '[{"role":"user","content":"say hello"}]')
CHAT_OBJECT=$(echo "$CHAT_RESP" | jq -r '.object')
if [ "$CHAT_OBJECT" != "chat.completion" ]; then
  echo "ERROR: Expected object=chat.completion, got $CHAT_OBJECT" >&2
  echo "$CHAT_RESP" >&2
  exit 1
fi
echo "Chat completion OK. Response: $(echo "$CHAT_RESP" | jq -r '.choices[0].message.content' | cut -c1-60)"

# 17. Chat completion — SSE streaming request
echo "--- Chat completion: SSE streaming ---"
CHAT_SSE_RESP=$($SOAT_CLI create-chat-completion --messages '[{"role":"user","content":"say hello"}]' --stream true)
if ! printf '%s\n' "$CHAT_SSE_RESP" | grep -q "data: \[DONE\]"; then
  echo "ERROR: Chat SSE stream missing 'data: [DONE]'" >&2
  echo "$CHAT_SSE_RESP" >&2
  exit 1
fi
echo "Chat SSE stream OK."
echo "--- Chat SSE stream output ---"
echo "$CHAT_SSE_RESP"

# 18. Create AI provider (Ollama with qwen2.5:0.5b available in test env)
echo "--- Creating AI provider ---"
AI_PROVIDER_RESP=$($SOAT_CLI create-ai-provider \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name smoke-ollama \
  --provider ollama \
  --default_model "qwen2.5:0.5b" \
  --base_url "http://ollama:11434")
AI_PROVIDER_ID=$(echo "$AI_PROVIDER_RESP" | jq -r '.id')
echo "AI Provider id: $AI_PROVIDER_ID"

# 19. Create an HTTP agent tool that calls GET /api/v1/projects on the SOAT server
echo "--- Creating HTTP agent tool (list-projects) ---"
TOOL_RESP=$($SOAT_CLI create-agent-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name list-projects \
  --type http \
  --description "Lists all projects from the SOAT API. Call this tool whenever the user asks for the list of projects." \
  --parameters '{"type":"object","properties":{},"required":[]}' \
  --execute "{\"url\":\"$SERVER_URL/api/v1/projects\",\"headers\":{\"Authorization\":\"Bearer $TOKEN\"}}")
TOOL_ID=$(echo "$TOOL_RESP" | jq -r '.id')
echo "Agent Tool id: $TOOL_ID"

# 20. Create an agent with the list-projects tool
echo "--- Creating agent ---"
AGENT_RESP=$($SOAT_CLI create-agent \
  --project_id "$PROJECT_PUBLIC_ID" \
  --ai_provider_id "$AI_PROVIDER_ID" \
  --name project-lister \
  --instructions "You are a helpful assistant. When the user asks you to list projects, you MUST call the list-projects tool and return the results. Always use the tool, never make up data." \
  --tool_ids "[\"$TOOL_ID\"]" \
  --max_steps 5)
AGENT_ID=$(echo "$AGENT_RESP" | jq -r '.id')
echo "Agent id: $AGENT_ID"

# 21. Run the agent — ask it to list projects (non-streaming)
echo "--- Running agent generation ---"
GEN_RESP=$($SOAT_CLI create-agent-generation --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"List all the projects. Use the list-projects tool."}]' | sanitize_json)
echo "Generation response:"
printf '%s\n' "$GEN_RESP" | jq .

GEN_STATUS=$(printf '%s\n' "$GEN_RESP" | jq -r '.status')
if [ "$GEN_STATUS" != "completed" ]; then
  echo "ERROR: Expected generation status 'completed', got '$GEN_STATUS'" >&2
  exit 1
fi
echo "Generation completed."

# 22. Verify the agent output contains the project name
GEN_CONTENT=$(printf '%s\n' "$GEN_RESP" | jq -r '.output.content')
echo "Agent output: $GEN_CONTENT"
if echo "$GEN_CONTENT" | grep -qi "smoke-test-project"; then
  echo "Agent output contains project name: OK"
else
  echo "WARNING: Agent output may not contain the exact project name (LLM response varies), but generation completed successfully."
fi

# 22b. Run the same agent generation with SSE streaming
echo "--- Running agent generation (SSE stream) ---"
AGENT_STREAM_RESP=$($SOAT_CLI create-agent-generation --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"List all the projects. Use the list-projects tool."}]' \
  --stream true)
if ! printf '%s\n' "$AGENT_STREAM_RESP" | grep -q "data: \[DONE\]"; then
  echo "ERROR: Agent SSE stream missing 'data: [DONE]'" >&2
  echo "$AGENT_STREAM_RESP" >&2
  exit 1
fi
echo "Agent SSE stream OK."

# 23. Cleanup — delete agent
echo "--- Deleting agent ---"
$SOAT_CLI delete-agent --agent-id "$AGENT_ID"
echo "Agent deleted."

# 24. Cleanup — delete agent tool
echo "--- Deleting agent tool ---"
$SOAT_CLI delete-agent-tool --tool-id "$TOOL_ID"
echo "Agent tool deleted."

# 25. Create an MCP agent tool pointing at the SOAT MCP server
echo "--- Creating MCP agent tool ---"
MCP_TOOL_RESP=$($SOAT_CLI create-agent-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name soat-mcp \
  --type mcp \
  --description "SOAT MCP server - exposes all SOAT tools over the MCP protocol." \
  --mcp "{\"url\":\"$SERVER_URL/mcp\",\"headers\":{\"Authorization\":\"Bearer $TOKEN\"}}")
MCP_TOOL_ID=$(echo "$MCP_TOOL_RESP" | jq -r '.id')
echo "MCP Agent Tool id: $MCP_TOOL_ID"

# 26. Create an agent backed by the MCP tool
echo "--- Creating MCP agent ---"
MCP_AGENT_RESP=$($SOAT_CLI create-agent \
  --project_id "$PROJECT_PUBLIC_ID" \
  --ai_provider_id "$AI_PROVIDER_ID" \
  --name mcp-agent-lister \
  --instructions "You are a helpful assistant with access to SOAT tools via MCP. When asked to list agents, call the list-agents MCP tool and return the results. Always use the tool." \
  --tool_ids "[\"$MCP_TOOL_ID\"]" \
  --max_steps 5)
MCP_AGENT_ID=$(echo "$MCP_AGENT_RESP" | jq -r '.id')
echo "MCP Agent id: $MCP_AGENT_ID"

# 27. Ask the agent to list agents via MCP
echo "--- Running MCP agent generation ---"
MCP_GEN_RESP=$($SOAT_CLI create-agent-generation --agent-id "$MCP_AGENT_ID" \
  --messages '[{"role":"user","content":"List all agents. Use the list-agents tool."}]' | sanitize_json)
echo "MCP Generation response:"
printf '%s\n' "$MCP_GEN_RESP" | jq .

MCP_GEN_STATUS=$(printf '%s\n' "$MCP_GEN_RESP" | jq -r '.status')
if [ "$MCP_GEN_STATUS" != "completed" ]; then
  echo "ERROR: Expected MCP generation status 'completed', got '$MCP_GEN_STATUS'" >&2
  exit 1
fi
echo "MCP generation completed."

# 28. Verify the agent output mentions agent data (the mcp-agent-lister we just created)
MCP_GEN_CONTENT=$(printf '%s\n' "$MCP_GEN_RESP" | jq -r '.output.content')
echo "MCP Agent output: $MCP_GEN_CONTENT"
if echo "$MCP_GEN_CONTENT" | grep -qi "mcp-agent-lister\|agent"; then
  echo "MCP Agent output mentions agents: OK"
else
  echo "WARNING: MCP Agent output may not contain exact agent names (LLM response varies), but generation completed successfully."
fi

# 29. Cleanup — delete MCP agent
echo "--- Deleting MCP agent ---"
$SOAT_CLI delete-agent --agent-id "$MCP_AGENT_ID"
echo "MCP Agent deleted."

# 30. Cleanup — delete MCP agent tool
echo "--- Deleting MCP agent tool ---"
$SOAT_CLI delete-agent-tool --tool-id "$MCP_TOOL_ID"
echo "MCP Agent tool deleted."

# ── Client Tool Tests ────────────────────────────────────────────────────────

# 31. Create a client-type agent tool
echo "--- Creating client agent tool ---"
CLIENT_TOOL_RESP=$($SOAT_CLI create-agent-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name get_weather \
  --type client \
  --description "Returns the current weather for a given city." \
  --parameters '{"type":"object","properties":{"city":{"type":"string","description":"The city name"}},"required":["city"]}')
CLIENT_TOOL_ID=$(echo "$CLIENT_TOOL_RESP" | jq -r '.id')
if [ -z "$CLIENT_TOOL_ID" ] || [ "$CLIENT_TOOL_ID" = "null" ]; then
  echo "ERROR: Failed to create client agent tool" >&2
  echo "$CLIENT_TOOL_RESP" >&2
  exit 1
fi
echo "Client Agent Tool id: $CLIENT_TOOL_ID"

# 32. Create an agent that uses the client tool
echo "--- Creating client-tool agent ---"
CLIENT_AGENT_RESP=$($SOAT_CLI create-agent \
  --project_id "$PROJECT_PUBLIC_ID" \
  --ai_provider_id "$AI_PROVIDER_ID" \
  --name weather-agent \
  --instructions "You are a weather assistant. When the user asks about the weather, call the get_weather tool with the city name." \
  --tool_ids "[\"$CLIENT_TOOL_ID\"]" \
  --tool_choice '{"type":"tool","tool_name":"get_weather"}' \
  --max_steps 3)
CLIENT_AGENT_ID=$(echo "$CLIENT_AGENT_RESP" | jq -r '.id')
if [ -z "$CLIENT_AGENT_ID" ] || [ "$CLIENT_AGENT_ID" = "null" ]; then
  echo "ERROR: Failed to create client-tool agent" >&2
  echo "$CLIENT_AGENT_RESP" >&2
  exit 1
fi
echo "Client Agent id: $CLIENT_AGENT_ID"

# 33. Start a generation — expect requires_action with a tool call
echo "--- Starting client-tool generation ---"
CLIENT_GEN_RESP=''
CLIENT_GEN_STATUS=''
CLIENT_ATTEMPT=1
while [ "$CLIENT_ATTEMPT" -le 3 ]; do
  CLIENT_GEN_RESP=$($SOAT_CLI create-agent-generation --agent-id "$CLIENT_AGENT_ID" \
    --messages '[{"role":"user","content":"Call get_weather with city Paris and wait for tool output. Do not answer directly."}]' | sanitize_json)
  CLIENT_GEN_STATUS=$(printf '%s\n' "$CLIENT_GEN_RESP" | jq -r '.status')
  if [ "$CLIENT_GEN_STATUS" = "requires_action" ]; then
    break
  fi
  echo "Attempt $CLIENT_ATTEMPT did not yield requires_action (got '$CLIENT_GEN_STATUS'); retrying..."
  CLIENT_ATTEMPT=$((CLIENT_ATTEMPT + 1))
done

echo "Client generation response:"
printf '%s\n' "$CLIENT_GEN_RESP" | jq .

if [ "$CLIENT_GEN_STATUS" != "requires_action" ]; then
  echo "ERROR: Expected status 'requires_action', got '$CLIENT_GEN_STATUS'" >&2
  exit 1
fi
echo "Generation paused for client tool execution: OK"

CLIENT_GEN_ID=$(printf '%s\n' "$CLIENT_GEN_RESP" | jq -r '.id')
CLIENT_TOOL_CALL_ID=$(printf '%s\n' "$CLIENT_GEN_RESP" | jq -r '.required_action.tool_calls[0].id // .requiredAction.toolCalls[0].id // empty')
CLIENT_TRACE_ID=$(printf '%s\n' "$CLIENT_GEN_RESP" | jq -r '.trace_id')
CLIENT_TOOL_CALL_NAME=$(printf '%s\n' "$CLIENT_GEN_RESP" | jq -r '.required_action.tool_calls[0].tool_name // .required_action.tool_calls[0].toolName // .requiredAction.toolCalls[0].tool_name // .requiredAction.toolCalls[0].toolName // empty')
CLIENT_TOOL_CALL_CITY=$(printf '%s\n' "$CLIENT_GEN_RESP" | jq -r '.required_action.tool_calls[0].args.city // .requiredAction.toolCalls[0].args.city // empty')

if [ -z "$CLIENT_TOOL_CALL_ID" ] || [ "$CLIENT_TOOL_CALL_ID" = "null" ]; then
  echo "ERROR: Expected at least one pending client tool call id" >&2
  exit 1
fi
if [ "$CLIENT_TOOL_CALL_NAME" != "get_weather" ]; then
  echo "ERROR: Expected tool name 'get_weather', got '$CLIENT_TOOL_CALL_NAME'" >&2
  exit 1
fi
if [ "$CLIENT_TOOL_CALL_CITY" != "Paris" ]; then
  echo "ERROR: Expected get_weather city='Paris', got '$CLIENT_TOOL_CALL_CITY'" >&2
  exit 1
fi

echo "Generation id: $CLIENT_GEN_ID"
echo "Tool call id: $CLIENT_TOOL_CALL_ID"

# 34. Submit tool output (simulate client executing get_weather)
echo "--- Submitting client tool output ---"
SUBMIT_RESP=$($SOAT_CLI submit-agent-tool-outputs \
  --agent-id "$CLIENT_AGENT_ID" \
  --generation-id "$CLIENT_GEN_ID" \
  --tool_outputs "[{\"tool_call_id\":\"$CLIENT_TOOL_CALL_ID\",\"output\":{\"city\":\"Paris\",\"temperature\":\"18C\",\"condition\":\"Partly cloudy\"}}]" | sanitize_json)
echo "Submit tool output response:"
echo "$SUBMIT_RESP" | jq .

SUBMIT_STATUS=$(echo "$SUBMIT_RESP" | jq -r '.status')
if [ "$SUBMIT_STATUS" != "completed" ]; then
  echo "ERROR: Expected final status 'completed', got '$SUBMIT_STATUS'" >&2
  exit 1
fi
echo "Client tool generation completed after tool output: OK"

# 34b. Trace checks (list traces + fetch current generation trace)
echo "--- Verifying trace endpoints ---"
TRACES_RESP=$($SOAT_CLI list-agent-traces --project_id "$PROJECT_PUBLIC_ID")
if ! printf '%s\n' "$TRACES_RESP" | jq -e '((type == "array") or (type == "object" and (.data | type == "array")))' >/dev/null 2>&1; then
  echo "ERROR: list-agent-traces did not return a JSON array/data array" >&2
  echo "$TRACES_RESP" >&2
  exit 1
fi
echo "Trace listing endpoint: OK"

if [ -n "$CLIENT_TRACE_ID" ] && [ "$CLIENT_TRACE_ID" != "null" ]; then
  TRACE_GET_RESP=$($SOAT_CLI get-agent-trace --trace-id "$CLIENT_TRACE_ID")
  TRACE_RETURNED_ID=$(printf '%s\n' "$TRACE_GET_RESP" | jq -r '.id // empty')
  if [ "$TRACE_RETURNED_ID" != "$CLIENT_TRACE_ID" ]; then
    echo "ERROR: Trace endpoint returned mismatched id '$TRACE_RETURNED_ID' for '$CLIENT_TRACE_ID'" >&2
    echo "$TRACE_GET_RESP" >&2
    exit 1
  fi
  echo "Trace retrieval endpoint: OK"
else
  echo "ERROR: Generation response did not include trace_id" >&2
  exit 1
fi

# 35. Cleanup — delete client-tool agent
echo "--- Deleting client-tool agent ---"
$SOAT_CLI delete-agent --agent-id "$CLIENT_AGENT_ID"
echo "Client-tool agent deleted."

# 36. Cleanup — delete client agent tool
echo "--- Deleting client agent tool ---"
$SOAT_CLI delete-agent-tool --tool-id "$CLIENT_TOOL_ID"
echo "Client agent tool deleted."

# ── SOAT Tool Tests ─────────────────────────────────────────────────────────

# 37. Create a SOAT agent tool exposing list-projects action
echo "--- Creating SOAT agent tool ---"
SOAT_TOOL_RESP=$($SOAT_CLI create-agent-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name soat-platform \
  --type soat \
  --description "SOAT platform actions exposed as tools." \
  --actions '["list-projects"]')
SOAT_TOOL_ID=$(echo "$SOAT_TOOL_RESP" | jq -r '.id')
if [ -z "$SOAT_TOOL_ID" ] || [ "$SOAT_TOOL_ID" = "null" ]; then
  echo "ERROR: Failed to create SOAT agent tool" >&2
  echo "$SOAT_TOOL_RESP" >&2
  exit 1
fi
echo "SOAT Agent Tool id: $SOAT_TOOL_ID"

# 38. Create an agent that uses the SOAT tool
echo "--- Creating SOAT agent ---"
SOAT_AGENT_RESP=$($SOAT_CLI create-agent \
  --project_id "$PROJECT_PUBLIC_ID" \
  --ai_provider_id "$AI_PROVIDER_ID" \
  --name soat-project-lister \
  --instructions "You are a helpful assistant. Use the SOAT list-projects action to list projects for the user." \
  --tool_ids "[\"$SOAT_TOOL_ID\"]" \
  --max_steps 5)
SOAT_AGENT_ID=$(echo "$SOAT_AGENT_RESP" | jq -r '.id')
if [ -z "$SOAT_AGENT_ID" ] || [ "$SOAT_AGENT_ID" = "null" ]; then
  echo "ERROR: Failed to create SOAT agent" >&2
  echo "$SOAT_AGENT_RESP" >&2
  exit 1
fi
echo "SOAT Agent id: $SOAT_AGENT_ID"

# 39. Run generation with the SOAT-backed agent
echo "--- Running SOAT agent generation ---"
SOAT_GEN_RESP=$($SOAT_CLI create-agent-generation --agent-id "$SOAT_AGENT_ID" \
  --messages '[{"role":"user","content":"List all projects. Use the soat-platform tool."}]' | sanitize_json)
echo "SOAT generation response:"
printf '%s\n' "$SOAT_GEN_RESP" | jq .

SOAT_GEN_STATUS=$(printf '%s\n' "$SOAT_GEN_RESP" | jq -r '.status')
if [ "$SOAT_GEN_STATUS" != "completed" ]; then
  echo "ERROR: Expected SOAT generation status 'completed', got '$SOAT_GEN_STATUS'" >&2
  exit 1
fi
echo "SOAT generation completed."

# 40. Verify the SOAT agent output references project data
SOAT_GEN_CONTENT=$(printf '%s\n' "$SOAT_GEN_RESP" | jq -r '.output.content')
echo "SOAT Agent output: $SOAT_GEN_CONTENT"
if echo "$SOAT_GEN_CONTENT" | grep -qi "smoke-test-project\|project"; then
  echo "SOAT Agent output mentions projects: OK"
else
  echo "WARNING: SOAT Agent output may not contain exact project names (LLM response varies), but generation completed successfully."
fi

# 41. Cleanup — delete SOAT agent
echo "--- Deleting SOAT agent ---"
$SOAT_CLI delete-agent --agent-id "$SOAT_AGENT_ID"
echo "SOAT agent deleted."

# 42. Cleanup — delete SOAT agent tool
echo "--- Deleting SOAT agent tool ---"
$SOAT_CLI delete-agent-tool --tool-id "$SOAT_TOOL_ID"
echo "SOAT agent tool deleted."

# ── Conversations Generate Tests ─────────────────────────────────────────────

# 43. Create a bare agent (no tools) for conversation generation
echo "--- Creating conversation-generate agent ---"
CONVO_GEN_AGENT_RESP=$($SOAT_CLI create-agent \
  --project_id "$PROJECT_PUBLIC_ID" \
  --ai_provider_id "$AI_PROVIDER_ID" \
  --name convo-gen-agent \
  --instructions "You are a helpful conversation participant. Reply concisely.")
CONVO_GEN_AGENT_ID=$(echo "$CONVO_GEN_AGENT_RESP" | jq -r '.id')
if [ -z "$CONVO_GEN_AGENT_ID" ] || [ "$CONVO_GEN_AGENT_ID" = "null" ]; then
  echo "ERROR: Failed to create conversation-generate agent" >&2
  echo "$CONVO_GEN_AGENT_RESP" >&2
  exit 1
fi
echo "Conversation-generate agent id: $CONVO_GEN_AGENT_ID"

# 44. Create a conversation with a name (new feature)
echo "--- Creating named conversation ---"
NAMED_CONVO_RESP=$($SOAT_CLI create-conversation \
  --project_id "$PROJECT_PUBLIC_ID" --name smoke-named-conversation)
NAMED_CONVO_ID=$(echo "$NAMED_CONVO_RESP" | jq -r '.id')
NAMED_CONVO_NAME=$(echo "$NAMED_CONVO_RESP" | jq -r '.name')
if [ -z "$NAMED_CONVO_ID" ] || [ "$NAMED_CONVO_ID" = "null" ]; then
  echo "ERROR: Failed to create named conversation" >&2
  echo "$NAMED_CONVO_RESP" >&2
  exit 1
fi
if [ "$NAMED_CONVO_NAME" != "smoke-named-conversation" ]; then
  echo "ERROR: Expected conversation name 'smoke-named-conversation', got '$NAMED_CONVO_NAME'" >&2
  exit 1
fi
echo "Named conversation id: $NAMED_CONVO_ID, name: $NAMED_CONVO_NAME"

# 44b. PATCH the conversation name
echo "--- Patching conversation name ---"
NAME_PATCH_RESP=$($SOAT_CLI update-conversation --conversation-id "$NAMED_CONVO_ID" --name smoke-renamed-conversation)
NAME_PATCH_NAME=$(echo "$NAME_PATCH_RESP" | jq -r '.name')
if [ "$NAME_PATCH_NAME" != "smoke-renamed-conversation" ]; then
  echo "ERROR: Expected patched name 'smoke-renamed-conversation', got '$NAME_PATCH_NAME'" >&2
  exit 1
fi
echo "Conversation rename: OK"

# 45. Create an agent-backed actor using the convenience endpoint POST /agents/:id/actors
echo "--- Creating agent-backed actor via convenience endpoint ---"
AGENT_ACTOR_RESP=$($SOAT_CLI create-agent-actor --agent-id "$CONVO_GEN_AGENT_ID" \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name convo-agent-actor \
  --instructions "Reply as a friendly assistant.")
AGENT_ACTOR_ID=$(echo "$AGENT_ACTOR_RESP" | jq -r '.id')
AGENT_ACTOR_AGENT_ID=$(echo "$AGENT_ACTOR_RESP" | jq -r '.agent_id')
AGENT_ACTOR_INSTRUCTIONS=$(echo "$AGENT_ACTOR_RESP" | jq -r '.instructions')
if [ -z "$AGENT_ACTOR_ID" ] || [ "$AGENT_ACTOR_ID" = "null" ]; then
  echo "ERROR: Failed to create agent-backed actor" >&2
  echo "$AGENT_ACTOR_RESP" >&2
  exit 1
fi
if [ "$AGENT_ACTOR_AGENT_ID" != "$CONVO_GEN_AGENT_ID" ]; then
  echo "ERROR: Expected actor.agent_id='$CONVO_GEN_AGENT_ID', got '$AGENT_ACTOR_AGENT_ID'" >&2
  exit 1
fi
if [ "$AGENT_ACTOR_INSTRUCTIONS" != "Reply as a friendly assistant." ]; then
  echo "ERROR: Expected actor.instructions='Reply as a friendly assistant.', got '$AGENT_ACTOR_INSTRUCTIONS'" >&2
  exit 1
fi
echo "Agent-backed actor id: $AGENT_ACTOR_ID, agent_id: $AGENT_ACTOR_AGENT_ID, instructions: OK"

# 45b. Verify actor fields on GET /actors/:id
echo "--- Verifying actor shape on GET ---"
ACTOR_GET_RESP=$($SOAT_CLI get-actor --actor-id "$AGENT_ACTOR_ID")
ACTOR_GET_AGENT_ID=$(echo "$ACTOR_GET_RESP" | jq -r '.agent_id')
ACTOR_GET_INSTRUCTIONS=$(echo "$ACTOR_GET_RESP" | jq -r '.instructions')
if [ "$ACTOR_GET_AGENT_ID" != "$CONVO_GEN_AGENT_ID" ]; then
  echo "ERROR: GET actor returned agent_id='$ACTOR_GET_AGENT_ID', expected '$CONVO_GEN_AGENT_ID'" >&2
  exit 1
fi
if [ "$ACTOR_GET_INSTRUCTIONS" != "Reply as a friendly assistant." ]; then
  echo "ERROR: GET actor returned instructions='$ACTOR_GET_INSTRUCTIONS'" >&2
  exit 1
fi
echo "GET /actors/:id shape: OK"

# 45c. Verify mutual exclusion: actor with both agent_id and chat_id must fail (400)
echo "--- Verifying actor agent_id+chat_id mutual exclusion ---"
expect_cli_error_status 400 create-actor \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name bad-actor \
  --agent_id "$CONVO_GEN_AGENT_ID" \
  --chat_id fake-id
echo "Actor mutual exclusion (agent_id+chat_id): OK (400 as expected)"

# 46. Create a plain user actor for the conversation
echo "--- Creating user actor for conversation ---"
USER_ACTOR_RESP=$($SOAT_CLI create-actor --project_id "$PROJECT_PUBLIC_ID" --name convo-user-actor)
USER_ACTOR_ID=$(echo "$USER_ACTOR_RESP" | jq -r '.id')
if [ -z "$USER_ACTOR_ID" ] || [ "$USER_ACTOR_ID" = "null" ]; then
  echo "ERROR: Failed to create user actor" >&2
  echo "$USER_ACTOR_RESP" >&2
  exit 1
fi
echo "User actor id: $USER_ACTOR_ID"

# 47. Add a user message to the conversation
echo "--- Adding user message to conversation ---"
USER_MSG_RESP=$($SOAT_CLI add-conversation-message \
  --conversation-id "$NAMED_CONVO_ID" --message "Hello, how are you?" --actor_id "$USER_ACTOR_ID")
USER_MSG_DOC_ID=$(echo "$USER_MSG_RESP" | jq -r '.document_id')
if [ -z "$USER_MSG_DOC_ID" ] || [ "$USER_MSG_DOC_ID" = "null" ]; then
  echo "ERROR: Failed to add user message" >&2
  echo "$USER_MSG_RESP" >&2
  exit 1
fi
echo "User message added (document_id: $USER_MSG_DOC_ID)"

# 48. Generate a conversation message with the agent-backed actor
# (poll with a retry loop — generate may be slow with Ollama)
echo "--- Generating conversation message ---"
CONVO_GEN_STATUS="in_progress"
CONVO_GEN_ATTEMPTS=0
while [ "$CONVO_GEN_STATUS" = "in_progress" ] && [ "$CONVO_GEN_ATTEMPTS" -lt "30" ]; do
  CONVO_GEN_RESP=$($SOAT_CLI generate-conversation-message --conversation-id "$NAMED_CONVO_ID" --actor_id "$AGENT_ACTOR_ID" | sanitize_json)
  CONVO_GEN_STATUS=$(printf '%s\n' "$CONVO_GEN_RESP" | jq -r '.status')
  CONVO_GEN_ATTEMPTS=$((CONVO_GEN_ATTEMPTS + 1))
  if [ "$CONVO_GEN_STATUS" = "in_progress" ]; then
    sleep 2
  fi
done
echo "Conversation generate response:"
printf '%s\n' "$CONVO_GEN_RESP" | jq .
if [ "$CONVO_GEN_STATUS" != "completed" ]; then
  echo "ERROR: Expected conversation generate status 'completed', got '$CONVO_GEN_STATUS'" >&2
  exit 1
fi
CONVO_GEN_MSG_ID=$(printf '%s\n' "$CONVO_GEN_RESP" | jq -r '.message.document_id')
if [ -z "$CONVO_GEN_MSG_ID" ] || [ "$CONVO_GEN_MSG_ID" = "null" ]; then
  echo "ERROR: Conversation generate response missing message.document_id" >&2
  exit 1
fi
echo "Conversation generate: OK (message document_id: $CONVO_GEN_MSG_ID)"

# 48b. Verify the generated message is listed in conversation messages
echo "--- Verifying generated message persisted ---"
CONVO_MSGS_RESP=$($SOAT_CLI list-conversation-messages --conversation-id "$NAMED_CONVO_ID")
MSG_COUNT=$(echo "$CONVO_MSGS_RESP" | jq 'if type=="array" then length else (.data | length) end')
if [ "$MSG_COUNT" -lt "2" ]; then
  echo "ERROR: Expected at least 2 conversation messages (user + generated), got $MSG_COUNT" >&2
  exit 1
fi
echo "Conversation messages count: $MSG_COUNT (OK)"

# 49. Verify GET /conversations/:id/actors lists both actors
echo "--- Verifying GET /conversations/:id/actors ---"
CONVO_ACTORS_RESP=$($SOAT_CLI list-conversation-actors --conversation-id "$NAMED_CONVO_ID")
CONVO_ACTORS_COUNT=$(echo "$CONVO_ACTORS_RESP" | jq 'if type=="array" then length else (.data | length) end')
if [ "$CONVO_ACTORS_COUNT" -lt "2" ]; then
  echo "ERROR: Expected at least 2 actors in conversation, got $CONVO_ACTORS_COUNT" >&2
  exit 1
fi
echo "GET /conversations/:id/actors count: $CONVO_ACTORS_COUNT (OK)"

# 50. Verify delete-block: agent-backed actor with messages cannot be deleted (409)
echo "--- Verifying actor delete-block (409 when actor has messages) ---"
expect_cli_error_status 409 delete-actor --actor-id "$AGENT_ACTOR_ID"
echo "Actor delete-block: OK (409 as expected)"

# 51. Cleanup — delete the conversation (cascades messages)
echo "--- Deleting named conversation ---"
$SOAT_CLI delete-conversation --conversation-id "$NAMED_CONVO_ID"
echo "Named conversation deleted."

# 52. Cleanup — now that messages are gone, delete agent-backed actor
echo "--- Deleting agent-backed actor ---"
$SOAT_CLI delete-actor --actor-id "$AGENT_ACTOR_ID"
echo "Agent-backed actor deleted."

# 53. Cleanup — delete user actor
echo "--- Deleting user actor ---"
$SOAT_CLI delete-actor --actor-id "$USER_ACTOR_ID"
echo "User actor deleted."

# 54. Cleanup — delete conversation-generate agent
echo "--- Deleting conversation-generate agent ---"
$SOAT_CLI delete-agent --agent-id "$CONVO_GEN_AGENT_ID"
echo "Conversation-generate agent deleted."
echo "Conversations generate coverage: OK"

# ── Webhooks ──────────────────────────────────────────────────────────────

echo ""
echo "=== Webhooks ==="

# Create webhook
echo "--- Creating webhook ---"
WEBHOOK_CREATE_RESP=$($SOAT_CLI create-webhook --project-id "$PROJECT_PUBLIC_ID" \
  --name "Smoke Webhook" \
  --url "https://example.com/smoke-hook" \
  --events '["file.*"]')
WEBHOOK_ID=$(echo "$WEBHOOK_CREATE_RESP" | jq -r '.id')
if [ -z "$WEBHOOK_ID" ] || [ "$WEBHOOK_ID" = "null" ]; then
  echo "ERROR: Failed to create webhook" >&2
  echo "$WEBHOOK_CREATE_RESP" >&2
  exit 1
fi
echo "Webhook created: $WEBHOOK_ID"

# List webhooks
echo "--- Listing webhooks ---"
WEBHOOK_LIST_RESP=$($SOAT_CLI list-webhooks --project-id "$PROJECT_PUBLIC_ID")
if ! printf '%s\n' "$WEBHOOK_LIST_RESP" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: LIST webhooks did not return an array" >&2
  echo "$WEBHOOK_LIST_RESP" >&2
  exit 1
fi
echo "Webhooks listed."

# Get webhook
echo "--- Getting webhook ---"
WEBHOOK_GET_RESP=$($SOAT_CLI get-webhook --project-id "$PROJECT_PUBLIC_ID" --webhook-id "$WEBHOOK_ID")
if ! printf '%s\n' "$WEBHOOK_GET_RESP" | jq -e --arg id "$WEBHOOK_ID" '.id == $id' >/dev/null 2>&1; then
  echo "ERROR: GET webhook returned unexpected payload" >&2
  echo "$WEBHOOK_GET_RESP" >&2
  exit 1
fi
echo "Webhook retrieved."

# Update webhook
echo "--- Updating webhook ---"
WEBHOOK_UPDATE_RESP=$($SOAT_CLI update-webhook --project-id "$PROJECT_PUBLIC_ID" --webhook-id "$WEBHOOK_ID" \
  --name "Updated Smoke Webhook" --active false)
if ! printf '%s\n' "$WEBHOOK_UPDATE_RESP" | jq -e '.active == false' >/dev/null 2>&1; then
  echo "ERROR: UPDATE webhook did not return active=false" >&2
  echo "$WEBHOOK_UPDATE_RESP" >&2
  exit 1
fi
echo "Webhook updated."

# Rotate secret
echo "--- Rotating webhook secret ---"
$SOAT_CLI rotate-webhook-secret --project-id "$PROJECT_PUBLIC_ID" --webhook-id "$WEBHOOK_ID" >/dev/null
echo "Webhook secret rotated."

# List deliveries
echo "--- Listing webhook deliveries ---"
WEBHOOK_DELIVERIES_RESP=$($SOAT_CLI list-webhook-deliveries --project-id "$PROJECT_PUBLIC_ID" --webhook-id "$WEBHOOK_ID")
if ! printf '%s\n' "$WEBHOOK_DELIVERIES_RESP" | jq -e '((type == "array") or (type == "object" and (.data | type == "array")))' >/dev/null 2>&1; then
  echo "ERROR: LIST webhook deliveries did not return an array" >&2
  echo "$WEBHOOK_DELIVERIES_RESP" >&2
  exit 1
fi
echo "Webhook deliveries listed."

# Delete webhook
echo "--- Deleting webhook ---"
$SOAT_CLI delete-webhook --project-id "$PROJECT_PUBLIC_ID" --webhook-id "$WEBHOOK_ID"
echo "Webhook deleted."
echo "Webhooks coverage: OK"

echo ""
echo "=== All smoke tests passed! ==="
