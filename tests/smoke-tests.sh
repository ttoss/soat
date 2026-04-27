#!/bin/sh
set -e

SERVER_URL="${SERVER_URL:-http://localhost:50477}"
BASE_URL="$SERVER_URL/api/v1"

echo "=== Smoke test started ==="

# Remove unescaped control characters that may appear in LLM-generated text
# and break jq JSON parsing.
sanitize_json() {
  LC_ALL=C tr -d '\000-\037'
}

# 1. Bootstrap admin user (201 on first run, 409 if already exists)
echo "--- Bootstrapping admin user ---"
BOOTSTRAP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/users/bootstrap" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}')
if [ "$BOOTSTRAP_STATUS" != "201" ] && [ "$BOOTSTRAP_STATUS" != "409" ]; then
  echo "ERROR: Bootstrap returned $BOOTSTRAP_STATUS" >&2
  exit 1
fi
echo "Bootstrap status: $BOOTSTRAP_STATUS"

# 2. Login to get JWT token
echo "--- Logging in ---"
LOGIN_RESP=$(curl -sf -X POST "$BASE_URL/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}')
TOKEN=$(echo "$LOGIN_RESP" | jq -r '.token')
ADMIN_USER_ID=$(echo "$LOGIN_RESP" | jq -r '.id')
if [ -z "$ADMIN_USER_ID" ] || [ "$ADMIN_USER_ID" = "null" ]; then
  echo "ERROR: Login response did not include user id" >&2
  echo "$LOGIN_RESP" >&2
  exit 1
fi
echo "Token: $(echo "$TOKEN" | cut -c1-20)..."

# ── CLI setup ─────────────────────────────────────────────────────────────────
# Set env vars consumed by the CLI (no profile / config file needed)
# The SDK paths are relative to /api/v1 (per OpenAPI server URL)
export SOAT_BASE_URL="$SERVER_URL/api/v1"
export SOAT_TOKEN="$TOKEN"
SOAT_CLI="node /app/packages/cli/dist/esm/index.js"
echo "CLI: $SOAT_CLI"

# 3. Create a project
echo "--- Creating project ---"
PROJECT_RESP=$($SOAT_CLI create-project --name smoke-test-project)
PROJECT_PUBLIC_ID=$(echo "$PROJECT_RESP" | jq -r '.id')
echo "Project id: $PROJECT_PUBLIC_ID"

# 3b. Policies module coverage
echo "--- Policies coverage ---"
POLICY_READ_RESP=$(curl -sf -X POST "$BASE_URL/policies" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"permissions\":[\"files:GetFile\"],\"name\":\"smoke-read-policy\"}")
POLICY_READ_ID=$(echo "$POLICY_READ_RESP" | jq -r '.id')
if [ -z "$POLICY_READ_ID" ] || [ "$POLICY_READ_ID" = "null" ]; then
  echo "ERROR: Failed to create read policy" >&2
  echo "$POLICY_READ_RESP" >&2
  exit 1
fi

POLICY_WRITE_RESP=$(curl -sf -X POST "$BASE_URL/policies" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"permissions\":[\"files:PutFile\"],\"name\":\"smoke-write-policy\"}")
POLICY_WRITE_ID=$(echo "$POLICY_WRITE_RESP" | jq -r '.id')
if [ -z "$POLICY_WRITE_ID" ] || [ "$POLICY_WRITE_ID" = "null" ]; then
  echo "ERROR: Failed to create write policy" >&2
  echo "$POLICY_WRITE_RESP" >&2
  exit 1
fi

# List policies
POLICY_LIST_STATUS=$(curl -s -o /tmp/policy_list.json -w "%{http_code}" "$BASE_URL/policies" \
  -H "Authorization: Bearer $TOKEN")
if [ "$POLICY_LIST_STATUS" != "200" ]; then
  echo "ERROR: LIST policies returned $POLICY_LIST_STATUS, expected 200" >&2
  cat /tmp/policy_list.json >&2
  exit 1
fi

# Get policy
POLICY_GET_STATUS=$(curl -s -o /tmp/policy_get.json -w "%{http_code}" "$BASE_URL/policies/$POLICY_READ_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$POLICY_GET_STATUS" != "200" ]; then
  echo "ERROR: GET policy returned $POLICY_GET_STATUS, expected 200" >&2
  cat /tmp/policy_get.json >&2
  exit 1
fi
POLICY_GET_ID=$(jq -r '.id' /tmp/policy_get.json)
if [ "$POLICY_GET_ID" != "$POLICY_READ_ID" ]; then
  echo "ERROR: GET policy returned mismatched id '$POLICY_GET_ID'" >&2
  exit 1
fi

# Update policy
POLICY_UPDATE_STATUS=$(curl -s -o /tmp/policy_put.json -w "%{http_code}" -X PUT "$BASE_URL/policies/$POLICY_READ_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"document\":{\"statement\":[{\"effect\":\"Allow\",\"action\":[\"files:GetFile\",\"files:ListFiles\"]}]},\"name\":\"smoke-read-policy-updated\"}")
if [ "$POLICY_UPDATE_STATUS" != "200" ]; then
  echo "ERROR: PUT policy returned $POLICY_UPDATE_STATUS, expected 200" >&2
  cat /tmp/policy_put.json >&2
  exit 1
fi

# Attach policy to admin user
ATTACH_POLICY_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PUT "$BASE_URL/users/$ADMIN_USER_ID/policies" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"policy_ids\":[\"$POLICY_READ_ID\",\"$POLICY_WRITE_ID\"]}")
if [ "$ATTACH_POLICY_STATUS" != "204" ]; then
  echo "ERROR: Attach policies to user returned $ATTACH_POLICY_STATUS, expected 204" >&2
  exit 1
fi

# Get user policies
USER_POLICIES_STATUS=$(curl -s -o /tmp/user_policies.json -w "%{http_code}" "$BASE_URL/users/$ADMIN_USER_ID/policies" \
  -H "Authorization: Bearer $TOKEN")
if [ "$USER_POLICIES_STATUS" != "200" ]; then
  echo "ERROR: GET user policies returned $USER_POLICIES_STATUS, expected 200" >&2
  cat /tmp/user_policies.json >&2
  exit 1
fi
echo "Policies coverage: OK"

# 3c. API keys module coverage
echo "--- API keys coverage ---"
API_KEY_CREATE_STATUS=$(curl -s -o /tmp/api_key_create.json -w "%{http_code}" -X POST "$BASE_URL/api-keys" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"smoke-api-key\",\"project_id\":\"$PROJECT_PUBLIC_ID\",\"policy_ids\":[\"$POLICY_READ_ID\"]}")
if [ "$API_KEY_CREATE_STATUS" != "201" ]; then
  echo "ERROR: CREATE api-key returned $API_KEY_CREATE_STATUS, expected 201" >&2
  cat /tmp/api_key_create.json >&2
  exit 1
fi
API_KEY_RESP=$(cat /tmp/api_key_create.json)
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
API_KEY_GET_STATUS=$(curl -s -o /tmp/api_key_get.json -w "%{http_code}" "$BASE_URL/api-keys/$API_KEY_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$API_KEY_GET_STATUS" != "200" ]; then
  echo "ERROR: GET api-key returned $API_KEY_GET_STATUS, expected 200" >&2
  cat /tmp/api_key_get.json >&2
  exit 1
fi
if jq -e '.key' /tmp/api_key_get.json >/dev/null 2>&1; then
  echo "ERROR: key field must not appear in GET api-key response" >&2
  exit 1
fi

# UPDATE api-key
API_KEY_UPDATE_STATUS=$(curl -s -o /tmp/api_key_put.json -w "%{http_code}" -X PUT "$BASE_URL/api-keys/$API_KEY_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"name\":\"smoke-api-key-updated\",\"policy_ids\":[\"$POLICY_READ_ID\",\"$POLICY_WRITE_ID\"]}")
if [ "$API_KEY_UPDATE_STATUS" != "200" ]; then
  echo "ERROR: PUT api-key returned $API_KEY_UPDATE_STATUS, expected 200" >&2
  cat /tmp/api_key_put.json >&2
  exit 1
fi
API_KEY_UPDATED_NAME=$(jq -r '.name' /tmp/api_key_put.json)
if [ "$API_KEY_UPDATED_NAME" != "smoke-api-key-updated" ]; then
  echo "ERROR: PUT api-key did not update name" >&2
  cat /tmp/api_key_put.json >&2
  exit 1
fi

# Verify API key authentication works
API_KEY_AUTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/projects" \
  -H "Authorization: Bearer $API_KEY_RAW")
if [ "$API_KEY_AUTH_STATUS" != "200" ]; then
  echo "ERROR: API key auth returned $API_KEY_AUTH_STATUS, expected 200" >&2
  exit 1
fi

# DELETE api-key
API_KEY_DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/api-keys/$API_KEY_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$API_KEY_DELETE_STATUS" != "204" ]; then
  echo "ERROR: DELETE api-key returned $API_KEY_DELETE_STATUS, expected 204" >&2
  exit 1
fi
API_KEY_AFTER_DELETE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api-keys/$API_KEY_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$API_KEY_AFTER_DELETE" != "404" ]; then
  echo "ERROR: Expected 404 after api-key deletion, got $API_KEY_AFTER_DELETE" >&2
  exit 1
fi
echo "API keys coverage: OK"

# Delete policies (cleanup + CRUD coverage)
POLICY_DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/policies/$POLICY_READ_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$POLICY_DELETE_STATUS" != "204" ]; then
  echo "ERROR: DELETE policy returned $POLICY_DELETE_STATUS, expected 204" >&2
  exit 1
fi
POLICY_AFTER_DELETE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/policies/$POLICY_READ_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$POLICY_AFTER_DELETE" != "404" ]; then
  echo "ERROR: Expected 404 after policy deletion, got $POLICY_AFTER_DELETE" >&2
  exit 1
fi
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

SECRET_GET_RESP=$($SOAT_CLI get-secret --secretId "$SECRET_ID")
if echo "$SECRET_GET_RESP" | jq -e '.value' >/dev/null 2>&1; then
  echo "ERROR: Secret value must not be returned" >&2
  echo "$SECRET_GET_RESP" >&2
  exit 1
fi

$SOAT_CLI update-secret --secretId "$SECRET_ID" --name smoke-secret-updated --value updatedvalue

$SOAT_CLI delete-secret --secretId "$SECRET_ID"

SECRET_AFTER_DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/secrets/$SECRET_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$SECRET_AFTER_DELETE_STATUS" != "404" ]; then
  echo "ERROR: Expected 404 after secret deletion, got $SECRET_AFTER_DELETE_STATUS" >&2
  exit 1
fi
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

$SOAT_CLI get-actor --id "$ACTOR_ID"

$SOAT_CLI update-actor --id "$ACTOR_ID" --name smoke-actor-updated

$SOAT_CLI delete-actor --id "$ACTOR_ID"

ACTOR_AFTER_DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/actors/$ACTOR_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$ACTOR_AFTER_DELETE_STATUS" != "404" ]; then
  echo "ERROR: Expected 404 after actor deletion, got $ACTOR_AFTER_DELETE_STATUS" >&2
  exit 1
fi
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

CONVO_MSG_LIST_STATUS=$(curl -s -o /tmp/conversation_messages_before.json -w "%{http_code}" "$BASE_URL/conversations/$CONVO_ID/messages" \
  -H "Authorization: Bearer $TOKEN")
if [ "$CONVO_MSG_LIST_STATUS" != "200" ]; then
  echo "ERROR: LIST conversation messages returned $CONVO_MSG_LIST_STATUS, expected 200" >&2
  cat /tmp/conversation_messages_before.json >&2
  exit 1
fi

CONVO_ADD_MSG_RESP=$($SOAT_CLI add-conversation-message \
  --id "$CONVO_ID" --message "smoke conversation message" --actor_id "$CONVO_ACTOR_ID")
CONVO_DOC_ID=$(echo "$CONVO_ADD_MSG_RESP" | jq -r '.document_id')
if [ -z "$CONVO_DOC_ID" ] || [ "$CONVO_DOC_ID" = "null" ]; then
  echo "ERROR: Failed to add conversation message" >&2
  echo "$CONVO_ADD_MSG_RESP" >&2
  exit 1
fi

$SOAT_CLI remove-conversation-message --id "$CONVO_ID" --documentId "$CONVO_DOC_ID"

$SOAT_CLI update-conversation --id "$CONVO_ID" --status closed

$SOAT_CLI delete-conversation --id "$CONVO_ID"

CONVO_AFTER_DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/conversations/$CONVO_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$CONVO_AFTER_DELETE_STATUS" != "404" ]; then
  echo "ERROR: Expected 404 after conversation deletion, got $CONVO_AFTER_DELETE_STATUS" >&2
  exit 1
fi

$SOAT_CLI delete-actor --id "$CONVO_ACTOR_ID"
echo "Conversations coverage: OK"

# 4. Upload a file via multipart form (with path field)
echo "--- Uploading file ---"
echo "Hello, smoke test!" > /tmp/smoke.txt
UPLOAD_RESP=$(curl -sf -X POST "$BASE_URL/files/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/smoke.txt;type=text/plain" \
  -F "project_id=$PROJECT_PUBLIC_ID" \
  -F "path=/reports/smoke.txt")
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
GET_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/files/$FILE_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$GET_STATUS" != "200" ]; then
  echo "ERROR: GET file returned $GET_STATUS, expected 200" >&2
  exit 1
fi
echo "GET status: $GET_STATUS"

# 6. Download file and verify content
echo "--- Downloading file ---"
CONTENT=$(curl -sf "$BASE_URL/files/$FILE_ID/download" \
  -H "Authorization: Bearer $TOKEN")
EXPECTED="Hello, smoke test!"
if [ "$CONTENT" != "$EXPECTED" ]; then
  echo "ERROR: Content mismatch. Got '$CONTENT', expected '$EXPECTED'" >&2
  exit 1
fi
echo "Content matches."

# 7. Update metadata
echo "--- Updating metadata ---"
PATCH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X PATCH "$BASE_URL/files/$FILE_ID/metadata" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"metadata":"smoke-tested"}')
if [ "$PATCH_STATUS" != "200" ]; then
  echo "ERROR: PATCH metadata returned $PATCH_STATUS, expected 200" >&2
  exit 1
fi
echo "PATCH status: $PATCH_STATUS"

# 8. Delete file
echo "--- Deleting file ---"
DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/files/$FILE_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$DELETE_STATUS" != "204" ]; then
  echo "ERROR: DELETE returned $DELETE_STATUS, expected 204" >&2
  exit 1
fi
echo "DELETE status: $DELETE_STATUS"

# 9. Verify file is gone (404)
echo "--- Verifying deletion ---"
AFTER_DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/files/$FILE_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$AFTER_DELETE_STATUS" != "404" ]; then
  echo "ERROR: Expected 404 after deletion, got $AFTER_DELETE_STATUS" >&2
  exit 1
fi
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
GET_DOC1_RESP=$($SOAT_CLI get-document --id "$DOC1_ID")
GET_DOC1_PATH=$(echo "$GET_DOC1_RESP" | jq -r '.path')
if [ "$GET_DOC1_PATH" != "/animals/fox.txt" ]; then
  echo "ERROR: GET document path expected '/animals/fox.txt', got '$GET_DOC1_PATH'" >&2
  exit 1
fi
echo "GET document path: OK"

# 11c. Search documents by path prefix
echo "--- Search documents by path prefix ---"
PATH_SEARCH_RESP=$(curl -sf -X POST "$BASE_URL/documents/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"project_id\":\"$PROJECT_PUBLIC_ID\",\"paths\":[\"/animals/\"]}")
PATH_SEARCH_COUNT=$(echo "$PATH_SEARCH_RESP" | jq '.documents | length')
if [ "$PATH_SEARCH_COUNT" -lt 1 ]; then
  echo "ERROR: path-prefix search returned $PATH_SEARCH_COUNT results, expected at least 1" >&2
  exit 1
fi
echo "Path-prefix search returned $PATH_SEARCH_COUNT result(s): OK"

# 12. Search documents
echo "--- Searching documents ---"
SEARCH_RESP=$(curl -sf -X POST "$BASE_URL/documents/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"project_id\":\"$PROJECT_PUBLIC_ID\",\"search\":\"fox animal jumping\",\"limit\":5}")
SEARCH_COUNT=$(echo "$SEARCH_RESP" | jq '.documents | length')
if [ "$SEARCH_COUNT" -lt 1 ]; then
  echo "ERROR: Document search returned $SEARCH_COUNT results, expected at least 1" >&2
  exit 1
fi
echo "Search returned $SEARCH_COUNT result(s)."

# 13. Delete documents
echo "--- Deleting documents ---"
$SOAT_CLI delete-document --id "$DOC1_ID"
$SOAT_CLI delete-document --id "$DOC2_ID"
echo "Documents deleted."

# 14. Chat completion — 401 without auth
echo "--- Chat completion: 401 without auth ---"
CHAT_UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/chats/completions" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}')
if [ "$CHAT_UNAUTH" != "401" ]; then
  echo "ERROR: Expected 401, got $CHAT_UNAUTH" >&2
  exit 1
fi
echo "401 without auth: OK"

# 15. Chat completion — 400 without messages
echo "--- Chat completion: 400 without messages ---"
CHAT_NOMSG=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/chats/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}')
if [ "$CHAT_NOMSG" != "400" ]; then
  echo "ERROR: Expected 400, got $CHAT_NOMSG" >&2
  exit 1
fi
echo "400 without messages: OK"

# 16. Chat completion — valid non-streaming request (Ollama fallback)
echo "--- Chat completion: valid request ---"
CHAT_RESP=$(curl -sf -X POST "$BASE_URL/chats/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"say hello"}]}')
CHAT_OBJECT=$(echo "$CHAT_RESP" | jq -r '.object')
if [ "$CHAT_OBJECT" != "chat.completion" ]; then
  echo "ERROR: Expected object=chat.completion, got $CHAT_OBJECT" >&2
  echo "$CHAT_RESP" >&2
  exit 1
fi
echo "Chat completion OK. Response: $(echo "$CHAT_RESP" | jq -r '.choices[0].message.content' | cut -c1-60)"

# 17. Chat completion — SSE streaming request
echo "--- Chat completion: SSE streaming ---"
CHAT_SSE_STATUS=$(curl -s -o /tmp/chat_sse.txt -w "%{http_code}" -X POST "$BASE_URL/chats/completions" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"say hello"}],"stream":true}')
if [ "$CHAT_SSE_STATUS" != "200" ]; then
  echo "ERROR: Chat SSE stream returned $CHAT_SSE_STATUS, expected 200" >&2
  exit 1
fi
if ! grep -q "data: \[DONE\]" /tmp/chat_sse.txt; then
  echo "ERROR: Chat SSE stream missing 'data: [DONE]'" >&2
  cat /tmp/chat_sse.txt >&2
  exit 1
fi
echo "Chat SSE stream OK."
echo "--- Chat SSE stream output ---"
cat /tmp/chat_sse.txt

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
TOOL_RESP=$(curl -sf -X POST "$BASE_URL/agents/tools" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"name\": \"list-projects\",
    \"type\": \"http\",
    \"description\": \"Lists all projects from the SOAT API. Call this tool whenever the user asks for the list of projects.\",
    \"parameters\": {
      \"type\": \"object\",
      \"properties\": {},
      \"required\": []
    },
    \"execute\": {
      \"url\": \"$SERVER_URL/api/v1/projects\",
      \"headers\": {
        \"Authorization\": \"Bearer $TOKEN\"
      }
    }
  }")
TOOL_ID=$(echo "$TOOL_RESP" | jq -r '.id')
echo "Agent Tool id: $TOOL_ID"

# 20. Create an agent with the list-projects tool
echo "--- Creating agent ---"
AGENT_RESP=$(curl -sf -X POST "$BASE_URL/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"ai_provider_id\": \"$AI_PROVIDER_ID\",
    \"name\": \"project-lister\",
    \"instructions\": \"You are a helpful assistant. When the user asks you to list projects, you MUST call the list-projects tool and return the results. Always use the tool, never make up data.\",
    \"tool_ids\": [\"$TOOL_ID\"],
    \"max_steps\": 5
  }")
AGENT_ID=$(echo "$AGENT_RESP" | jq -r '.id')
echo "Agent id: $AGENT_ID"

# 21. Run the agent — ask it to list projects (non-streaming)
echo "--- Running agent generation ---"
GEN_RESP=$(curl -sf --max-time 120 -X POST "$BASE_URL/agents/$AGENT_ID/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"List all the projects. Use the list-projects tool."}]}' | sanitize_json)
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
AGENT_STREAM_STATUS=$(curl -s -o /tmp/agent_stream_sse.txt -w "%{http_code}" --max-time 120 -X POST "$BASE_URL/agents/$AGENT_ID/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"List all the projects. Use the list-projects tool."}],"stream":true}')
if [ "$AGENT_STREAM_STATUS" != "200" ]; then
  echo "ERROR: Agent SSE stream returned $AGENT_STREAM_STATUS, expected 200" >&2
  exit 1
fi
if ! grep -q "data: \[DONE\]" /tmp/agent_stream_sse.txt; then
  echo "ERROR: Agent SSE stream missing 'data: [DONE]'" >&2
  cat /tmp/agent_stream_sse.txt >&2
  exit 1
fi
echo "Agent SSE stream OK."

# 23. Cleanup — delete agent
echo "--- Deleting agent ---"
$SOAT_CLI delete-agent --agentId "$AGENT_ID"
echo "Agent deleted."

# 24. Cleanup — delete agent tool
echo "--- Deleting agent tool ---"
$SOAT_CLI delete-agent-tool --toolId "$TOOL_ID"
echo "Agent tool deleted."

# 25. Create an MCP agent tool pointing at the SOAT MCP server
echo "--- Creating MCP agent tool ---"
MCP_TOOL_RESP=$(curl -sf -X POST "$BASE_URL/agents/tools" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"name\": \"soat-mcp\",
    \"type\": \"mcp\",
    \"description\": \"SOAT MCP server — exposes all SOAT tools over the MCP protocol.\",
    \"mcp\": {
      \"url\": \"$SERVER_URL/mcp\",
      \"headers\": {
        \"Authorization\": \"Bearer $TOKEN\"
      }
    }
  }")
MCP_TOOL_ID=$(echo "$MCP_TOOL_RESP" | jq -r '.id')
echo "MCP Agent Tool id: $MCP_TOOL_ID"

# 26. Create an agent backed by the MCP tool
echo "--- Creating MCP agent ---"
MCP_AGENT_RESP=$(curl -sf -X POST "$BASE_URL/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"ai_provider_id\": \"$AI_PROVIDER_ID\",
    \"name\": \"mcp-agent-lister\",
    \"instructions\": \"You are a helpful assistant with access to SOAT tools via MCP. When asked to list agents, call the list-agents MCP tool and return the results. Always use the tool.\",
    \"tool_ids\": [\"$MCP_TOOL_ID\"],
    \"max_steps\": 5
  }")
MCP_AGENT_ID=$(echo "$MCP_AGENT_RESP" | jq -r '.id')
echo "MCP Agent id: $MCP_AGENT_ID"

# 27. Ask the agent to list agents via MCP
echo "--- Running MCP agent generation ---"
MCP_GEN_RESP=$(curl -sf --max-time 300 -X POST "$BASE_URL/agents/$MCP_AGENT_ID/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"List all agents. Use the list-agents tool."}]}' | sanitize_json)
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
$SOAT_CLI delete-agent --agentId "$MCP_AGENT_ID"
echo "MCP Agent deleted."

# 30. Cleanup — delete MCP agent tool
echo "--- Deleting MCP agent tool ---"
$SOAT_CLI delete-agent-tool --toolId "$MCP_TOOL_ID"
echo "MCP Agent tool deleted."

# ── Client Tool Tests ────────────────────────────────────────────────────────

# 31. Create a client-type agent tool
echo "--- Creating client agent tool ---"
CLIENT_TOOL_RESP=$(curl -sf -X POST "$BASE_URL/agents/tools" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"name\": \"get_weather\",
    \"type\": \"client\",
    \"description\": \"Returns the current weather for a given city.\",
    \"parameters\": {
      \"type\": \"object\",
      \"properties\": {
        \"city\": { \"type\": \"string\", \"description\": \"The city name\" }
      },
      \"required\": [\"city\"]
    }
  }")
CLIENT_TOOL_ID=$(echo "$CLIENT_TOOL_RESP" | jq -r '.id')
if [ -z "$CLIENT_TOOL_ID" ] || [ "$CLIENT_TOOL_ID" = "null" ]; then
  echo "ERROR: Failed to create client agent tool" >&2
  echo "$CLIENT_TOOL_RESP" >&2
  exit 1
fi
echo "Client Agent Tool id: $CLIENT_TOOL_ID"

# 32. Create an agent that uses the client tool
echo "--- Creating client-tool agent ---"
CLIENT_AGENT_RESP=$(curl -sf -X POST "$BASE_URL/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"ai_provider_id\": \"$AI_PROVIDER_ID\",
    \"name\": \"weather-agent\",
    \"instructions\": \"You are a weather assistant. When the user asks about the weather, call the get_weather tool with the city name.\",
    \"tool_ids\": [\"$CLIENT_TOOL_ID\"],
    \"tool_choice\": { \"type\": \"tool\", \"tool_name\": \"get_weather\" },
    \"max_steps\": 3
  }")
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
  CLIENT_GEN_RESP=$(curl -sf --max-time 60 -X POST "$BASE_URL/agents/$CLIENT_AGENT_ID/generate" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d '{"messages":[{"role":"user","content":"Call get_weather with city Paris and wait for tool output. Do not answer directly."}]}' | sanitize_json)
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
SUBMIT_RESP=$(curl -sf --max-time 60 -X POST "$BASE_URL/agents/$CLIENT_AGENT_ID/generate/$CLIENT_GEN_ID/tool-outputs" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"tool_outputs\": [
      {
        \"tool_call_id\": \"$CLIENT_TOOL_CALL_ID\",
        \"output\": { \"city\": \"Paris\", \"temperature\": \"18°C\", \"condition\": \"Partly cloudy\" }
      }
    ]
  }" | sanitize_json)
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
if ! printf '%s\n' "$TRACES_RESP" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: list-agent-traces did not return a JSON array" >&2
  echo "$TRACES_RESP" >&2
  exit 1
fi
echo "Trace listing endpoint: OK"

if [ -n "$CLIENT_TRACE_ID" ] && [ "$CLIENT_TRACE_ID" != "null" ]; then
  TRACE_GET_RESP=$($SOAT_CLI get-agent-trace --traceId "$CLIENT_TRACE_ID")
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
$SOAT_CLI delete-agent --agentId "$CLIENT_AGENT_ID"
echo "Client-tool agent deleted."

# 36. Cleanup — delete client agent tool
echo "--- Deleting client agent tool ---"
$SOAT_CLI delete-agent-tool --toolId "$CLIENT_TOOL_ID"
echo "Client agent tool deleted."

# ── SOAT Tool Tests ─────────────────────────────────────────────────────────

# 37. Create a SOAT agent tool exposing list-projects action
echo "--- Creating SOAT agent tool ---"
SOAT_TOOL_RESP=$(curl -sf -X POST "$BASE_URL/agents/tools" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"name\": \"soat-platform\",
    \"type\": \"soat\",
    \"description\": \"SOAT platform actions exposed as tools.\",
    \"actions\": [\"list-projects\"]
  }")
SOAT_TOOL_ID=$(echo "$SOAT_TOOL_RESP" | jq -r '.id')
if [ -z "$SOAT_TOOL_ID" ] || [ "$SOAT_TOOL_ID" = "null" ]; then
  echo "ERROR: Failed to create SOAT agent tool" >&2
  echo "$SOAT_TOOL_RESP" >&2
  exit 1
fi
echo "SOAT Agent Tool id: $SOAT_TOOL_ID"

# 38. Create an agent that uses the SOAT tool
echo "--- Creating SOAT agent ---"
SOAT_AGENT_RESP=$(curl -sf -X POST "$BASE_URL/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"ai_provider_id\": \"$AI_PROVIDER_ID\",
    \"name\": \"soat-project-lister\",
    \"instructions\": \"You are a helpful assistant. Use the SOAT list-projects action to list projects for the user.\",
    \"tool_ids\": [\"$SOAT_TOOL_ID\"],
    \"max_steps\": 5
  }")
SOAT_AGENT_ID=$(echo "$SOAT_AGENT_RESP" | jq -r '.id')
if [ -z "$SOAT_AGENT_ID" ] || [ "$SOAT_AGENT_ID" = "null" ]; then
  echo "ERROR: Failed to create SOAT agent" >&2
  echo "$SOAT_AGENT_RESP" >&2
  exit 1
fi
echo "SOAT Agent id: $SOAT_AGENT_ID"

# 39. Run generation with the SOAT-backed agent
echo "--- Running SOAT agent generation ---"
SOAT_GEN_RESP=$(curl -sf --max-time 120 -X POST "$BASE_URL/agents/$SOAT_AGENT_ID/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"List all projects. Use the soat-platform tool."}]}' | sanitize_json)
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
$SOAT_CLI delete-agent --agentId "$SOAT_AGENT_ID"
echo "SOAT agent deleted."

# 42. Cleanup — delete SOAT agent tool
echo "--- Deleting SOAT agent tool ---"
$SOAT_CLI delete-agent-tool --toolId "$SOAT_TOOL_ID"
echo "SOAT agent tool deleted."

# ── Conversations Generate Tests ─────────────────────────────────────────────

# 43. Create a bare agent (no tools) for conversation generation
echo "--- Creating conversation-generate agent ---"
CONVO_GEN_AGENT_RESP=$(curl -sf -X POST "$BASE_URL/agents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"project_id\": \"$PROJECT_PUBLIC_ID\",
    \"ai_provider_id\": \"$AI_PROVIDER_ID\",
    \"name\": \"convo-gen-agent\",
    \"instructions\": \"You are a helpful conversation participant. Reply concisely.\"
  }")
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
NAME_PATCH_RESP=$($SOAT_CLI update-conversation --id "$NAMED_CONVO_ID" --name smoke-renamed-conversation)
NAME_PATCH_NAME=$(echo "$NAME_PATCH_RESP" | jq -r '.name')
if [ "$NAME_PATCH_NAME" != "smoke-renamed-conversation" ]; then
  echo "ERROR: Expected patched name 'smoke-renamed-conversation', got '$NAME_PATCH_NAME'" >&2
  exit 1
fi
echo "Conversation rename: OK"

# 45. Create an agent-backed actor using the convenience endpoint POST /agents/:id/actors
echo "--- Creating agent-backed actor via convenience endpoint ---"
AGENT_ACTOR_RESP=$(curl -sf -X POST "$BASE_URL/agents/$CONVO_GEN_AGENT_ID/actors" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"project_id\":\"$PROJECT_PUBLIC_ID\",\"name\":\"convo-agent-actor\",\"instructions\":\"Reply as a friendly assistant.\"}")
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
ACTOR_GET_RESP=$(curl -sf "$BASE_URL/actors/$AGENT_ACTOR_ID" \
  -H "Authorization: Bearer $TOKEN")
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
MUTUAL_EXCL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/actors" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"project_id\":\"$PROJECT_PUBLIC_ID\",\"name\":\"bad-actor\",\"agent_id\":\"$CONVO_GEN_AGENT_ID\",\"chat_id\":\"fake-id\"}")
if [ "$MUTUAL_EXCL_STATUS" != "400" ]; then
  echo "ERROR: Expected 400 for actor with both agent_id and chat_id, got $MUTUAL_EXCL_STATUS" >&2
  exit 1
fi
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
  --id "$NAMED_CONVO_ID" --message "Hello, how are you?" --actor_id "$USER_ACTOR_ID")
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
  CONVO_GEN_RESP=$(curl -sf --max-time 120 -X POST "$BASE_URL/conversations/$NAMED_CONVO_ID/generate" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $TOKEN" \
    -d "{\"actor_id\":\"$AGENT_ACTOR_ID\"}" | sanitize_json)
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
CONVO_MSGS_RESP=$(curl -sf "$BASE_URL/conversations/$NAMED_CONVO_ID/messages" \
  -H "Authorization: Bearer $TOKEN")
MSG_COUNT=$(echo "$CONVO_MSGS_RESP" | jq 'length')
if [ "$MSG_COUNT" -lt "2" ]; then
  echo "ERROR: Expected at least 2 conversation messages (user + generated), got $MSG_COUNT" >&2
  exit 1
fi
echo "Conversation messages count: $MSG_COUNT (OK)"

# 49. Verify GET /conversations/:id/actors lists both actors
echo "--- Verifying GET /conversations/:id/actors ---"
CONVO_ACTORS_RESP=$(curl -sf "$BASE_URL/conversations/$NAMED_CONVO_ID/actors" \
  -H "Authorization: Bearer $TOKEN")
CONVO_ACTORS_COUNT=$(echo "$CONVO_ACTORS_RESP" | jq 'length')
if [ "$CONVO_ACTORS_COUNT" -lt "2" ]; then
  echo "ERROR: Expected at least 2 actors in conversation, got $CONVO_ACTORS_COUNT" >&2
  exit 1
fi
echo "GET /conversations/:id/actors count: $CONVO_ACTORS_COUNT (OK)"

# 50. Verify delete-block: agent-backed actor with messages cannot be deleted (409)
echo "--- Verifying actor delete-block (409 when actor has messages) ---"
ACTOR_DEL_BLOCKED_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/actors/$AGENT_ACTOR_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$ACTOR_DEL_BLOCKED_STATUS" != "409" ]; then
  echo "ERROR: Expected 409 when deleting actor with messages, got $ACTOR_DEL_BLOCKED_STATUS" >&2
  exit 1
fi
echo "Actor delete-block: OK (409 as expected)"

# 51. Cleanup — delete the conversation (cascades messages)
echo "--- Deleting named conversation ---"
$SOAT_CLI delete-conversation --id "$NAMED_CONVO_ID"
echo "Named conversation deleted."

# 52. Cleanup — now that messages are gone, delete agent-backed actor
echo "--- Deleting agent-backed actor ---"
$SOAT_CLI delete-actor --id "$AGENT_ACTOR_ID"
echo "Agent-backed actor deleted."

# 53. Cleanup — delete user actor
echo "--- Deleting user actor ---"
$SOAT_CLI delete-actor --id "$USER_ACTOR_ID"
echo "User actor deleted."

# 54. Cleanup — delete conversation-generate agent
echo "--- Deleting conversation-generate agent ---"
$SOAT_CLI delete-agent --agentId "$CONVO_GEN_AGENT_ID"
echo "Conversation-generate agent deleted."
echo "Conversations generate coverage: OK"

# ── Webhooks ──────────────────────────────────────────────────────────────

echo ""
echo "=== Webhooks ==="

# Create webhook
echo "--- Creating webhook ---"
WEBHOOK_CREATE_RESP=$(curl -sf -X POST "$BASE_URL/projects/$PROJECT_PUBLIC_ID/webhooks" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Smoke Webhook","url":"https://example.com/smoke-hook","events":["file.*"]}')
WEBHOOK_ID=$(echo "$WEBHOOK_CREATE_RESP" | jq -r '.id')
if [ -z "$WEBHOOK_ID" ] || [ "$WEBHOOK_ID" = "null" ]; then
  echo "ERROR: Failed to create webhook" >&2
  echo "$WEBHOOK_CREATE_RESP" >&2
  exit 1
fi
echo "Webhook created: $WEBHOOK_ID"

# List webhooks
echo "--- Listing webhooks ---"
WEBHOOK_LIST_STATUS=$(curl -s -o /tmp/webhook_list.json -w "%{http_code}" "$BASE_URL/projects/$PROJECT_PUBLIC_ID/webhooks" \
  -H "Authorization: Bearer $TOKEN")
if [ "$WEBHOOK_LIST_STATUS" != "200" ]; then
  echo "ERROR: LIST webhooks returned $WEBHOOK_LIST_STATUS, expected 200" >&2
  exit 1
fi
echo "Webhooks listed."

# Get webhook
echo "--- Getting webhook ---"
WEBHOOK_GET_STATUS=$(curl -s -o /tmp/webhook_get.json -w "%{http_code}" "$BASE_URL/projects/$PROJECT_PUBLIC_ID/webhooks/$WEBHOOK_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$WEBHOOK_GET_STATUS" != "200" ]; then
  echo "ERROR: GET webhook returned $WEBHOOK_GET_STATUS, expected 200" >&2
  exit 1
fi
echo "Webhook retrieved."

# Update webhook
echo "--- Updating webhook ---"
WEBHOOK_UPDATE_STATUS=$(curl -s -o /tmp/webhook_update.json -w "%{http_code}" -X PUT "$BASE_URL/projects/$PROJECT_PUBLIC_ID/webhooks/$WEBHOOK_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"Updated Smoke Webhook","active":false}')
if [ "$WEBHOOK_UPDATE_STATUS" != "200" ]; then
  echo "ERROR: UPDATE webhook returned $WEBHOOK_UPDATE_STATUS, expected 200" >&2
  exit 1
fi
echo "Webhook updated."

# Rotate secret
echo "--- Rotating webhook secret ---"
WEBHOOK_ROTATE_STATUS=$(curl -s -o /tmp/webhook_rotate.json -w "%{http_code}" -X POST "$BASE_URL/projects/$PROJECT_PUBLIC_ID/webhooks/$WEBHOOK_ID/rotate-secret" \
  -H "Authorization: Bearer $TOKEN")
if [ "$WEBHOOK_ROTATE_STATUS" != "200" ]; then
  echo "ERROR: ROTATE webhook secret returned $WEBHOOK_ROTATE_STATUS, expected 200" >&2
  exit 1
fi
echo "Webhook secret rotated."

# List deliveries
echo "--- Listing webhook deliveries ---"
WEBHOOK_DELIVERIES_STATUS=$(curl -s -o /tmp/webhook_deliveries.json -w "%{http_code}" "$BASE_URL/projects/$PROJECT_PUBLIC_ID/webhooks/$WEBHOOK_ID/deliveries" \
  -H "Authorization: Bearer $TOKEN")
if [ "$WEBHOOK_DELIVERIES_STATUS" != "200" ]; then
  echo "ERROR: LIST webhook deliveries returned $WEBHOOK_DELIVERIES_STATUS, expected 200" >&2
  exit 1
fi
echo "Webhook deliveries listed."

# Delete webhook
echo "--- Deleting webhook ---"
WEBHOOK_DELETE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/projects/$PROJECT_PUBLIC_ID/webhooks/$WEBHOOK_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$WEBHOOK_DELETE_STATUS" != "204" ]; then
  echo "ERROR: DELETE webhook returned $WEBHOOK_DELETE_STATUS, expected 204" >&2
  exit 1
fi
echo "Webhook deleted."
echo "Webhooks coverage: OK"

echo ""
echo "=== All smoke tests passed! ==="
