#!/bin/sh
set -e

SERVER_URL="${SERVER_URL:-http://localhost:50477}"
BASE_URL="$SERVER_URL"

# ── CLI setup ─────────────────────────────────────────────────────────────────
# Set env vars consumed by the CLI (no profile / config file needed)
# The SDK paths already include /api/v1, so the base URL should be host-only.
export SOAT_BASE_URL="$SERVER_URL"
SOAT_CLI="node /app/packages/cli/dist/index.mjs"

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

# 3a. Rename the project
echo "--- Renaming project ---"
PROJECT_RENAME_RESP=$($SOAT_CLI update-project --project-id "$PROJECT_PUBLIC_ID" --name smoke-test-project-renamed)
if [ "$(echo "$PROJECT_RENAME_RESP" | jq -r '.name')" != "smoke-test-project-renamed" ]; then
  echo "ERROR: update-project did not rename the project" >&2
  echo "$PROJECT_RENAME_RESP" >&2
  exit 1
fi
echo "Project rename: OK"

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

# List the policies attached to the user (replaces removed get-user-policies)
USER_POLICIES_RESP=$($SOAT_CLI list-policies --user-id "$ADMIN_USER_ID")
if ! printf '%s\n' "$USER_POLICIES_RESP" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: list-policies --user-id did not return an array" >&2
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

# Secret references ({{secret:...}}) in tool configs: the stored token is
# echoed back verbatim (never the decrypted value), and a token referencing a
# nonexistent secret fails fast at create time.
SECRET_REF_TOKEN="Bearer {{secret:$SECRET_ID}}"
SECRET_REF_TOOL_RESP=$($SOAT_CLI create-tool \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name smoke-secret-ref-tool \
  --type http \
  --execute "{\"url\":\"$SERVER_URL/api/v1/projects\",\"method\":\"GET\",\"headers\":{\"Authorization\":\"$SECRET_REF_TOKEN\"}}")
SECRET_REF_TOOL_ID=$(echo "$SECRET_REF_TOOL_RESP" | jq -r '.id')
if [ -z "$SECRET_REF_TOOL_ID" ] || [ "$SECRET_REF_TOOL_ID" = "null" ]; then
  echo "ERROR: Failed to create tool with a {{secret:...}} reference" >&2
  echo "$SECRET_REF_TOOL_RESP" >&2
  exit 1
fi

SECRET_REF_TOOL_GET=$($SOAT_CLI get-tool --tool-id "$SECRET_REF_TOOL_ID")
STORED_AUTH_HEADER=$(echo "$SECRET_REF_TOOL_GET" | jq -r '.execute.headers.Authorization')
if [ "$STORED_AUTH_HEADER" != "$SECRET_REF_TOKEN" ]; then
  echo "ERROR: Expected stored header to echo the {{secret:...}} token, got '$STORED_AUTH_HEADER'" >&2
  echo "$SECRET_REF_TOOL_GET" >&2
  exit 1
fi

expect_cli_error_status 400 create-tool \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name smoke-secret-ref-bad-tool \
  --type http \
  --execute '{"url":"https://api.example.com/convert","headers":{"Authorization":"Bearer {{secret:sec_doesnotexist00}}"}}'

$SOAT_CLI delete-tool --tool-id "$SECRET_REF_TOOL_ID"
echo "Secret reference coverage: OK"

$SOAT_CLI delete-secret --secret-id "$SECRET_ID"

expect_cli_error_status 404 get-secret --secret-id "$SECRET_ID"
echo "Secrets coverage: OK"

# 3e. Actors module coverage
echo "--- Actors coverage ---"
ACTOR_CREATE_RESP=$($SOAT_CLI create-actor \
  --project_id "$PROJECT_PUBLIC_ID" --name smoke-actor --external_id smoke-ext-actor)
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
  --conversation-id "$CONVO_ID" --message "smoke conversation message" --role user --actor_id "$CONVO_ACTOR_ID")
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
  --prefix /reports \
  --filename smoke.txt \
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

# 7b. Upload a large file via a presigned URL (two-step presigned-URL flow)
echo "--- Requesting presigned URL ---"
TOKEN_RESP=$($SOAT_CLI create-presigned-url \
  --project_id "$PROJECT_PUBLIC_ID" \
  --prefix /reports \
  --filename token-upload.txt \
  --content_type text/plain)
UPLOAD_TOKEN=$(echo "$TOKEN_RESP" | jq -r '.upload_token')
UPLOAD_URL=$(echo "$TOKEN_RESP" | jq -r '.upload_url')
if [ -z "$UPLOAD_TOKEN" ] || [ "$UPLOAD_TOKEN" = "null" ]; then
  echo "ERROR: upload token not returned" >&2
  exit 1
fi
case "$UPLOAD_URL" in
  */api/v1/files/upload/"$UPLOAD_TOKEN") ;;
  *)
    echo "ERROR: upload_url '$UPLOAD_URL' does not match token" >&2
    exit 1
    ;;
esac
echo "Upload token: $UPLOAD_TOKEN"

echo "--- Uploading via token ---"
echo "Hello from upload token!" > /tmp/smoke-token.txt
TOKEN_FILE_B64=$(base64 /tmp/smoke-token.txt | tr -d '\n')
TOKEN_UPLOAD_RESP=$($SOAT_CLI upload-file-with-token \
  --token "$UPLOAD_TOKEN" \
  --content "$TOKEN_FILE_B64")
TOKEN_FILE_ID=$(echo "$TOKEN_UPLOAD_RESP" | jq -r '.id')
if [ -z "$TOKEN_FILE_ID" ] || [ "$TOKEN_FILE_ID" = "null" ]; then
  echo "ERROR: token upload did not return a file id" >&2
  exit 1
fi
echo "Token-uploaded file id: $TOKEN_FILE_ID"

# A token is single-use — a second upload must fail with 409.
echo "--- Verifying token is single-use ---"
expect_cli_error_status 409 upload-file-with-token \
  --token "$UPLOAD_TOKEN" \
  --content "$TOKEN_FILE_B64"
echo "Token correctly rejected on reuse (409)."

$SOAT_CLI delete-file --file-id "$TOKEN_FILE_ID"

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

# 11c. Search knowledge by path prefix
echo "--- Search knowledge by path prefix ---"
PATH_SEARCH_RESP=$($SOAT_CLI search-knowledge \
  --project-id "$PROJECT_PUBLIC_ID" \
  --document-paths '["/animals/"]')
PATH_SEARCH_COUNT=$(echo "$PATH_SEARCH_RESP" | jq '.results | length')
if [ "$PATH_SEARCH_COUNT" -lt 1 ]; then
  echo "ERROR: path-prefix search returned $PATH_SEARCH_COUNT results, expected at least 1" >&2
  exit 1
fi
echo "Path-prefix search returned $PATH_SEARCH_COUNT result(s): OK"

# 12. Search knowledge
echo "--- Searching knowledge ---"
SEARCH_RESP=$($SOAT_CLI search-knowledge \
  --project_id "$PROJECT_PUBLIC_ID" \
  --query "fox animal jumping" \
  --limit 5)
SEARCH_COUNT=$(echo "$SEARCH_RESP" | jq '.results | length')
if [ "$SEARCH_COUNT" -lt 1 ]; then
  echo "ERROR: Knowledge search returned $SEARCH_COUNT results, expected at least 1" >&2
  exit 1
fi
echo "Search returned $SEARCH_COUNT result(s)."

# 12b. Ingest a PDF file
echo "--- Ingesting a PDF file ---"
PDF_BASE64="JVBERi0xLjQKMSAwIG9iago8PC9UeXBlL0NhdGFsb2cvUGFnZXMgMiAwIFI+PgplbmRvYmoKMiAwIG9iago8PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlL1BhZ2UvUGFyZW50IDIgMCBSL01lZGlhQm94WzAgMCA2MTIgNzkyXS9Db250ZW50cyA0IDAgUi9SZXNvdXJjZXM8PC9Gb250PDwvRjEgNSAwIFI+Pj4+Pj4KZW5kb2JqCjQgMCBvYmoKPDwvTGVuZ3RoIDQ0Pj4Kc3RyZWFtCkJUIC9GMSAxMiBUZiAxMDAgNzAwIFRkIChIZWxsbyBXb3JsZCkgVGogRVQKZW5kc3RyZWFtCmVuZG9iago1IDAgb2JqCjw8L1R5cGUvRm9udC9TdWJ0eXBlL1R5cGUxL0Jhc2VGb250L0hlbHZldGljYT4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1NCAwMDAwMCBuIAowMDAwMDAwMTA1IDAwMDAwIG4gCjAwMDAwMDAyMTcgMDAwMDAgbiAKMDAwMDAwMDMwOCAwMDAwMCBuIAp0cmFpbGVyCjw8L1NpemUgNi9Sb290IDEgMCBSPj4Kc3RhcnR4cmVmCjM3MQolJUVPRg=="
PDF_UPLOAD_RESP=$($SOAT_CLI upload-file-base64 \
  --project-id "$PROJECT_PUBLIC_ID" \
  --filename smoke-test.pdf \
  --content "$PDF_BASE64" \
  --content_type application/pdf)
PDF_FILE_ID=$(echo "$PDF_UPLOAD_RESP" | jq -r '.id')
echo "Uploaded PDF file id: $PDF_FILE_ID"

PDF_DOC_RESP=$($SOAT_CLI ingest-document \
  --project-id "$PROJECT_PUBLIC_ID" \
  --file-id "$PDF_FILE_ID" \
  --path-prefix /smoke/)
PDF_DOC_ID=$(echo "$PDF_DOC_RESP" | jq -r '.id')
PDF_CHUNK_COUNT=$(echo "$PDF_DOC_RESP" | jq -r '.chunk_count')
echo "PDF document id: $PDF_DOC_ID chunk_count: $PDF_CHUNK_COUNT"
if [ -z "$PDF_DOC_ID" ] || [ "$PDF_DOC_ID" = "null" ]; then
  echo "ERROR: ingest-document did not return a document id" >&2
  exit 1
fi
echo "PDF ingestion: OK"

# 12c. Ingest a Markdown file (exercises content-type dispatch)
echo "--- Ingesting a text file ---"
MD_BASE64=$(printf '# Smoke Notes\n\nThis is an ingested markdown document.\n' | base64 | tr -d '\n')
MD_UPLOAD_RESP=$($SOAT_CLI upload-file-base64 \
  --project-id "$PROJECT_PUBLIC_ID" \
  --filename smoke-notes.md \
  --content "$MD_BASE64" \
  --content_type text/markdown)
MD_FILE_ID=$(echo "$MD_UPLOAD_RESP" | jq -r '.id')
MD_DOC_RESP=$($SOAT_CLI ingest-document \
  --project-id "$PROJECT_PUBLIC_ID" \
  --file-id "$MD_FILE_ID" \
  --path-prefix /smoke/ \
  --chunk-strategy whole)
MD_DOC_ID=$(echo "$MD_DOC_RESP" | jq -r '.id')
echo "Markdown document id: $MD_DOC_ID chunk_count: $(echo "$MD_DOC_RESP" | jq -r '.chunk_count')"
if [ -z "$MD_DOC_ID" ] || [ "$MD_DOC_ID" = "null" ]; then
  echo "ERROR: ingest-document did not return a document id for markdown" >&2
  exit 1
fi
echo "Text ingestion: OK"

# 12d. Lightweight ingestion status endpoint (issues #5/#6)
echo "--- Checking document status endpoint ---"
PDF_STATUS_RESP=$($SOAT_CLI get-document-status --document-id "$PDF_DOC_ID")
PDF_STATUS=$(echo "$PDF_STATUS_RESP" | jq -r '.status')
PDF_STATUS_CHUNKS=$(echo "$PDF_STATUS_RESP" | jq -r '.chunk_count')
echo "Document status: $PDF_STATUS chunk_count: $PDF_STATUS_CHUNKS"
if [ "$PDF_STATUS" != "ready" ]; then
  echo "ERROR: get-document-status expected 'ready', got '$PDF_STATUS'" >&2
  exit 1
fi
# The status payload must be lightweight — no chunk content.
if [ "$(echo "$PDF_STATUS_RESP" | jq -r '.content // "absent"')" != "absent" ]; then
  echo "ERROR: get-document-status leaked chunk content" >&2
  exit 1
fi
echo "Document status endpoint: OK"

# 12e. Re-ingest an existing document with a different chunk strategy (issue #7)
echo "--- Re-ingesting document ---"
REINGEST_RESP=$($SOAT_CLI reingest-document \
  --document-id "$PDF_DOC_ID" \
  --async false \
  --chunk-strategy whole)
REINGEST_STATUS=$(echo "$REINGEST_RESP" | jq -r '.status')
REINGEST_CHUNKS=$(echo "$REINGEST_RESP" | jq -r '.chunk_count')
echo "Re-ingested status: $REINGEST_STATUS chunk_count: $REINGEST_CHUNKS"
if [ "$REINGEST_STATUS" != "ready" ]; then
  echo "ERROR: reingest-document expected 'ready', got '$REINGEST_STATUS'" >&2
  exit 1
fi
echo "Re-ingest: OK"

# 12f. Ingestion Rules — route a non-native content type to a converter.
# The converter is a deterministic stub: a pipeline tool wrapping an http tool
# that calls the SOAT server's own GET /projects (no external provider
# needed), with its output mapped to a fixed extracted-text page.
echo "--- Creating converter tool chain (http + pipeline) ---"
CONVERTER_HTTP_TOOL_RESP=$($SOAT_CLI create-tool \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name ingestion-converter-stub-http \
  --type http \
  --description "Deterministic stub call used as an ingestion-rule converter step." \
  --parameters '{"type":"object","properties":{},"required":[]}' \
  --execute "{\"url\":\"$SERVER_URL/api/v1/projects\",\"method\":\"GET\",\"headers\":{\"Authorization\":\"Bearer $TOKEN\"}}")
CONVERTER_HTTP_TOOL_ID=$(echo "$CONVERTER_HTTP_TOOL_RESP" | jq -r '.id')
echo "Converter http tool id: $CONVERTER_HTTP_TOOL_ID"

CONVERTER_TOOL_TEXT="Ingestion rule smoke test converter output."
CONVERTER_PIPELINE_TOOL_RESP=$($SOAT_CLI create-tool \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name ingestion-converter-stub \
  --type pipeline \
  --description "Wraps the stub http call and returns fixed extracted text." \
  --pipeline "{\"steps\":[{\"id\":\"call\",\"tool_id\":\"$CONVERTER_HTTP_TOOL_ID\",\"input\":{}}],\"output\":{\"pages\":[{\"text\":\"$CONVERTER_TOOL_TEXT\",\"page_number\":1}]}}")
CONVERTER_TOOL_ID=$(echo "$CONVERTER_PIPELINE_TOOL_RESP" | jq -r '.id')
echo "Converter pipeline tool id: $CONVERTER_TOOL_ID"

echo "--- Creating an ingestion rule for image/x-smoke-test ---"
INGESTION_RULE_RESP=$($SOAT_CLI create-ingestion-rule \
  --project-id "$PROJECT_PUBLIC_ID" \
  --content-type-glob "image/x-smoke-test" \
  --tool-id "$CONVERTER_TOOL_ID" \
  --file-delivery base64 \
  --chunk-strategy whole)
INGESTION_RULE_ID=$(echo "$INGESTION_RULE_RESP" | jq -r '.id')
echo "Ingestion rule id: $INGESTION_RULE_ID"
if [ -z "$INGESTION_RULE_ID" ] || [ "$INGESTION_RULE_ID" = "null" ]; then
  echo "ERROR: create-ingestion-rule did not return a rule id" >&2
  echo "$INGESTION_RULE_RESP" >&2
  exit 1
fi

echo "--- Listing ingestion rules ---"
INGESTION_RULE_LIST_RESP=$($SOAT_CLI list-ingestion-rules --project-id "$PROJECT_PUBLIC_ID")
if ! printf '%s\n' "$INGESTION_RULE_LIST_RESP" | jq -e --arg id "$INGESTION_RULE_ID" 'map(.id) | index($id) != null' > /dev/null; then
  echo "ERROR: list-ingestion-rules did not include the created rule" >&2
  echo "$INGESTION_RULE_LIST_RESP" >&2
  exit 1
fi
echo "Ingestion rule list: OK"

echo "--- Ingesting a non-native file routed through the converter ---"
SMOKE_IMAGE_BASE64=$(printf 'fake-smoke-test-image-bytes' | base64 | tr -d '\n')
CONVERTER_UPLOAD_RESP=$($SOAT_CLI upload-file-base64 \
  --project-id "$PROJECT_PUBLIC_ID" \
  --filename smoke-test-image.smk \
  --content "$SMOKE_IMAGE_BASE64" \
  --content_type image/x-smoke-test)
CONVERTER_FILE_ID=$(echo "$CONVERTER_UPLOAD_RESP" | jq -r '.id')

CONVERTER_DOC_RESP=$($SOAT_CLI ingest-document \
  --project-id "$PROJECT_PUBLIC_ID" \
  --file-id "$CONVERTER_FILE_ID" \
  --path-prefix /smoke/ \
  --async false)
CONVERTER_DOC_ID=$(echo "$CONVERTER_DOC_RESP" | jq -r '.id')
CONVERTER_DOC_STATUS=$(echo "$CONVERTER_DOC_RESP" | jq -r '.status')
echo "Converter-ingested document id: $CONVERTER_DOC_ID status: $CONVERTER_DOC_STATUS"
if [ "$CONVERTER_DOC_STATUS" != "ready" ]; then
  echo "ERROR: converter ingestion expected status 'ready', got '$CONVERTER_DOC_STATUS'" >&2
  echo "$CONVERTER_DOC_RESP" >&2
  exit 1
fi

CONVERTER_DOC_CONTENT=$($SOAT_CLI get-document --document-id "$CONVERTER_DOC_ID" | jq -r '.content')
if [ "$CONVERTER_DOC_CONTENT" != "$CONVERTER_TOOL_TEXT" ]; then
  echo "ERROR: converter-ingested document content mismatch" >&2
  echo "expected: $CONVERTER_TOOL_TEXT" >&2
  echo "got: $CONVERTER_DOC_CONTENT" >&2
  exit 1
fi
echo "Ingestion rule converter flow: OK"

echo "--- Cleaning up ingestion rule resources ---"
$SOAT_CLI delete-document --document-id "$CONVERTER_DOC_ID"
$SOAT_CLI delete-ingestion-rule --ingestion-rule-id "$INGESTION_RULE_ID"
$SOAT_CLI delete-tool --tool-id "$CONVERTER_TOOL_ID"
$SOAT_CLI delete-tool --tool-id "$CONVERTER_HTTP_TOOL_ID"
echo "Ingestion rule resources cleaned up."

# 12g. Async conversion — a converter deferring with { status: "pending" }
# leaves the document `processing` instead of failing, and the new
# ingestion-callback endpoint is live (a bad token is rejected with 401).
# The pipeline's fixed `output` always returns the deferral, regardless of
# the wrapped http call's real response (same deterministic-stub pattern as
# the sync converter above) — no external provider needed.
echo "--- Creating an async (pending) converter tool chain ---"
ASYNC_HTTP_TOOL_RESP=$($SOAT_CLI create-tool \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name ingestion-converter-async-stub-http \
  --type http \
  --description "Deterministic stub call used as an async ingestion-rule converter step." \
  --parameters '{"type":"object","properties":{},"required":[]}' \
  --execute "{\"url\":\"$SERVER_URL/api/v1/projects\",\"method\":\"GET\",\"headers\":{\"Authorization\":\"Bearer $TOKEN\"}}")
ASYNC_HTTP_TOOL_ID=$(echo "$ASYNC_HTTP_TOOL_RESP" | jq -r '.id')

ASYNC_PIPELINE_TOOL_RESP=$($SOAT_CLI create-tool \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name ingestion-converter-async-stub \
  --type pipeline \
  --description "Wraps the stub http call but always defers with status: pending." \
  --pipeline "{\"steps\":[{\"id\":\"call\",\"tool_id\":\"$ASYNC_HTTP_TOOL_ID\",\"input\":{}}],\"output\":{\"status\":\"pending\"}}")
ASYNC_TOOL_ID=$(echo "$ASYNC_PIPELINE_TOOL_RESP" | jq -r '.id')
echo "Async converter pipeline tool id: $ASYNC_TOOL_ID"

ASYNC_RULE_RESP=$($SOAT_CLI create-ingestion-rule \
  --project-id "$PROJECT_PUBLIC_ID" \
  --content-type-glob "image/x-smoke-test-async" \
  --tool-id "$ASYNC_TOOL_ID" \
  --file-delivery base64 \
  --chunk-strategy whole)
ASYNC_RULE_ID=$(echo "$ASYNC_RULE_RESP" | jq -r '.id')
if [ -z "$ASYNC_RULE_ID" ] || [ "$ASYNC_RULE_ID" = "null" ]; then
  echo "ERROR: create-ingestion-rule (async) did not return a rule id" >&2
  echo "$ASYNC_RULE_RESP" >&2
  exit 1
fi

echo "--- Ingesting a file that defers via the async converter ---"
ASYNC_IMAGE_BASE64=$(printf 'fake-smoke-test-async-image-bytes' | base64 | tr -d '\n')
ASYNC_UPLOAD_RESP=$($SOAT_CLI upload-file-base64 \
  --project-id "$PROJECT_PUBLIC_ID" \
  --filename smoke-test-async-image.smk \
  --content "$ASYNC_IMAGE_BASE64" \
  --content_type image/x-smoke-test-async)
ASYNC_FILE_ID=$(echo "$ASYNC_UPLOAD_RESP" | jq -r '.id')

# Async by default (no --async false) — the request returns immediately.
ASYNC_DOC_RESP=$($SOAT_CLI ingest-document \
  --project-id "$PROJECT_PUBLIC_ID" \
  --file-id "$ASYNC_FILE_ID" \
  --path-prefix /smoke/)
ASYNC_DOC_ID=$(echo "$ASYNC_DOC_RESP" | jq -r '.id')
echo "Async document id: $ASYNC_DOC_ID"

echo "--- Polling until the converter's deferral is recorded (status: processing) ---"
ASYNC_ATTEMPTS=0
ASYNC_STATUS="pending"
while [ "$ASYNC_STATUS" != "processing" ]; do
  ASYNC_ATTEMPTS=$((ASYNC_ATTEMPTS + 1))
  if [ "$ASYNC_ATTEMPTS" -gt 30 ]; then
    echo "ERROR: document never reached status 'processing' (async deferral)" >&2
    $SOAT_CLI get-document-status --document-id "$ASYNC_DOC_ID" >&2
    exit 1
  fi
  ASYNC_STATUS=$($SOAT_CLI get-document-status --document-id "$ASYNC_DOC_ID" | jq -r '.status')
  [ "$ASYNC_STATUS" = "processing" ] || sleep 1
done
echo "Async document deferred to: $ASYNC_STATUS"

echo "--- A bad callback token is rejected (401) ---"
set +e
BAD_CALLBACK_RESP=$($SOAT_CLI complete-ingestion-callback \
  --document-id "$ASYNC_DOC_ID" \
  --token not-a-real-token \
  --text "should be rejected" 2>&1)
BAD_CALLBACK_EXIT=$?
set -e
if [ "$BAD_CALLBACK_EXIT" -eq 0 ]; then
  echo "ERROR: expected complete-ingestion-callback to fail for an invalid token" >&2
  echo "$BAD_CALLBACK_RESP" >&2
  exit 1
fi
if ! echo "$BAD_CALLBACK_RESP" | grep -q 'INGESTION_CALLBACK_INVALID_TOKEN'; then
  echo "ERROR: expected INGESTION_CALLBACK_INVALID_TOKEN for a bad token" >&2
  echo "$BAD_CALLBACK_RESP" >&2
  exit 1
fi
echo "Async conversion + ingestion-callback wiring: OK"

echo "--- Cleaning up async ingestion rule resources ---"
$SOAT_CLI delete-document --document-id "$ASYNC_DOC_ID"
$SOAT_CLI delete-ingestion-rule --ingestion-rule-id "$ASYNC_RULE_ID"
$SOAT_CLI delete-tool --tool-id "$ASYNC_TOOL_ID"
$SOAT_CLI delete-tool --tool-id "$ASYNC_HTTP_TOOL_ID"
echo "Async ingestion rule resources cleaned up."

# 13. Delete documents
echo "--- Deleting documents ---"
$SOAT_CLI delete-document --document-id "$DOC1_ID"
$SOAT_CLI delete-document --document-id "$DOC2_ID"
$SOAT_CLI delete-document --document-id "$PDF_DOC_ID"
$SOAT_CLI delete-document --document-id "$MD_DOC_ID"
echo "Documents deleted."

# 13b. Memories — CRUD + search
echo "=== Memories ==="

# Create memory
echo "--- Creating memory ---"
MEM_RESP=$($SOAT_CLI create-memory \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "Smoke Test Memory" \
  --description "A memory for smoke testing")
MEM_ID=$(echo "$MEM_RESP" | jq -r '.id')
if ! printf '%s\n' "$MEM_ID" | grep -q '^mem_'; then
  echo "ERROR: memory id expected to start with 'mem_', got '$MEM_ID'" >&2
  exit 1
fi
echo "Memory id: $MEM_ID"

# Get memory
echo "--- Getting memory ---"
MEM_GET_RESP=$($SOAT_CLI get-memory --memory-id "$MEM_ID")
if ! printf '%s\n' "$MEM_GET_RESP" | jq -e --arg id "$MEM_ID" '.id == $id' >/dev/null 2>&1; then
  echo "ERROR: GET memory returned unexpected payload" >&2
  echo "$MEM_GET_RESP" >&2
  exit 1
fi
echo "Memory retrieved."

# List memories
echo "--- Listing memories ---"
MEM_LIST_RESP=$($SOAT_CLI list-memories --project_id "$PROJECT_PUBLIC_ID")
if ! printf '%s\n' "$MEM_LIST_RESP" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: LIST memories did not return an array" >&2
  echo "$MEM_LIST_RESP" >&2
  exit 1
fi
echo "Memories listed."

# Update memory
echo "--- Updating memory ---"
MEM_UPDATE_RESP=$($SOAT_CLI update-memory --memory-id "$MEM_ID" \
  --name "Updated Smoke Memory")
if ! printf '%s\n' "$MEM_UPDATE_RESP" | jq -e '.name == "Updated Smoke Memory"' >/dev/null 2>&1; then
  echo "ERROR: UPDATE memory did not return updated name" >&2
  echo "$MEM_UPDATE_RESP" >&2
  exit 1
fi
echo "Memory updated."

# ── Memory entries — dedup write algorithm ────────────────────────────────────
echo "--- Memory entries: first write (created) ---"
ME1_RESP=$($SOAT_CLI create-memory-entry \
  --memory-id "$MEM_ID" \
  --content "Smoke test customer prefers email over phone calls")
ME1_ACTION=$(printf '%s\n' "$ME1_RESP" | jq -r '.action')
ME1_ID=$(printf '%s\n' "$ME1_RESP" | jq -r '.id')
if [ "$ME1_ACTION" != "created" ]; then
  echo "ERROR: Expected action=created, got $ME1_ACTION" >&2
  echo "$ME1_RESP" >&2
  exit 1
fi
echo "Memory entry created: $ME1_ID"

echo "--- Memory entries: duplicate write (skipped) ---"
ME_SKIP_RESP=$($SOAT_CLI create-memory-entry \
  --memory-id "$MEM_ID" \
  --content "Smoke test customer prefers email over phone calls")
ME_SKIP_ACTION=$(printf '%s\n' "$ME_SKIP_RESP" | jq -r '.action')
if [ "$ME_SKIP_ACTION" != "skipped" ]; then
  echo "ERROR: Expected action=skipped, got $ME_SKIP_ACTION" >&2
  echo "$ME_SKIP_RESP" >&2
  exit 1
fi
echo "Duplicate correctly skipped."

echo "--- Memory entries: similar write (updated) ---"
ME_UPD_RESP=$($SOAT_CLI create-memory-entry \
  --memory-id "$MEM_ID" \
  --content "Smoke test customer prefers email, especially for billing inquiries")
ME_UPD_ACTION=$(printf '%s\n' "$ME_UPD_RESP" | jq -r '.action')
if [ "$ME_UPD_ACTION" != "updated" ]; then
  echo "ERROR: Expected action=updated, got $ME_UPD_ACTION" >&2
  echo "$ME_UPD_RESP" >&2
  exit 1
fi
echo "Similar entry correctly merged (updated)."

echo "--- Memory entries: unrelated write (created) ---"
ME2_RESP=$($SOAT_CLI create-memory-entry \
  --memory-id "$MEM_ID" \
  --content "Smoke test customer fiscal year ends in December")
ME2_ACTION=$(printf '%s\n' "$ME2_RESP" | jq -r '.action')
if [ "$ME2_ACTION" != "created" ]; then
  echo "ERROR: Expected action=created for unrelated fact, got $ME2_ACTION" >&2
  echo "$ME2_RESP" >&2
  exit 1
fi
echo "Unrelated entry created."

echo "--- List memory entries ---"
ME_LIST_RESP=$($SOAT_CLI list-memory-entries --memory-id "$MEM_ID")
ME_LIST_COUNT=$(printf '%s\n' "$ME_LIST_RESP" | jq 'length')
if [ "$ME_LIST_COUNT" -ne 2 ]; then
  echo "ERROR: Expected 2 entries after dedup writes, got $ME_LIST_COUNT" >&2
  echo "$ME_LIST_RESP" >&2
  exit 1
fi
echo "Memory entries listed: $ME_LIST_COUNT entries."

echo "--- Knowledge search via memory_ids ---"
KS_RESP=$($SOAT_CLI search-knowledge \
  --project-id "$PROJECT_PUBLIC_ID" \
  --query "smoke test customer communication" \
  --memory-ids "[\"$MEM_ID\"]")
KS_COUNT=$(printf '%s\n' "$KS_RESP" | jq '.results | length')
if [ "$KS_COUNT" -lt 1 ]; then
  echo "ERROR: Knowledge search returned 0 results" >&2
  echo "$KS_RESP" >&2
  exit 1
fi
echo "Knowledge search returned $KS_COUNT result(s)."
echo "Memory entries + knowledge search coverage: OK"

# Delete memory
echo "--- Deleting memory ---"
$SOAT_CLI delete-memory --memory-id "$MEM_ID"
echo "Memory deleted."

# Verify memory is gone (404)
echo "--- Verifying memory deletion ---"
expect_cli_error_status 404 get-memory --memory-id "$MEM_ID"
echo "Memory correctly returns 404 after deletion."

echo "Memories coverage: OK"

# 13c. Orchestrations — CRUD + runs + human input
echo "=== Orchestrations ==="

echo "--- Creating orchestration-scoped auth ---"
ORCH_POLICY_RESP=$($SOAT_CLI create-policy \
  --name smoke-orchestration-policy \
  --document '{"statement":[{"effect":"Allow","action":["orchestrations:CreateOrchestration","orchestrations:ValidateOrchestration","orchestrations:ListOrchestrations","orchestrations:GetOrchestration","orchestrations:UpdateOrchestration","orchestrations:DeleteOrchestration","orchestrations:StartRun","orchestrations:ListRuns","orchestrations:GetRun","orchestrations:CancelRun","orchestrations:SubmitHumanInput","orchestrations:ResumeRun"]}]}' )
ORCH_POLICY_ID=$(printf '%s\n' "$ORCH_POLICY_RESP" | jq -r '.id')
if [ -z "$ORCH_POLICY_ID" ] || [ "$ORCH_POLICY_ID" = "null" ]; then
  echo "Failed to create orchestration policy"
  printf '%s\n' "$ORCH_POLICY_RESP"
  exit 1
fi

ORCH_API_KEY_RESP=$($SOAT_CLI create-api-key \
  --name smoke-orchestration-key \
  --project_id "$PROJECT_PUBLIC_ID" \
  --policy_ids "[\"$ORCH_POLICY_ID\"]")
ORCH_API_KEY_ID=$(printf '%s\n' "$ORCH_API_KEY_RESP" | jq -r '.id')
ORCH_API_KEY_RAW=$(printf '%s\n' "$ORCH_API_KEY_RESP" | jq -r '.key')
if [ -z "$ORCH_API_KEY_ID" ] || [ "$ORCH_API_KEY_ID" = "null" ] || [ -z "$ORCH_API_KEY_RAW" ] || [ "$ORCH_API_KEY_RAW" = "null" ]; then
  echo "Failed to create orchestration API key"
  printf '%s\n' "$ORCH_API_KEY_RESP"
  exit 1
fi
echo "Orchestration-scoped auth: OK"

echo "--- Validating orchestration graph (valid) ---"
ORCH_VALID_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI validate-orchestration \
  --nodes '[{"id":"seed","type":"transform","expression":{"var":"theme"},"output_mapping":{"result":"state.theme"}},{"id":"decorate","type":"transform","expression":{"cat":[{"var":"theme"}," sonnet"]},"input_mapping":{"t":{"var":"theme"}},"output_mapping":{"result":"state.title"}}]' \
  --edges '[{"from":"seed","to":"decorate"}]')
if ! printf '%s\n' "$ORCH_VALID_RESP" | jq -e '.valid == true' >/dev/null 2>&1; then
  echo "validate-orchestration did not report a valid graph as valid"
  printf '%s\n' "$ORCH_VALID_RESP"
  exit 1
fi
echo "Validate orchestration (valid): OK"

echo "--- Validating orchestration graph with a poll node (valid) ---"
ORCH_POLL_VALID_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI validate-orchestration \
  --nodes '[{"id":"wait","type":"poll","tool_id":"tool_status","interval":"5s","exit_condition":{"==":[{"var":"response.status"},"completed"]},"max_iterations":3}]' \
  --edges '[]')
if ! printf '%s\n' "$ORCH_POLL_VALID_RESP" | jq -e '.valid == true' >/dev/null 2>&1; then
  echo "validate-orchestration did not accept a well-formed poll node"
  printf '%s\n' "$ORCH_POLL_VALID_RESP"
  exit 1
fi
echo "Validate orchestration with poll node (valid): OK"

echo "--- Validating orchestration graph with an incomplete poll node (invalid) ---"
ORCH_POLL_INVALID_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI validate-orchestration \
  --nodes '[{"id":"wait","type":"poll"}]' \
  --edges '[]')
if ! printf '%s\n' "$ORCH_POLL_INVALID_RESP" | jq -e '.valid == false and (.errors | length) > 0' >/dev/null 2>&1; then
  echo "validate-orchestration did not reject an incomplete poll node"
  printf '%s\n' "$ORCH_POLL_INVALID_RESP"
  exit 1
fi
echo "Validate orchestration with incomplete poll node (invalid): OK"

echo "--- Validating orchestration graph (invalid) ---"
ORCH_INVALID_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI validate-orchestration \
  --nodes '[{"id":"a","type":"agent"}]' \
  --edges '[{"from":"a","to":"ghost"}]')
if ! printf '%s\n' "$ORCH_INVALID_RESP" | jq -e '.valid == false and (.errors | length) > 0' >/dev/null 2>&1; then
  echo "validate-orchestration did not report an invalid graph as invalid"
  printf '%s\n' "$ORCH_INVALID_RESP"
  exit 1
fi
echo "Validate orchestration (invalid): OK"

echo "--- Rejecting invalid orchestration at create ---"
ORCH_REJECT_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI create-orchestration \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-orchestration-invalid" \
  --nodes '[{"id":"a","type":"transform","expression":1},{"id":"b","type":"transform","expression":1}]' \
  --edges '[{"from":"a","to":"b"},{"from":"b","to":"a"}]' || true)
if ! printf '%s\n' "$ORCH_REJECT_RESP" | jq -e '.error.code == "ORCHESTRATION_VALIDATION_FAILED"' >/dev/null 2>&1; then
  echo "create-orchestration did not reject a cyclic graph"
  printf '%s\n' "$ORCH_REJECT_RESP"
  exit 1
fi
echo "Reject invalid orchestration at create: OK"

echo "--- Creating orchestration ---"
ORCH_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI create-orchestration \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-orchestration" \
  --nodes '[{"id":"seed","type":"transform","expression":{"var":"theme"},"output_mapping":{"result":"state.theme"}},{"id":"decorate","type":"transform","expression":{"cat":[{"var":"theme"}," sonnet"]},"output_mapping":{"result":"state.title"}}]' \
  --edges '[{"from":"seed","to":"decorate"}]')
ORCH_ID=$(printf '%s\n' "$ORCH_RESP" | jq -r '.id')
if [ -z "$ORCH_ID" ] || [ "$ORCH_ID" = "null" ]; then
  echo "Failed to create orchestration"
  printf '%s\n' "$ORCH_RESP"
  exit 1
fi
echo "Orchestration id: $ORCH_ID"

echo "--- Listing orchestrations ---"
ORCH_LIST_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI list-orchestrations --project-id "$PROJECT_PUBLIC_ID")
if ! printf '%s\n' "$ORCH_LIST_RESP" | jq -e --arg id "$ORCH_ID" 'map(.id) | index($id) != null' >/dev/null 2>&1; then
  echo "list-orchestrations did not include created orchestration"
  printf '%s\n' "$ORCH_LIST_RESP"
  exit 1
fi
echo "Orchestration list: OK"

echo "--- Getting orchestration ---"
ORCH_GET_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI get-orchestration --orchestration-id "$ORCH_ID")
if ! printf '%s\n' "$ORCH_GET_RESP" | jq -e --arg id "$ORCH_ID" '.id == $id' >/dev/null 2>&1; then
  echo "get-orchestration returned unexpected response"
  printf '%s\n' "$ORCH_GET_RESP"
  exit 1
fi
echo "Get orchestration: OK"

echo "--- Updating orchestration ---"
ORCH_UPDATE_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI update-orchestration \
  --orchestration-id "$ORCH_ID" \
  --description "Smoke orchestration coverage")
if ! printf '%s\n' "$ORCH_UPDATE_RESP" | jq -e '.description == "Smoke orchestration coverage"' >/dev/null 2>&1; then
  echo "update-orchestration did not persist description"
  printf '%s\n' "$ORCH_UPDATE_RESP"
  exit 1
fi
echo "Update orchestration: OK"

echo "--- Starting completed run (synchronous wait) ---"
ORCH_RUN_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI start-orchestration-run \
  --orchestration-id "$ORCH_ID" \
  --input '{"theme":"orchestration"}' \
  --wait true)
ORCH_RUN_ID=$(printf '%s\n' "$ORCH_RUN_RESP" | jq -r '.id')
ORCH_RUN_STATUS=$(printf '%s\n' "$ORCH_RUN_RESP" | jq -r '.status')
ORCH_RUN_TITLE=$(printf '%s\n' "$ORCH_RUN_RESP" | jq -r '.state.title')
if [ "$ORCH_RUN_STATUS" != "succeeded" ] || [ "$ORCH_RUN_TITLE" != "orchestration sonnet" ]; then
  echo "start-orchestration-run did not complete as expected"
  printf '%s\n' "$ORCH_RUN_RESP"
  exit 1
fi
echo "Completed run: OK"

echo "--- Getting run ---"
ORCH_RUN_GET_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI get-orchestration-run \
  --run-id "$ORCH_RUN_ID")
if ! printf '%s\n' "$ORCH_RUN_GET_RESP" | jq -e --arg id "$ORCH_RUN_ID" '.id == $id and .status == "succeeded"' >/dev/null 2>&1; then
  echo "get-orchestration-run returned unexpected response"
  printf '%s\n' "$ORCH_RUN_GET_RESP"
  exit 1
fi
# Per-node execution records: every node that ran is traceable with a status.
if ! printf '%s\n' "$ORCH_RUN_GET_RESP" | jq -e '(.node_executions | type) == "array" and (.node_executions | length) >= 1 and (.node_executions | all(.status == "completed"))' >/dev/null 2>&1; then
  echo "get-orchestration-run did not include completed node_executions"
  printf '%s\n' "$ORCH_RUN_GET_RESP"
  exit 1
fi
echo "Get run: OK"

echo "--- Listing runs ---"
ORCH_RUN_LIST_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI list-orchestration-runs --orchestration-id "$ORCH_ID")
if ! printf '%s\n' "$ORCH_RUN_LIST_RESP" | jq -e --arg id "$ORCH_RUN_ID" 'map(.id) | index($id) != null' >/dev/null 2>&1; then
  echo "list-orchestration-runs did not include completed run"
  printf '%s\n' "$ORCH_RUN_LIST_RESP"
  exit 1
fi
echo "List runs: OK"

echo "--- Creating human-review orchestration ---"
HUMAN_ORCH_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI create-orchestration \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-human-orchestration" \
  --nodes '[{"id":"approval","type":"human","prompt":"Approve the poem?","options":["approve","reject"],"input_mapping":{"language":"pt-BR","documentId":{"var":"temaDocumentId"},"label":{"cat":["Tema: ",{"var":"titulo"}]}},"output_mapping":{"choice":"state.review"}},{"id":"finalize","type":"transform","expression":{"var":"review"},"output_mapping":{"result":"state.finalReview"}}]' \
  --edges '[{"from":"approval","to":"finalize"}]')
HUMAN_ORCH_ID=$(printf '%s\n' "$HUMAN_ORCH_RESP" | jq -r '.id')
if [ -z "$HUMAN_ORCH_ID" ] || [ "$HUMAN_ORCH_ID" = "null" ]; then
  echo "Failed to create human orchestration"
  printf '%s\n' "$HUMAN_ORCH_RESP"
  exit 1
fi
echo "Human orchestration id: $HUMAN_ORCH_ID"

echo "--- Starting paused run ---"
HUMAN_RUN_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI start-orchestration-run \
  --orchestration-id "$HUMAN_ORCH_ID" \
  --input '{"temaDocumentId":"ood_123","titulo":"Verao"}' \
  --wait true)
HUMAN_RUN_ID=$(printf '%s\n' "$HUMAN_RUN_RESP" | jq -r '.id')
HUMAN_RUN_STATUS=$(printf '%s\n' "$HUMAN_RUN_RESP" | jq -r '.status')
HUMAN_NODE_ID=$(printf '%s\n' "$HUMAN_RUN_RESP" | jq -r '.required_action.node_id')
if [ "$HUMAN_RUN_STATUS" != "awaiting_input" ] || [ "$HUMAN_NODE_ID" != "approval" ]; then
  echo "Human orchestration did not pause as expected"
  printf '%s\n' "$HUMAN_RUN_RESP"
  exit 1
fi
# JSON Logic input_mapping: literal passthrough, {var} from run input, computed expression.
if ! printf '%s\n' "$HUMAN_RUN_RESP" | jq -e '.required_action.context.language == "pt-BR" and .required_action.context.document_id == "ood_123" and .required_action.context.label == "Tema: Verao"' >/dev/null 2>&1; then
  echo "Human node input_mapping did not resolve JSON Logic as expected"
  printf '%s\n' "$HUMAN_RUN_RESP"
  exit 1
fi
echo "Paused run: OK"

echo "--- Submitting human input ---"
HUMAN_INPUT_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI submit-human-input \
  --run-id "$HUMAN_RUN_ID" \
  --node-id "$HUMAN_NODE_ID" \
  --output '{"choice":"approve"}')
if ! printf '%s\n' "$HUMAN_INPUT_RESP" | jq -e '.status == "succeeded" and .output.finalize.result == "approve"' >/dev/null 2>&1; then
  echo "submit-human-input returned unexpected response"
  printf '%s\n' "$HUMAN_INPUT_RESP"
  exit 1
fi
echo "Submit human input: OK"

echo "--- Resuming a paused run without input ---"
RESUME_CANDIDATE_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI start-orchestration-run \
  --orchestration-id "$HUMAN_ORCH_ID" \
  --input '{}' \
  --wait true)
RESUME_RUN_ID=$(printf '%s\n' "$RESUME_CANDIDATE_RESP" | jq -r '.id')
if ! printf '%s\n' "$RESUME_CANDIDATE_RESP" | jq -e '.status == "awaiting_input" and .required_action.node_id == "approval"' >/dev/null 2>&1; then
  echo "Expected resume candidate run to be paused"
  printf '%s\n' "$RESUME_CANDIDATE_RESP"
  exit 1
fi
HUMAN_RESUME_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI resume-orchestration-run \
  --run-id "$RESUME_RUN_ID")
if ! printf '%s\n' "$HUMAN_RESUME_RESP" | jq -e '.status == "awaiting_input" and .required_action.node_id == "approval"' >/dev/null 2>&1; then
  echo "resume-orchestration-run did not complete human orchestration as expected"
  printf '%s\n' "$HUMAN_RESUME_RESP"
  exit 1
fi
echo "Resume run: OK"

echo "--- Cancelling a paused run ---"
CANCEL_CANDIDATE_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI start-orchestration-run \
  --orchestration-id "$HUMAN_ORCH_ID" \
  --input '{}' \
  --wait true)
CANCEL_RUN_ID=$(printf '%s\n' "$CANCEL_CANDIDATE_RESP" | jq -r '.id')
if ! printf '%s\n' "$CANCEL_CANDIDATE_RESP" | jq -e '.status == "awaiting_input"' >/dev/null 2>&1; then
  echo "Expected second human run to be paused before cancellation"
  printf '%s\n' "$CANCEL_CANDIDATE_RESP"
  exit 1
fi
CANCEL_RUN_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI cancel-orchestration-run \
  --run-id "$CANCEL_RUN_ID")
if ! printf '%s\n' "$CANCEL_RUN_RESP" | jq -e '.status == "cancelled"' >/dev/null 2>&1; then
  echo "cancel-orchestration-run did not return cancelled status"
  printf '%s\n' "$CANCEL_RUN_RESP"
  exit 1
fi
echo "Cancel run: OK"

echo "--- Condition-branch skipped node executions ---"
COND_ORCH_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI create-orchestration \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-cond-skip" \
  --nodes '[{"id":"check","type":"condition","expression":{"if":[{">": [{"var":"score"},0.8]},"high","low"]}},{"id":"high_path","type":"transform","expression":"high-ran","output_mapping":{"result":"state.high"}},{"id":"low_path","type":"transform","expression":"low-ran","output_mapping":{"result":"state.low"}}]' \
  --edges '[{"from":"check","to":"high_path","condition":"high"},{"from":"check","to":"low_path","condition":"low"}]')
COND_ORCH_ID=$(printf '%s\n' "$COND_ORCH_RESP" | jq -r '.id')
if [ -z "$COND_ORCH_ID" ] || [ "$COND_ORCH_ID" = "null" ]; then
  echo "Failed to create condition-skip orchestration"
  printf '%s\n' "$COND_ORCH_RESP"
  exit 1
fi

COND_RUN_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI start-orchestration-run \
  --orchestration-id "$COND_ORCH_ID" \
  --input '{"score":0.9}' \
  --wait true)
if ! printf '%s\n' "$COND_RUN_RESP" | jq -e '.status == "succeeded"' >/dev/null 2>&1; then
  echo "Condition-skip run did not complete"
  printf '%s\n' "$COND_RUN_RESP"
  exit 1
fi
if ! printf '%s\n' "$COND_RUN_RESP" | jq -e '
  (.node_executions | map(select(.node_id == "high_path")) | .[0].status) == "completed" and
  (.node_executions | map(select(.node_id == "low_path")) | .[0].status) == "skipped" and
  (.node_executions | map(select(.node_id == "low_path")) | .[0].started_at) == null
' >/dev/null 2>&1; then
  echo "Condition-skip run did not record expected skipped node"
  printf '%s\n' "$COND_RUN_RESP" | jq '.node_executions'
  exit 1
fi
SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI delete-orchestration --orchestration-id "$COND_ORCH_ID"
echo "Condition-branch skipped node executions: OK"

# --- Durable background execution ---------------------------------------------

echo "--- Starting an async run (returns immediately) ---"
ASYNC_ORCH_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI create-orchestration \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-async-orchestration" \
  --nodes '[{"id":"start","type":"transform","expression":"async ok","output_mapping":{"result":"state.msg"}}]' \
  --edges '[]')
ASYNC_ORCH_ID=$(printf '%s\n' "$ASYNC_ORCH_RESP" | jq -r '.id')

# No --wait: the run must come back immediately with status "running".
ASYNC_RUN_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI start-orchestration-run \
  --orchestration-id "$ASYNC_ORCH_ID" \
  --input '{}')
ASYNC_RUN_ID=$(printf '%s\n' "$ASYNC_RUN_RESP" | jq -r '.id')
if ! printf '%s\n' "$ASYNC_RUN_RESP" | jq -e '.status == "running"' >/dev/null 2>&1; then
  echo "start-orchestration-run (async) did not return status running"
  printf '%s\n' "$ASYNC_RUN_RESP"
  exit 1
fi
echo "Async run returned status running: OK"

# The background worker drives it to completion shortly after.
ASYNC_DONE=0
i=0
while [ "$i" -lt 30 ]; do
  ASYNC_GET=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI get-orchestration-run --run-id "$ASYNC_RUN_ID")
  ASYNC_STATUS=$(printf '%s\n' "$ASYNC_GET" | jq -r '.status')
  if [ "$ASYNC_STATUS" = "succeeded" ]; then
    ASYNC_DONE=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ASYNC_DONE" != "1" ] || ! printf '%s\n' "$ASYNC_GET" | jq -e '.state.msg == "async ok"' >/dev/null 2>&1; then
  echo "Async run did not complete in the background as expected"
  printf '%s\n' "$ASYNC_GET"
  exit 1
fi
echo "Async run completed in the background: OK"
SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI delete-orchestration --orchestration-id "$ASYNC_ORCH_ID"

echo "--- Delay run resumes via the background scheduler ---"
DELAY_ORCH_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI create-orchestration \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-delay-orchestration" \
  --nodes '[{"id":"pause","type":"delay","duration":"3s","output_mapping":{"waited":"state.waited"}},{"id":"after","type":"transform","expression":"resumed","output_mapping":{"result":"state.after"}}]' \
  --edges '[{"from":"pause","to":"after"}]')
DELAY_ORCH_ID=$(printf '%s\n' "$DELAY_ORCH_RESP" | jq -r '.id')

DELAY_RUN_RESP=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI start-orchestration-run \
  --orchestration-id "$DELAY_ORCH_ID" \
  --input '{}')
DELAY_RUN_ID=$(printf '%s\n' "$DELAY_RUN_RESP" | jq -r '.id')
if ! printf '%s\n' "$DELAY_RUN_RESP" | jq -e '.status == "running"' >/dev/null 2>&1; then
  echo "Delay run did not return status running"
  printf '%s\n' "$DELAY_RUN_RESP"
  exit 1
fi

# The delay is a scheduled resumption; the worker completes the run after the
# delay elapses (no HTTP request was held open).
DELAY_DONE=0
i=0
while [ "$i" -lt 30 ]; do
  DELAY_GET=$(SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI get-orchestration-run --run-id "$DELAY_RUN_ID")
  DELAY_STATUS=$(printf '%s\n' "$DELAY_GET" | jq -r '.status')
  if [ "$DELAY_STATUS" = "succeeded" ]; then
    DELAY_DONE=1
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$DELAY_DONE" != "1" ] || ! printf '%s\n' "$DELAY_GET" | jq -e '.state.waited == "3s" and .state.after == "resumed"' >/dev/null 2>&1; then
  echo "Delay run did not resume and complete via the scheduler"
  printf '%s\n' "$DELAY_GET"
  exit 1
fi
echo "Delay run resumed via scheduler: OK"
SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI delete-orchestration --orchestration-id "$DELAY_ORCH_ID"

echo "--- Deleting orchestrations ---"
SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI delete-orchestration --orchestration-id "$ORCH_ID"
SOAT_TOKEN="$ORCH_API_KEY_RAW" $SOAT_CLI delete-orchestration --orchestration-id "$HUMAN_ORCH_ID"
SOAT_TOKEN="$ORCH_API_KEY_RAW" expect_cli_error_status 404 get-orchestration --orchestration-id "$ORCH_ID"
SOAT_TOKEN="$ORCH_API_KEY_RAW" expect_cli_error_status 404 get-orchestration --orchestration-id "$HUMAN_ORCH_ID"
$SOAT_CLI delete-api-key --api-key-id "$ORCH_API_KEY_ID"
$SOAT_CLI delete-policy --policy-id "$ORCH_POLICY_ID"
echo "Orchestrations coverage: OK"

# 14. Chat completion — 401 without auth
echo "--- Chat completion: 401 without auth ---"
SOAT_TOKEN=invalid expect_cli_error_status 401 create-chat-completion --messages '[{"role":"user","content":"hello"}]'
echo "401 without auth: OK"

# 15. Chat completion — 400 without messages
echo "--- Chat completion: 400 without messages ---"
expect_cli_error_status 400 create-chat-completion
echo "400 without messages: OK"

# 15b. Chat completion — 400 without ai_provider_id
echo "--- Chat completion: 400 without ai_provider_id ---"
expect_cli_error_status 400 create-chat-completion --messages '[{"role":"user","content":"hello"}]'
echo "400 without ai_provider_id: OK"

# 16. Create AI provider (Ollama with qwen2.5:0.5b available in test env)
echo "--- Creating AI provider ---"
AI_PROVIDER_RESP=$($SOAT_CLI create-ai-provider \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name smoke-ollama \
  --provider ollama \
  --default_model "qwen2.5:0.5b" \
  --base_url "http://ollama:11434")
AI_PROVIDER_ID=$(echo "$AI_PROVIDER_RESP" | jq -r '.id')
echo "AI Provider id: $AI_PROVIDER_ID"

# 17. Chat completion — valid non-streaming request
echo "--- Chat completion: valid request ---"
CHAT_RESP=$($SOAT_CLI create-chat-completion --ai_provider_id "$AI_PROVIDER_ID" --messages '[{"role":"user","content":"say hello"}]')
CHAT_OBJECT=$(echo "$CHAT_RESP" | jq -r '.object')
if [ "$CHAT_OBJECT" != "chat.completion" ]; then
  echo "ERROR: Expected object=chat.completion, got $CHAT_OBJECT" >&2
  echo "$CHAT_RESP" >&2
  exit 1
fi
echo "Chat completion OK. Response: $(echo "$CHAT_RESP" | jq -r '.choices[0].message.content' | cut -c1-60)"

# 18. Chat completion — SSE streaming request
echo "--- Chat completion: SSE streaming ---"
CHAT_SSE_RESP=$($SOAT_CLI create-chat-completion --ai_provider_id "$AI_PROVIDER_ID" --messages '[{"role":"user","content":"say hello"}]' --stream true)
if ! printf '%s\n' "$CHAT_SSE_RESP" | grep -q "data: \[DONE\]"; then
  echo "ERROR: Chat SSE stream missing 'data: [DONE]'" >&2
  echo "$CHAT_SSE_RESP" >&2
  exit 1
fi
echo "Chat SSE stream OK."
echo "--- Chat SSE stream output ---"
echo "$CHAT_SSE_RESP"

# 19. Create an HTTP agent tool that calls GET /api/v1/projects on the SOAT server
echo "--- Creating HTTP agent tool (list-projects) ---"
TOOL_RESP=$($SOAT_CLI create-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name list-projects \
  --type http \
  --description "Lists all projects from the SOAT API. Call this tool whenever the user asks for the list of projects." \
  --parameters '{"type":"object","properties":{},"required":[]}' \
  --execute "{\"url\":\"$SERVER_URL/api/v1/projects\",\"method\":\"GET\",\"headers\":{\"Authorization\":\"Bearer $TOKEN\"}}")
TOOL_ID=$(echo "$TOOL_RESP" | jq -r '.id')
echo "Agent Tool id: $TOOL_ID"

# 19b. Create a pipeline tool that chains the list-projects HTTP tool twice and
# maps both step outputs. Exercises deterministic multi-step execution and JSON
# Logic output mapping over { input, steps } as a single callable unit. Step
# `b`'s input and the pipeline `output` both nest a `var` marker inside a plain
# object (e.g. `note.wrapped`, `echoed.container`) to exercise recursive JSON
# Logic resolution at any depth, not just at the top level (see issue #321).
echo "--- Creating pipeline tool ---"
PIPELINE_TOOL_RESP=$($SOAT_CLI create-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name compute-and-list \
  --type pipeline \
  --description "Runs list-projects twice and maps both step outputs" \
  --pipeline "{\"steps\":[{\"id\":\"a\",\"tool_id\":\"$TOOL_ID\",\"input\":{}},{\"id\":\"b\",\"tool_id\":\"$TOOL_ID\",\"input\":{\"note\":{\"wrapped\":{\"var\":\"steps.a\"}}}}],\"output\":{\"from_a\":{\"var\":\"steps.a\"},\"from_b\":{\"var\":\"steps.b\"},\"echoed\":{\"container\":{\"var\":\"input.tag\"}}}}")
PIPELINE_TOOL_ID=$(echo "$PIPELINE_TOOL_RESP" | jq -r '.id')
if [ -z "$PIPELINE_TOOL_ID" ] || [ "$PIPELINE_TOOL_ID" = "null" ]; then
  echo "FAIL: could not create pipeline tool"
  echo "$PIPELINE_TOOL_RESP"
  exit 1
fi
echo "Pipeline tool id: $PIPELINE_TOOL_ID"

# 19c. Call the pipeline — both steps hit GET /projects on the live server and
# the output mapping returns from_a / from_b / echoed.container (the latter
# resolved from a `var` nested inside a plain object, at both the step-input
# and pipeline-output level).
echo "--- Calling pipeline tool ---"
PIPELINE_CALL_RESP=$($SOAT_CLI call-tool --tool-id "$PIPELINE_TOOL_ID" --input '{"tag":"hello-nested"}')
printf '%s\n' "$PIPELINE_CALL_RESP" | jq .
if ! printf '%s\n' "$PIPELINE_CALL_RESP" | jq -e 'has("from_a") and has("from_b")' > /dev/null; then
  echo "FAIL: pipeline output missing mapped keys from_a/from_b"
  echo "$PIPELINE_CALL_RESP"
  exit 1
fi
if [ "$(printf '%s\n' "$PIPELINE_CALL_RESP" | jq -r '.echoed.container')" != "hello-nested" ]; then
  echo "FAIL: pipeline output did not resolve the nested var (echoed.container)"
  echo "$PIPELINE_CALL_RESP"
  exit 1
fi
echo "Pipeline call OK (nested JSON Logic resolution verified)"

# 19c2. A pipeline `output` that is itself a bare JSON Logic expression (e.g.
# `{"var": "steps.a.count"}`) must resolve to a bare scalar, not the literal
# unevaluated expression object (see issue #335).
echo "--- Creating pipeline tool with a bare-scalar output mapping ---"
BARE_OUTPUT_PIPELINE_RESP=$($SOAT_CLI create-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name list-projects-first-id \
  --type pipeline \
  --description "Returns a bare scalar extracted from a step output" \
  --pipeline "{\"steps\":[{\"id\":\"a\",\"tool_id\":\"$TOOL_ID\",\"input\":{}}],\"output\":{\"var\":\"steps.a.0.id\"}}")
BARE_OUTPUT_PIPELINE_ID=$(echo "$BARE_OUTPUT_PIPELINE_RESP" | jq -r '.id')
if [ -z "$BARE_OUTPUT_PIPELINE_ID" ] || [ "$BARE_OUTPUT_PIPELINE_ID" = "null" ]; then
  echo "FAIL: could not create bare-scalar-output pipeline tool"
  echo "$BARE_OUTPUT_PIPELINE_RESP"
  exit 1
fi
echo "Bare-scalar-output pipeline tool id: $BARE_OUTPUT_PIPELINE_ID"

echo "--- Calling pipeline tool with a bare-scalar output mapping ---"
BARE_OUTPUT_CALL_RESP=$($SOAT_CLI call-tool --tool-id "$BARE_OUTPUT_PIPELINE_ID" --input '{}')
printf '%s\n' "$BARE_OUTPUT_CALL_RESP" | jq .
if printf '%s\n' "$BARE_OUTPUT_CALL_RESP" | jq -e 'type != "string"' > /dev/null; then
  echo "FAIL: pipeline output mapping did not resolve to a bare scalar"
  echo "$BARE_OUTPUT_CALL_RESP"
  exit 1
fi
echo "Bare-scalar pipeline output OK"

# 19d. A universal `output_mapping` field reshapes a tool's raw result at call
# time, for every tool type — without wrapping it in a `pipeline` tool just to
# extract or reshape a field (see issue #346).
echo "--- Creating an http tool with output_mapping ---"
OUTPUT_MAPPING_TOOL_RESP=$($SOAT_CLI create-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name list-projects-first-id-output-mapping \
  --type http \
  --description "Lists projects and extracts the first project's id via output_mapping" \
  --parameters '{"type":"object","properties":{},"required":[]}' \
  --execute "{\"url\":\"$SERVER_URL/api/v1/projects\",\"method\":\"GET\",\"headers\":{\"Authorization\":\"Bearer $TOKEN\"}}" \
  --output-mapping '{"var":"output.0.id"}')
OUTPUT_MAPPING_TOOL_ID=$(echo "$OUTPUT_MAPPING_TOOL_RESP" | jq -r '.id')
if [ -z "$OUTPUT_MAPPING_TOOL_ID" ] || [ "$OUTPUT_MAPPING_TOOL_ID" = "null" ]; then
  echo "FAIL: could not create http tool with output_mapping"
  echo "$OUTPUT_MAPPING_TOOL_RESP"
  exit 1
fi
echo "output_mapping http tool id: $OUTPUT_MAPPING_TOOL_ID"

echo "--- Calling http tool with output_mapping ---"
OUTPUT_MAPPING_CALL_RESP=$($SOAT_CLI call-tool --tool-id "$OUTPUT_MAPPING_TOOL_ID" --input '{}')
printf '%s\n' "$OUTPUT_MAPPING_CALL_RESP" | jq .
if printf '%s\n' "$OUTPUT_MAPPING_CALL_RESP" | jq -e 'type != "string"' > /dev/null; then
  echo "FAIL: output_mapping did not resolve the http tool's raw result to a bare scalar"
  echo "$OUTPUT_MAPPING_CALL_RESP"
  exit 1
fi
echo "http tool output_mapping OK"
$SOAT_CLI delete-tool --tool-id "$BARE_OUTPUT_PIPELINE_ID"

# 19d. Cleanup — delete the pipeline tool (keep list-projects for the agent below)
$SOAT_CLI delete-tool --tool-id "$PIPELINE_TOOL_ID"

# 19e. Multipart http tool (issue #329) — body_mode:multipart must build a real
# multipart/form-data body with a base64 file field decoded into a file part.
# The tool uploads a file to the SOAT server's multipart endpoint; a returned
# file id proves the multipart request reached and was parsed by the server.
echo "--- Creating multipart HTTP tool (upload-file) ---"
MULTIPART_TOOL_RESP=$($SOAT_CLI create-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name upload-file-multipart \
  --type http \
  --description "Uploads a file via multipart/form-data." \
  --parameters '{"type":"object","properties":{"project_id":{"type":"string"},"file":{"type":"object"}},"required":["file"]}' \
  --execute "{\"url\":\"$SERVER_URL/api/v1/files/upload\",\"method\":\"POST\",\"body_mode\":\"multipart\",\"headers\":{\"Authorization\":\"Bearer $TOKEN\"}}")
MULTIPART_TOOL_ID=$(echo "$MULTIPART_TOOL_RESP" | jq -r '.id')
if [ -z "$MULTIPART_TOOL_ID" ] || [ "$MULTIPART_TOOL_ID" = "null" ]; then
  echo "FAIL: could not create multipart http tool"
  echo "$MULTIPART_TOOL_RESP"
  exit 1
fi
# body_mode must round-trip verbatim (snake_case) on the stored tool.
if [ "$(echo "$MULTIPART_TOOL_RESP" | jq -r '.execute.body_mode')" != "multipart" ]; then
  echo "FAIL: stored tool did not persist execute.body_mode=multipart"
  echo "$MULTIPART_TOOL_RESP"
  exit 1
fi
echo "Multipart tool id: $MULTIPART_TOOL_ID"

MULTIPART_FILE_B64=$(printf '%s' 'smoke multipart file body 329' | base64 | tr -d '\n')
echo "--- Calling multipart http tool ---"
MULTIPART_CALL_RESP=$($SOAT_CLI call-tool --tool-id "$MULTIPART_TOOL_ID" \
  --input "{\"project_id\":\"$PROJECT_PUBLIC_ID\",\"file\":{\"filename\":\"smoke.txt\",\"content_type\":\"text/plain\",\"data_base64\":\"$MULTIPART_FILE_B64\"}}")
printf '%s\n' "$MULTIPART_CALL_RESP" | jq .
if [ "$(printf '%s\n' "$MULTIPART_CALL_RESP" | jq -r '.id')" = "null" ]; then
  echo "FAIL: multipart tool call did not return an uploaded file id"
  echo "$MULTIPART_CALL_RESP"
  exit 1
fi
echo "Multipart http tool call OK (file uploaded via multipart/form-data)"
$SOAT_CLI delete-tool --tool-id "$MULTIPART_TOOL_ID"

# 19f. An http tool whose target rejects the request must surface the real
# upstream status via 502 TOOL_HTTP_ERROR, not a bare 500 (see GitHub issue
# on POST /tools/{tool_id}/call swallowing tool target errors).
echo "--- Creating HTTP tool proxying an unauthenticated request (expected 401 upstream) ---"
REJECTING_TOOL_RESP=$($SOAT_CLI create-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name proxy-unauthenticated-orchestrations \
  --type http \
  --description "Proxies an unauthenticated request to trigger an upstream 401." \
  --execute "{\"url\":\"$SERVER_URL/api/v1/orchestrations\",\"method\":\"GET\"}")
REJECTING_TOOL_ID=$(echo "$REJECTING_TOOL_RESP" | jq -r '.id')
if [ -z "$REJECTING_TOOL_ID" ] || [ "$REJECTING_TOOL_ID" = "null" ]; then
  echo "FAIL: could not create rejecting http tool"
  echo "$REJECTING_TOOL_RESP"
  exit 1
fi

REJECTING_CALL_RESP=$($SOAT_CLI call-tool --tool-id "$REJECTING_TOOL_ID" 2>&1 || true)
if ! printf '%s\n' "$REJECTING_CALL_RESP" | jq -e '.error.code == "TOOL_HTTP_ERROR"' >/dev/null 2>&1; then
  echo "FAIL: calling an http tool whose target returns a non-2xx response did not surface TOOL_HTTP_ERROR" >&2
  echo "$REJECTING_CALL_RESP" >&2
  exit 1
fi
if [ "$(printf '%s\n' "$REJECTING_CALL_RESP" | jq -r '.error.meta.tool_status_code')" != "401" ]; then
  echo "FAIL: TOOL_HTTP_ERROR meta did not carry the real upstream status code" >&2
  echo "$REJECTING_CALL_RESP" >&2
  exit 1
fi
echo "HTTP tool upstream error surfacing OK (502 TOOL_HTTP_ERROR with real status in meta)"
$SOAT_CLI delete-tool --tool-id "$REJECTING_TOOL_ID"

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

# 22b2. Knowledge config: automatic extraction flag round-trip
echo "--- Setting knowledge_config with extraction flag ---"
KC_UPDATE_RESP=$($SOAT_CLI update-agent --agent-id "$AGENT_ID" \
  --knowledge_config "{\"write_memory_id\":\"$MEM_ID\",\"extraction\":true}")
if ! printf '%s\n' "$KC_UPDATE_RESP" | jq -e '.knowledge_config.extraction == true' >/dev/null 2>&1; then
  echo "ERROR: update-agent did not round-trip knowledge_config.extraction" >&2
  echo "$KC_UPDATE_RESP" >&2
  exit 1
fi
KC_GET_RESP=$($SOAT_CLI get-agent --agent-id "$AGENT_ID")
if ! printf '%s\n' "$KC_GET_RESP" | jq -e --arg mem "$MEM_ID" '.knowledge_config.write_memory_id == $mem and .knowledge_config.extraction == true' >/dev/null 2>&1; then
  echo "ERROR: get-agent did not return knowledge_config extraction settings" >&2
  echo "$KC_GET_RESP" >&2
  exit 1
fi
# Object form: provider/model/prompt overrides must round-trip too.
KC_OBJ_RESP=$($SOAT_CLI update-agent --agent-id "$AGENT_ID" \
  --knowledge_config "{\"write_memory_id\":\"$MEM_ID\",\"extraction\":{\"model\":\"smoke-extraction-model\",\"prompt\":\"Extract decisions only.\"}}")
if ! printf '%s\n' "$KC_OBJ_RESP" | jq -e '.knowledge_config.extraction.model == "smoke-extraction-model" and .knowledge_config.extraction.prompt == "Extract decisions only."' >/dev/null 2>&1; then
  echo "ERROR: update-agent did not round-trip the extraction object form" >&2
  echo "$KC_OBJ_RESP" >&2
  exit 1
fi
# Disable extraction again so later generations in this script do not
# trigger extra extraction LLM calls (extraction itself is asynchronous and
# LLM-dependent, so its behavior is covered by unit tests, not smoke).
$SOAT_CLI update-agent --agent-id "$AGENT_ID" --knowledge_config '{}' >/dev/null
echo "knowledge_config extraction round-trip: OK"

# 22b3. Deep thinking moved to Discussions — reasoning is no longer a valid
# agent field, so it is rejected (as an unknown field) with a 400.
echo "--- Asserting reasoning is rejected on agents ---"
RC_REMOVED_RESP=$($SOAT_CLI update-agent --agent-id "$AGENT_ID" \
  --reasoning '{"effort":"low"}' 2>&1 || true)
if ! printf '%s\n' "$RC_REMOVED_RESP" | jq -e '.status == 400' >/dev/null 2>&1; then
  echo "ERROR: reasoning on an agent was not rejected with a 400" >&2
  echo "$RC_REMOVED_RESP" >&2
  exit 1
fi
echo "reasoning rejected on agents: OK"

# 22b4. Discussions — create a deliberation config, run it, inspect the run.
echo "--- Creating a discussion ---"
DISCUSSION_RESP=$($SOAT_CLI create-discussion \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "Smoke panel" \
  --ai_provider_id "$AI_PROVIDER_ID" \
  --max_rounds 1 \
  --participants '[{"name":"Advocate","prompt":"Argue for."},{"name":"Skeptic","prompt":"Argue against."}]')
DISCUSSION_ID=$(echo "$DISCUSSION_RESP" | jq -r '.id')
if [ -z "$DISCUSSION_ID" ] || [ "$DISCUSSION_ID" = "null" ]; then
  echo "ERROR: create-discussion did not return an id" >&2
  echo "$DISCUSSION_RESP" >&2
  exit 1
fi
echo "Discussion id: $DISCUSSION_ID"

$SOAT_CLI get-discussion --discussion-id "$DISCUSSION_ID" >/dev/null
$SOAT_CLI list-discussions --project_id "$PROJECT_PUBLIC_ID" >/dev/null

# Run the discussion. The run is LLM-dependent and its `outcome` echoes the
# model's free-form text (which can contain characters that break `jq`), so
# extract the run id with a regex rather than parsing the whole response, and
# do not assert on the outcome content.
echo "--- Running the discussion ---"
RUN_RESP=$($SOAT_CLI create-discussion-run --discussion-id "$DISCUSSION_ID" \
  --topic "Should we ship on Friday?" 2>&1 || true)
RUN_ID=$(printf '%s' "$RUN_RESP" | grep -oE 'drn_[A-Za-z0-9]{16}' | head -1 || true)
if [ -z "$RUN_ID" ]; then
  echo "ERROR: create-discussion-run did not return a run id" >&2
  echo "$RUN_RESP" >&2
  exit 1
fi
$SOAT_CLI get-discussion-run --run-id "$RUN_ID" >/dev/null
$SOAT_CLI list-discussion-runs --discussion-id "$DISCUSSION_ID" >/dev/null
echo "discussion run: OK"

# A discussion-type tool references the discussion by id.
DISCUSSION_TOOL_RESP=$($SOAT_CLI create-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name ask-the-panel \
  --type discussion \
  --discussion_id "$DISCUSSION_ID")
if ! printf '%s\n' "$DISCUSSION_TOOL_RESP" | jq -e '.type == "discussion"' >/dev/null 2>&1; then
  echo "ERROR: create-tool did not create a discussion-type tool" >&2
  echo "$DISCUSSION_TOOL_RESP" >&2
  exit 1
fi
echo "discussion tool: OK"

# 22c. Create a deterministic HTTP tool for tool_output message content
echo "--- Creating project-detail tool ---"
PROJECT_DETAIL_TOOL_RESP=$($SOAT_CLI create-tool \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name project-detail \
  --type http \
  --description "Gets the current smoke test project." \
  --parameters '{"type":"object","properties":{},"required":[]}' \
  --execute "{\"url\":\"$SERVER_URL/api/v1/projects/$PROJECT_PUBLIC_ID\",\"method\":\"GET\",\"headers\":{\"Authorization\":\"Bearer $TOKEN\"}}")
PROJECT_DETAIL_TOOL_ID=$(echo "$PROJECT_DETAIL_TOOL_RESP" | jq -r '.id')
echo "Project-detail tool id: $PROJECT_DETAIL_TOOL_ID"

# 22d. Create an agent that echoes the resolved tool_output content
echo "--- Creating tool-output agent ---"
TOOL_OUTPUT_AGENT_RESP=$($SOAT_CLI create-agent \
  --project_id "$PROJECT_PUBLIC_ID" \
  --ai_provider_id "$AI_PROVIDER_ID" \
  --name tool-output-agent \
  --instructions "Repeat the user's last message exactly. Do not add any extra words or punctuation." \
  --tool_ids "[\"$PROJECT_DETAIL_TOOL_ID\"]" \
  --max_steps 2)
TOOL_OUTPUT_AGENT_ID=$(echo "$TOOL_OUTPUT_AGENT_RESP" | jq -r '.id')
echo "Tool-output agent id: $TOOL_OUTPUT_AGENT_ID"

# 22e. Run generation using tool_output content extracted via output_path
echo "--- Running tool_output message content generation ---"
TOOL_OUTPUT_GEN_RESP=$($SOAT_CLI create-agent-generation --agent-id "$TOOL_OUTPUT_AGENT_ID" \
  --messages '[{"role":"user","content":{"type":"tool_output","tool_id":"'"$PROJECT_DETAIL_TOOL_ID"'","output_path":".name"}}]' | sanitize_json)
echo "Tool-output generation response:"
printf '%s\n' "$TOOL_OUTPUT_GEN_RESP" | jq .

TOOL_OUTPUT_GEN_STATUS=$(printf '%s\n' "$TOOL_OUTPUT_GEN_RESP" | jq -r '.status')
if [ "$TOOL_OUTPUT_GEN_STATUS" != "completed" ]; then
  echo "ERROR: Expected tool_output generation status 'completed', got '$TOOL_OUTPUT_GEN_STATUS'" >&2
  exit 1
fi

TOOL_OUTPUT_GEN_CONTENT=$(printf '%s\n' "$TOOL_OUTPUT_GEN_RESP" | jq -r '.output.content // empty')
if [ -z "$TOOL_OUTPUT_GEN_CONTENT" ]; then
  echo "ERROR: tool_output generation returned empty output content" >&2
  exit 1
fi

if printf '%s\n' "$TOOL_OUTPUT_GEN_CONTENT" | grep -Fq 'smoke-test-project'; then
  echo "tool_output message content surfaced selected project name: OK"
else
  echo "WARNING: tool_output generation output did not include exact project name (LLM response varies), but generation completed with non-empty output." >&2
  echo "tool_output output: $TOOL_OUTPUT_GEN_CONTENT" >&2
fi

# 22f. Cleanup — delete project-detail tool
echo "--- Deleting project-detail tool ---"
$SOAT_CLI delete-tool --tool-id "$PROJECT_DETAIL_TOOL_ID"
echo "Project-detail tool deleted."

# 23. Generated agents are now delete-blocked by dependent generations/traces
echo "--- Verifying agent delete-block after generation ---"
expect_cli_error_status 409 delete-agent --agent-id "$AGENT_ID"
echo "Agent delete-block: OK (409 as expected)"

# 24. Cleanup — delete agent tool
echo "--- Deleting agent tool ---"
$SOAT_CLI delete-tool --tool-id "$TOOL_ID"
echo "Agent tool deleted."

# 25. Create an MCP agent tool pointing at the SOAT MCP server
echo "--- Creating MCP agent tool ---"
MCP_TOOL_RESP=$($SOAT_CLI create-tool \
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
  --instructions "You are a helpful assistant with access to SOAT tools via MCP. When asked to list agents, call the list-agents MCP tool exactly once and return a concise summary. Always use the tool." \
  --tool_ids "[\"$MCP_TOOL_ID\"]" \
  --max_steps 2)
MCP_AGENT_ID=$(echo "$MCP_AGENT_RESP" | jq -r '.id')
echo "MCP Agent id: $MCP_AGENT_ID"

# 27. Deterministic MCP check (direct protocol call, no LLM)
echo "--- Validating MCP endpoint (tools/call) ---"
MCP_DIRECT_RESP=$(curl -s -X POST "$SERVER_URL/mcp" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":27,"method":"tools/call","params":{"name":"list-agents","arguments":{}}}')

if ! printf '%s\n' "$MCP_DIRECT_RESP" | jq -e '.result.content[0].text' >/dev/null 2>&1; then
  echo "ERROR: MCP direct tools/call did not return expected content" >&2
  echo "$MCP_DIRECT_RESP" >&2
  exit 1
fi

MCP_DIRECT_TEXT=$(printf '%s\n' "$MCP_DIRECT_RESP" | jq -r '.result.content[0].text')
if ! echo "$MCP_DIRECT_TEXT" | grep -qi "mcp-agent-lister\|$MCP_AGENT_ID"; then
  echo "ERROR: MCP direct tools/call response did not include the created MCP agent" >&2
  echo "$MCP_DIRECT_TEXT" >&2
  exit 1
fi
echo "MCP direct tools/call: OK"

# 27a. OAuth discovery endpoints (required for Claude Connectors / MCP OAuth 2.1)
echo "--- Validating OAuth discovery endpoints ---"
OAUTH_AS_META=$(curl -sf "$SERVER_URL/.well-known/oauth-authorization-server")
if ! echo "$OAUTH_AS_META" | jq -e '.issuer' >/dev/null 2>&1; then
  echo "ERROR: /.well-known/oauth-authorization-server did not return expected metadata" >&2
  echo "$OAUTH_AS_META" >&2
  exit 1
fi
echo "OAuth authorization server metadata: OK"

OAUTH_PR_META=$(curl -sf "$SERVER_URL/.well-known/oauth-protected-resource")
if ! echo "$OAUTH_PR_META" | jq -e '.resource' >/dev/null 2>&1; then
  echo "ERROR: /.well-known/oauth-protected-resource did not return expected metadata" >&2
  echo "$OAUTH_PR_META" >&2
  exit 1
fi
echo "OAuth protected resource metadata: OK"

# 27b. MCP root alias (required for Claude Connectors — they POST to the resource URL, not /mcp)
echo "--- Validating MCP root alias ---"
MCP_ROOT_RESP=$(curl -s -X POST "$SERVER_URL/" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":"root-alias","method":"tools/list","params":{}}')
if ! printf '%s\n' "$MCP_ROOT_RESP" | jq -e '.result.tools' >/dev/null 2>&1; then
  echo "ERROR: MCP root alias (POST /) did not return tool list" >&2
  echo "$MCP_ROOT_RESP" >&2
  exit 1
fi
echo "MCP root alias: OK"

# 28. Ask the agent to list agents via MCP (LLM-driven, best effort)
echo "--- Running MCP agent generation ---"
# Bound this call to keep smoke runs deterministic when model/tool orchestration stalls.
set +e
MCP_GEN_RAW=$(timeout -k 5s 30s $SOAT_CLI create-agent-generation --agent-id "$MCP_AGENT_ID" \
  --messages '[{"role":"user","content":"List all agents. Use the list-agents tool exactly once."}]' 2>&1)
MCP_GEN_EXIT=$?
set -e
if [ "$MCP_GEN_EXIT" -ne 0 ]; then
  if [ "$MCP_GEN_EXIT" -eq 124 ]; then
    echo "WARNING: MCP generation timed out after 30s — skipping MCP output checks" >&2
    MCP_GEN_RESP=""
  else
    echo "WARNING: MCP generation command failed with exit code $MCP_GEN_EXIT — skipping MCP output checks" >&2
    echo "$MCP_GEN_RAW" >&2
    MCP_GEN_RESP=""
  fi
fi
if [ -n "$MCP_GEN_RESP" ] || [ "$MCP_GEN_EXIT" -eq 0 ]; then
  MCP_GEN_RESP=$(printf '%s\n' "$MCP_GEN_RAW" | sanitize_json)
  if ! printf '%s\n' "$MCP_GEN_RESP" | jq -e '.' >/dev/null 2>&1; then
    echo "WARNING: MCP generation returned non-JSON output — skipping MCP output checks" >&2
    MCP_GEN_RESP=""
  fi
fi

if [ -n "$MCP_GEN_RESP" ]; then
  echo "MCP Generation response:"
  printf '%s\n' "$MCP_GEN_RESP" | jq .

  MCP_GEN_STATUS=$(printf '%s\n' "$MCP_GEN_RESP" | jq -r '.status')
  if [ "$MCP_GEN_STATUS" != "completed" ]; then
    echo "WARNING: MCP generation status is '$MCP_GEN_STATUS' (expected 'completed') — continuing" >&2
  else
    echo "MCP generation completed."

    # 29. Verify the agent output mentions agent data (the mcp-agent-lister we just created)
    MCP_GEN_CONTENT=$(printf '%s\n' "$MCP_GEN_RESP" | jq -r '.output.content // empty')
    echo "MCP Agent output: $MCP_GEN_CONTENT"
    if echo "$MCP_GEN_CONTENT" | grep -qi "mcp-agent-lister\|agent"; then
      echo "MCP Agent output mentions agents: OK"
    else
      echo "WARNING: MCP Agent output may not contain exact agent names (LLM response varies), but generation completed successfully."
    fi
  fi
fi

# 30. MCP-generated agent is also delete-blocked by dependent generations/traces
echo "--- Verifying MCP agent delete-block after generation ---"
expect_cli_error_status 409 delete-agent --agent-id "$MCP_AGENT_ID"
echo "MCP agent delete-block: OK (409 as expected)"

# 31. Cleanup — delete MCP agent tool
echo "--- Deleting MCP agent tool ---"
$SOAT_CLI delete-tool --tool-id "$MCP_TOOL_ID"
echo "MCP Agent tool deleted."

# ── Client Tool Tests ────────────────────────────────────────────────────────

# 31. Create a client-type agent tool
echo "--- Creating client agent tool ---"
CLIENT_TOOL_RESP=$($SOAT_CLI create-tool \
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
# Traces and generations carry the model's output content, which can contain
# raw control characters; strip them so strict jq can parse the responses.
TRACES_RESP=$($SOAT_CLI list-traces --project_id "$PROJECT_PUBLIC_ID" | sanitize_json)
if ! printf '%s\n' "$TRACES_RESP" | jq -e '((type == "array") or (type == "object" and (.data | type == "array")))' >/dev/null 2>&1; then
  echo "ERROR: list-traces did not return a JSON array/data array" >&2
  echo "$TRACES_RESP" >&2
  exit 1
fi
echo "Trace listing endpoint: OK"

if [ -n "$CLIENT_TRACE_ID" ] && [ "$CLIENT_TRACE_ID" != "null" ]; then
  TRACE_GET_RESP=$($SOAT_CLI get-trace --trace-id "$CLIENT_TRACE_ID" | sanitize_json)
  TRACE_RETURNED_ID=$(printf '%s\n' "$TRACE_GET_RESP" | jq -r '.id // empty')
  if [ "$TRACE_RETURNED_ID" != "$CLIENT_TRACE_ID" ]; then
    echo "ERROR: Trace endpoint returned mismatched id '$TRACE_RETURNED_ID' for '$CLIENT_TRACE_ID'" >&2
    echo "$TRACE_GET_RESP" >&2
    exit 1
  fi
  echo "Trace retrieval endpoint: OK"

  TRACE_TREE_RESP=$($SOAT_CLI get-trace-tree --trace-id "$CLIENT_TRACE_ID" | sanitize_json)
  TRACE_TREE_ID=$(printf '%s\n' "$TRACE_TREE_RESP" | jq -r '.id // empty')
  if [ "$TRACE_TREE_ID" != "$CLIENT_TRACE_ID" ]; then
    echo "ERROR: Trace tree endpoint returned mismatched id '$TRACE_TREE_ID' for '$CLIENT_TRACE_ID'" >&2
    echo "$TRACE_TREE_RESP" >&2
    exit 1
  fi
  echo "Trace tree endpoint: OK"

  TRACE_GENS_RESP=$($SOAT_CLI list-generations --trace-id "$CLIENT_TRACE_ID" | sanitize_json)
  FIRST_GENERATION_ID=$(printf '%s\n' "$TRACE_GENS_RESP" | jq -r '.data[0].id // empty')
  if [ -z "$FIRST_GENERATION_ID" ]; then
    echo "ERROR: list-generations returned no generations for trace '$CLIENT_TRACE_ID'" >&2
    echo "$TRACE_GENS_RESP" >&2
    exit 1
  fi
  echo "List generations (by trace) endpoint: OK"

  GENERATION_GET_RESP=$($SOAT_CLI get-generation --generation-id "$FIRST_GENERATION_ID" | sanitize_json)
  GENERATION_RETURNED_ID=$(printf '%s\n' "$GENERATION_GET_RESP" | jq -r '.id // empty')
  GENERATION_RETURNED_STATUS=$(printf '%s\n' "$GENERATION_GET_RESP" | jq -r '.status // empty')
  if [ "$GENERATION_RETURNED_ID" != "$FIRST_GENERATION_ID" ] || [ -z "$GENERATION_RETURNED_STATUS" ]; then
    echo "ERROR: get-generation returned mismatched id or missing status for '$FIRST_GENERATION_ID'" >&2
    echo "$GENERATION_GET_RESP" >&2
    exit 1
  fi
  echo "Generation retrieval endpoint: OK (status: $GENERATION_RETURNED_STATUS)"
else
  echo "ERROR: Generation response did not include trace_id" >&2
  exit 1
fi

# 35. Client-tool agent is delete-blocked after generation persists trace data
echo "--- Verifying client-tool agent delete-block after generation ---"
expect_cli_error_status 409 delete-agent --agent-id "$CLIENT_AGENT_ID"
echo "Client-tool agent delete-block: OK (409 as expected)"

# 36. Cleanup — delete client agent tool
echo "--- Deleting client agent tool ---"
$SOAT_CLI delete-tool --tool-id "$CLIENT_TOOL_ID"
echo "Client agent tool deleted."

# ── SOAT Tool Tests ─────────────────────────────────────────────────────────

# 37. Create a SOAT agent tool exposing list-projects action
echo "--- Creating SOAT agent tool ---"
SOAT_TOOL_RESP=$($SOAT_CLI create-tool \
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

# Regression check for issue #371: mid-turn soat-type tool calls used to fail
# with "Unknown field(s): parent_trace_id, root_trace_id, max_call_depth"
# because those fields were injected into every soat action's request body,
# even ones whose schema (like list-projects) doesn't declare them.
if echo "$SOAT_GEN_CONTENT" | grep -qi "VALIDATION_FAILED\|Unknown field"; then
  echo "ERROR: SOAT agent output leaked a tool validation error (regression of #371)" >&2
  exit 1
fi
echo "SOAT agent mid-turn tool call did not leak a validation error: OK"

# 41. SOAT agent is delete-blocked after generation persists trace data
echo "--- Verifying SOAT agent delete-block after generation ---"
expect_cli_error_status 409 delete-agent --agent-id "$SOAT_AGENT_ID"
echo "SOAT agent delete-block: OK (409 as expected)"

# 42. Cleanup — delete SOAT agent tool
echo "--- Deleting SOAT agent tool ---"
$SOAT_CLI delete-tool --tool-id "$SOAT_TOOL_ID"
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

# 45. Create an agent-backed actor via POST /actors with agent_id
echo "--- Creating agent-backed actor via /actors (agent_id) ---"
AGENT_ACTOR_RESP=$($SOAT_CLI create-actor --agent-id "$CONVO_GEN_AGENT_ID" \
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
  --conversation-id "$NAMED_CONVO_ID" --message "Hello, how are you?" --role user --actor_id "$USER_ACTOR_ID")
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
  CONVO_GEN_RESP=$($SOAT_CLI generate-conversation-message --conversation-id "$NAMED_CONVO_ID" --agent_id "$CONVO_GEN_AGENT_ID" | sanitize_json)
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
# Persisted messages echo the model's output, which can contain raw control
# characters; strip them so jq (strict since 1.7) can parse the response.
CONVO_MSGS_RESP=$($SOAT_CLI list-conversation-messages --conversation-id "$NAMED_CONVO_ID" | sanitize_json)
MSG_COUNT=$(echo "$CONVO_MSGS_RESP" | jq 'if type=="array" then length else (.data | length) end')
if [ "$MSG_COUNT" -lt "2" ]; then
  echo "ERROR: Expected at least 2 conversation messages (user + generated), got $MSG_COUNT" >&2
  exit 1
fi
echo "Conversation messages count: $MSG_COUNT (OK)"

# 49. Verify GET /actors?conversation_id= lists the user actor
echo "--- Verifying GET /actors?conversation_id= ---"
CONVO_ACTORS_RESP=$($SOAT_CLI list-actors --conversation-id "$NAMED_CONVO_ID")
CONVO_ACTORS_COUNT=$(echo "$CONVO_ACTORS_RESP" | jq 'if type=="array" then length else (.data | length) end')
if [ "$CONVO_ACTORS_COUNT" -lt "1" ]; then
  echo "ERROR: Expected at least 1 actor in conversation, got $CONVO_ACTORS_COUNT" >&2
  exit 1
fi
echo "GET /conversations/:id/actors count: $CONVO_ACTORS_COUNT (OK)"

# 50. Verify delete-block: user actor with messages cannot be deleted (409)
echo "--- Verifying actor delete-block (409 when actor has messages) ---"
expect_cli_error_status 409 delete-actor --actor-id "$USER_ACTOR_ID"
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

# 54. Conversation-generate agent is delete-blocked after generation persists
echo "--- Verifying conversation-generate agent delete-block ---"
expect_cli_error_status 409 delete-agent --agent-id "$CONVO_GEN_AGENT_ID"
echo "Conversation-generate agent delete-block: OK (409 as expected)"

# 54b. force=true deletes the agent along with its dependent generations/traces
echo "--- Verifying agent force-delete ---"
$SOAT_CLI delete-agent --agent-id "$CONVO_GEN_AGENT_ID" --force true
expect_cli_error_status 404 get-agent --agent-id "$CONVO_GEN_AGENT_ID"
echo "Agent force-delete: OK (agent and dependents removed)"
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
WEBHOOK_GET_RESP=$($SOAT_CLI get-webhook --webhook-id "$WEBHOOK_ID")
if ! printf '%s\n' "$WEBHOOK_GET_RESP" | jq -e --arg id "$WEBHOOK_ID" '.id == $id' >/dev/null 2>&1; then
  echo "ERROR: GET webhook returned unexpected payload" >&2
  echo "$WEBHOOK_GET_RESP" >&2
  exit 1
fi
echo "Webhook retrieved."

# Update webhook
echo "--- Updating webhook ---"
WEBHOOK_UPDATE_RESP=$($SOAT_CLI update-webhook --webhook-id "$WEBHOOK_ID" \
  --name "Updated Smoke Webhook" --active false)
if ! printf '%s\n' "$WEBHOOK_UPDATE_RESP" | jq -e '.active == false' >/dev/null 2>&1; then
  echo "ERROR: UPDATE webhook did not return active=false" >&2
  echo "$WEBHOOK_UPDATE_RESP" >&2
  exit 1
fi
echo "Webhook updated."

# Rotate secret
echo "--- Rotating webhook secret ---"
$SOAT_CLI rotate-webhook-secret --webhook-id "$WEBHOOK_ID" >/dev/null
echo "Webhook secret rotated."

# List deliveries
echo "--- Listing webhook deliveries ---"
WEBHOOK_DELIVERIES_RESP=$($SOAT_CLI list-webhook-deliveries --webhook-id "$WEBHOOK_ID")
if ! printf '%s\n' "$WEBHOOK_DELIVERIES_RESP" | jq -e '((type == "array") or (type == "object" and (.data | type == "array")))' >/dev/null 2>&1; then
  echo "ERROR: LIST webhook deliveries did not return an array" >&2
  echo "$WEBHOOK_DELIVERIES_RESP" >&2
  exit 1
fi
echo "Webhook deliveries listed."

# Delete webhook
echo "--- Deleting webhook ---"
$SOAT_CLI delete-webhook --webhook-id "$WEBHOOK_ID"
echo "Webhook deleted."
echo "Webhooks coverage: OK"

# ── Triggers ──────────────────────────────────────────────────────────────

echo ""
echo "=== Triggers ==="

# A dedicated orchestration target: a single transform node runs synchronously,
# so a manual fire reaches a terminal state without any LLM/external boundary.
echo "--- Creating trigger target orchestration ---"
TRIGGER_ORCH_RESP=$($SOAT_CLI create-orchestration \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-trigger-orchestration" \
  --nodes '[{"id":"seed","type":"transform","expression":{"var":"cycle"},"output_mapping":{"result":"state.cycle"}}]' \
  --edges '[]')
TRIGGER_ORCH_ID=$(printf '%s\n' "$TRIGGER_ORCH_RESP" | jq -r '.id')
if [ -z "$TRIGGER_ORCH_ID" ] || [ "$TRIGGER_ORCH_ID" = "null" ]; then
  echo "ERROR: Failed to create trigger target orchestration" >&2
  printf '%s\n' "$TRIGGER_ORCH_RESP" >&2
  exit 1
fi
echo "Trigger target orchestration: $TRIGGER_ORCH_ID"

# Create a manual trigger bound to the orchestration
echo "--- Creating manual trigger ---"
TRIGGER_CREATE_RESP=$($SOAT_CLI create-trigger \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-manual-trigger" \
  --type manual \
  --target-type orchestration \
  --target-id "$TRIGGER_ORCH_ID" \
  --input '{"cycle":"daily"}')
TRIGGER_ID=$(printf '%s\n' "$TRIGGER_CREATE_RESP" | jq -r '.id')
if [ -z "$TRIGGER_ID" ] || [ "$TRIGGER_ID" = "null" ]; then
  echo "ERROR: Failed to create trigger" >&2
  printf '%s\n' "$TRIGGER_CREATE_RESP" >&2
  exit 1
fi
echo "Trigger created: $TRIGGER_ID"

# List triggers
echo "--- Listing triggers ---"
TRIGGER_LIST_RESP=$($SOAT_CLI list-triggers --project-id "$PROJECT_PUBLIC_ID")
if ! printf '%s\n' "$TRIGGER_LIST_RESP" | jq -e --arg id "$TRIGGER_ID" 'map(.id) | index($id) != null' >/dev/null 2>&1; then
  echo "ERROR: list-triggers did not include the created trigger" >&2
  printf '%s\n' "$TRIGGER_LIST_RESP" >&2
  exit 1
fi
echo "Triggers listed."

# Get trigger
echo "--- Getting trigger ---"
TRIGGER_GET_RESP=$($SOAT_CLI get-trigger --trigger-id "$TRIGGER_ID")
if ! printf '%s\n' "$TRIGGER_GET_RESP" | jq -e --arg id "$TRIGGER_ID" '.id == $id' >/dev/null 2>&1; then
  echo "ERROR: get-trigger returned an unexpected payload" >&2
  printf '%s\n' "$TRIGGER_GET_RESP" >&2
  exit 1
fi
echo "Trigger retrieved."

# Update trigger
echo "--- Updating trigger ---"
TRIGGER_UPDATE_RESP=$($SOAT_CLI update-trigger --trigger-id "$TRIGGER_ID" \
  --name "smoke-manual-trigger-updated")
if ! printf '%s\n' "$TRIGGER_UPDATE_RESP" | jq -e '.name == "smoke-manual-trigger-updated"' >/dev/null 2>&1; then
  echo "ERROR: update-trigger did not persist the new name" >&2
  printf '%s\n' "$TRIGGER_UPDATE_RESP" >&2
  exit 1
fi
echo "Trigger updated."

# Fire trigger (synchronous; the orchestration target runs to a terminal state)
echo "--- Firing trigger ---"
TRIGGER_FIRE_RESP=$($SOAT_CLI fire-trigger --trigger-id "$TRIGGER_ID" \
  --input '{"cycle":"smoke"}')
FIRING_ID=$(printf '%s\n' "$TRIGGER_FIRE_RESP" | jq -r '.id')
if [ -z "$FIRING_ID" ] || [ "$FIRING_ID" = "null" ]; then
  echo "ERROR: fire-trigger did not return a firing record" >&2
  printf '%s\n' "$TRIGGER_FIRE_RESP" >&2
  exit 1
fi
FIRING_STATUS=$(printf '%s\n' "$TRIGGER_FIRE_RESP" | jq -r '.status')
if [ "$FIRING_STATUS" != "succeeded" ] && [ "$FIRING_STATUS" != "failed" ]; then
  echo "ERROR: firing did not reach a terminal status (got '$FIRING_STATUS')" >&2
  printf '%s\n' "$TRIGGER_FIRE_RESP" >&2
  exit 1
fi
echo "Trigger fired: $FIRING_ID ($FIRING_STATUS)"

# List firings
echo "--- Listing trigger firings ---"
FIRINGS_RESP=$($SOAT_CLI list-trigger-firings --trigger-id "$TRIGGER_ID")
if ! printf '%s\n' "$FIRINGS_RESP" | jq -e '((type == "array") or (type == "object" and (.data | type == "array")))' >/dev/null 2>&1; then
  echo "ERROR: list-trigger-firings did not return firings" >&2
  printf '%s\n' "$FIRINGS_RESP" >&2
  exit 1
fi
echo "Trigger firings listed."

# Get firing
echo "--- Getting trigger firing ---"
FIRING_GET_RESP=$($SOAT_CLI get-trigger-firing --firing-id "$FIRING_ID")
if ! printf '%s\n' "$FIRING_GET_RESP" | jq -e --arg id "$FIRING_ID" '.id == $id' >/dev/null 2>&1; then
  echo "ERROR: get-trigger-firing returned an unexpected payload" >&2
  printf '%s\n' "$FIRING_GET_RESP" >&2
  exit 1
fi
echo "Trigger firing retrieved."

# Webhook trigger: secret get + rotate (webhook triggers get a signing secret)
echo "--- Creating webhook trigger ---"
WEBHOOK_TRIGGER_RESP=$($SOAT_CLI create-trigger \
  --project-id "$PROJECT_PUBLIC_ID" \
  --name "smoke-webhook-trigger" \
  --type webhook \
  --target-type orchestration \
  --target-id "$TRIGGER_ORCH_ID")
WEBHOOK_TRIGGER_ID=$(printf '%s\n' "$WEBHOOK_TRIGGER_RESP" | jq -r '.id')
WEBHOOK_TRIGGER_SECRET=$(printf '%s\n' "$WEBHOOK_TRIGGER_RESP" | jq -r '.secret')
if [ -z "$WEBHOOK_TRIGGER_ID" ] || [ "$WEBHOOK_TRIGGER_ID" = "null" ]; then
  echo "ERROR: Failed to create webhook trigger" >&2
  printf '%s\n' "$WEBHOOK_TRIGGER_RESP" >&2
  exit 1
fi
if [ -z "$WEBHOOK_TRIGGER_SECRET" ] || [ "$WEBHOOK_TRIGGER_SECRET" = "null" ]; then
  echo "ERROR: webhook trigger create did not return a secret" >&2
  printf '%s\n' "$WEBHOOK_TRIGGER_RESP" >&2
  exit 1
fi
echo "Webhook trigger created: $WEBHOOK_TRIGGER_ID"

echo "--- Getting webhook trigger secret ---"
TRIGGER_SECRET_RESP=$($SOAT_CLI get-trigger-secret --trigger-id "$WEBHOOK_TRIGGER_ID")
if ! printf '%s\n' "$TRIGGER_SECRET_RESP" | jq -e '.secret | type == "string"' >/dev/null 2>&1; then
  echo "ERROR: get-trigger-secret did not return a secret" >&2
  printf '%s\n' "$TRIGGER_SECRET_RESP" >&2
  exit 1
fi
echo "Webhook trigger secret retrieved."

echo "--- Rotating webhook trigger secret ---"
TRIGGER_ROTATE_RESP=$($SOAT_CLI rotate-trigger-secret --trigger-id "$WEBHOOK_TRIGGER_ID")
ROTATED_SECRET=$(printf '%s\n' "$TRIGGER_ROTATE_RESP" | jq -r '.secret')
if [ -z "$ROTATED_SECRET" ] || [ "$ROTATED_SECRET" = "null" ]; then
  echo "ERROR: rotate-trigger-secret did not return a new secret" >&2
  printf '%s\n' "$TRIGGER_ROTATE_RESP" >&2
  exit 1
fi
if [ "$ROTATED_SECRET" = "$WEBHOOK_TRIGGER_SECRET" ]; then
  echo "ERROR: rotate-trigger-secret returned the same secret" >&2
  exit 1
fi
echo "Webhook trigger secret rotated."

# Guard: only webhook triggers have a secret
echo "--- Verifying a manual trigger has no secret ---"
expect_cli_error_status 400 get-trigger-secret --trigger-id "$TRIGGER_ID"
echo "Manual trigger secret correctly rejected."

# Delete triggers
echo "--- Deleting triggers ---"
$SOAT_CLI delete-trigger --trigger-id "$WEBHOOK_TRIGGER_ID"
$SOAT_CLI delete-trigger --trigger-id "$TRIGGER_ID"
echo "Triggers deleted."
echo "Triggers coverage: OK"

# ── Agent Formations ──────────────────────────────────────────────────────────

echo ""
echo "=== Agent Formations ==="

# Validate template
echo "--- Validating formation template ---"
VALIDATE_RESP=$($SOAT_CLI validate-formation \
  --template '{"resources":{"myMemory":{"type":"memory","properties":{"name":"Smoke Test Memory"}}},"outputs":{"memoryId":{"ref":"myMemory"}}}')
if ! printf '%s\n' "$VALIDATE_RESP" | jq -e '.valid == true' >/dev/null 2>&1; then
  echo "ERROR: validate-formation did not return valid=true" >&2
  echo "$VALIDATE_RESP" >&2
  exit 1
fi
echo "Formation template validated."

# Validate template with a --parameter override (regression: issue #319)
echo "--- Validating formation template with a --parameter override ---"
VALIDATE_PARAM_RESP=$($SOAT_CLI validate-formation \
  --template '{"parameters":{"MemoryName":{"type":"string"}},"resources":{"myMemory":{"type":"memory","properties":{"name":{"param":"MemoryName"}}}}}' \
  --parameter MemoryName=SmokeParamMemory)
if ! printf '%s\n' "$VALIDATE_PARAM_RESP" | jq -e '.valid == true' >/dev/null 2>&1; then
  echo "ERROR: validate-formation with --parameter did not return valid=true" >&2
  echo "$VALIDATE_PARAM_RESP" >&2
  exit 1
fi
echo "Formation template with parameter validated."

# Plan
echo "--- Planning formation ---"
PLAN_RESP=$($SOAT_CLI plan-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --template '{"resources":{"myMemory":{"type":"memory","properties":{"name":"Smoke Test Memory"}}},"outputs":{"memoryId":{"ref":"myMemory"}}}')
if ! printf '%s\n' "$PLAN_RESP" | jq -e '((.changes // .actions) | type == "array")' >/dev/null 2>&1; then
  echo "ERROR: plan-formation did not return changes/actions array" >&2
  echo "$PLAN_RESP" >&2
  exit 1
fi
echo "Formation planned."

# Create
echo "--- Creating formation ---"
FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-formation" \
  --template '{"resources":{"myMemory":{"type":"memory","properties":{"name":"Smoke Formation Memory"}}},"outputs":{"memoryId":{"ref":"myMemory"}}}')
FORMATION_ID=$(printf '%s\n' "$FORMATION_RESP" | jq -r '.id')
if [ -z "$FORMATION_ID" ] || [ "$FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation did not return an id" >&2
  echo "$FORMATION_RESP" >&2
  exit 1
fi
echo "Formation created: $FORMATION_ID"

# List
echo "--- Listing formations ---"
FORMATION_LIST_RESP=$($SOAT_CLI list-formations --project_id "$PROJECT_PUBLIC_ID")
if ! printf '%s\n' "$FORMATION_LIST_RESP" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: list-formations did not return an array" >&2
  echo "$FORMATION_LIST_RESP" >&2
  exit 1
fi
echo "Formations listed."

# Get
echo "--- Getting formation ---"
FORMATION_GET_RESP=$($SOAT_CLI get-formation --formation_id "$FORMATION_ID")
if ! printf '%s\n' "$FORMATION_GET_RESP" | jq -e --arg id "$FORMATION_ID" '.id == $id' >/dev/null 2>&1; then
  echo "ERROR: get-formation returned unexpected payload" >&2
  echo "$FORMATION_GET_RESP" >&2
  exit 1
fi
echo "Formation retrieved."

# List events
echo "--- Listing formation events ---"
FORMATION_EVENTS_RESP=$($SOAT_CLI list-formation-events --formation_id "$FORMATION_ID")
if ! printf '%s\n' "$FORMATION_EVENTS_RESP" | jq -e 'type == "array"' >/dev/null 2>&1; then
  echo "ERROR: list-formation-events did not return an array" >&2
  echo "$FORMATION_EVENTS_RESP" >&2
  exit 1
fi
echo "Formation events listed."

# Update
echo "--- Updating formation ---"
FORMATION_UPDATE_RESP=$($SOAT_CLI update-formation \
  --formation_id "$FORMATION_ID" \
  --template '{"resources":{"myMemory":{"type":"memory","properties":{"name":"Smoke Formation Memory Updated"}}},"outputs":{"memoryId":{"ref":"myMemory"}}}')
if ! printf '%s\n' "$FORMATION_UPDATE_RESP" | jq -e --arg id "$FORMATION_ID" '.id == $id' >/dev/null 2>&1; then
  echo "ERROR: update-formation returned unexpected payload" >&2
  echo "$FORMATION_UPDATE_RESP" >&2
  exit 1
fi
echo "Formation updated."

# Update reusing a secret parameter's previous value (use_previous_value)
echo "--- Creating formation with a use_previous_value secret parameter ---"
KEEP_TEMPLATE='{"parameters":{"XaiApiKey":{"type":"string","no_echo":true,"use_previous_value":true}},"resources":{"keepSecret":{"type":"secret","properties":{"name":"smoke-keep-secret","value":{"param":"XaiApiKey"}}},"keepMemory":{"type":"memory","properties":{"name":"keep-mem-original"}}}}'
KEEP_FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-keep-formation" \
  --template "$KEEP_TEMPLATE" \
  --parameter XaiApiKey=sk-smoke-original)
KEEP_FORMATION_ID=$(printf '%s\n' "$KEEP_FORMATION_RESP" | jq -r '.id')
if [ -z "$KEEP_FORMATION_ID" ] || [ "$KEEP_FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation (keep) did not return an id" >&2
  echo "$KEEP_FORMATION_RESP" >&2
  exit 1
fi
echo "Keep formation created: $KEEP_FORMATION_ID"

echo "--- Updating formation while reusing the stored secret value ---"
KEEP_UPDATE_TEMPLATE='{"parameters":{"XaiApiKey":{"type":"string","no_echo":true,"use_previous_value":true}},"resources":{"keepSecret":{"type":"secret","properties":{"name":"smoke-keep-secret","value":{"param":"XaiApiKey"}}},"keepMemory":{"type":"memory","properties":{"name":"keep-mem-updated"}}}}'
# XaiApiKey is intentionally NOT passed — use_previous_value reuses the stored value.
KEEP_UPDATE_RESP=$($SOAT_CLI update-formation \
  --formation_id "$KEEP_FORMATION_ID" \
  --template "$KEEP_UPDATE_TEMPLATE")
if ! printf '%s\n' "$KEEP_UPDATE_RESP" | jq -e '.status == "active"' >/dev/null 2>&1; then
  echo "ERROR: update-formation with use_previous_value did not return active status" >&2
  echo "$KEEP_UPDATE_RESP" >&2
  exit 1
fi
echo "Formation updated reusing the stored secret value."

$SOAT_CLI delete-formation --formation_id "$KEEP_FORMATION_ID"
echo "Keep formation deleted."

# Delete
echo "--- Deleting formation ---"
$SOAT_CLI delete-formation --formation_id "$FORMATION_ID"
echo "Formation deleted."
echo "Agent Formations coverage: OK"

# ── Formations — new resource types ──────────────────────────────────────────

echo ""
echo "=== Formations — new resource types ==="

# chat formation
echo "--- Formation: chat resource type ---"
CHAT_FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-formation-chat" \
  --template "{\"resources\":{\"myChat\":{\"type\":\"chat\",\"properties\":{\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Smoke Chat\"}}},\"outputs\":{\"chatId\":{\"ref\":\"myChat\"}}}")
CHAT_FORMATION_ID=$(printf '%s\n' "$CHAT_FORMATION_RESP" | jq -r '.id')
if [ -z "$CHAT_FORMATION_ID" ] || [ "$CHAT_FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation (chat) did not return an id" >&2
  printf '%s\n' "$CHAT_FORMATION_RESP" >&2
  exit 1
fi
echo "Chat formation created: $CHAT_FORMATION_ID"
$SOAT_CLI delete-formation --formation_id "$CHAT_FORMATION_ID"
echo "Chat formation deleted."

# conversation formation
echo "--- Formation: conversation resource type ---"
CONVO_FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-formation-conversation" \
  --template '{"resources":{"myConvo":{"type":"conversation","properties":{"name":"Smoke Conversation"}}},"outputs":{"convoId":{"ref":"myConvo"}}}')
CONVO_FORMATION_ID=$(printf '%s\n' "$CONVO_FORMATION_RESP" | jq -r '.id')
if [ -z "$CONVO_FORMATION_ID" ] || [ "$CONVO_FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation (conversation) did not return an id" >&2
  printf '%s\n' "$CONVO_FORMATION_RESP" >&2
  exit 1
fi
echo "Conversation formation created: $CONVO_FORMATION_ID"
$SOAT_CLI delete-formation --formation_id "$CONVO_FORMATION_ID"
echo "Conversation formation deleted."

# file formation
echo "--- Formation: file resource type ---"
FILE_FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-formation-file" \
  --template '{"resources":{"myFile":{"type":"file","properties":{"prefix":"/smoke","filename":"formation-file.txt"}}},"outputs":{"fileId":{"ref":"myFile"}}}')
FILE_FORMATION_ID=$(printf '%s\n' "$FILE_FORMATION_RESP" | jq -r '.id')
if [ -z "$FILE_FORMATION_ID" ] || [ "$FILE_FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation (file) did not return an id" >&2
  printf '%s\n' "$FILE_FORMATION_RESP" >&2
  exit 1
fi
echo "File formation created: $FILE_FORMATION_ID"
$SOAT_CLI delete-formation --formation_id "$FILE_FORMATION_ID"
echo "File formation deleted."

# policy formation
echo "--- Formation: policy resource type ---"
POLICY_FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-formation-policy" \
  --template '{"resources":{"myPolicy":{"type":"policy","properties":{"name":"smoke-formation-policy","document":{"statement":[{"effect":"Allow","action":["files:GetFile"]}]}}}},"outputs":{"policyId":{"ref":"myPolicy"}}}')
POLICY_FORMATION_ID=$(printf '%s\n' "$POLICY_FORMATION_RESP" | jq -r '.id')
if [ -z "$POLICY_FORMATION_ID" ] || [ "$POLICY_FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation (policy) did not return an id" >&2
  printf '%s\n' "$POLICY_FORMATION_RESP" >&2
  exit 1
fi
echo "Policy formation created: $POLICY_FORMATION_ID"
$SOAT_CLI delete-formation --formation_id "$POLICY_FORMATION_ID"
echo "Policy formation deleted."

# secret formation — includes a tool referencing the formation-created secret
# through a sub expression, which resolves to a {{secret:sec_...}} token.
echo "--- Formation: secret resource type ---"
SECRET_FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-formation-secret" \
  --template '{"resources":{"mySecret":{"type":"secret","properties":{"name":"smoke-formation-secret","value":"smoke-secret-value"}},"myTool":{"type":"tool","properties":{"name":"smoke-formation-secret-ref-tool","type":"http","execute":{"url":"https://api.example.com/convert","method":"POST","headers":{"Authorization":{"sub":"Bearer {{secret:${mySecret}}}"}}}}}},"outputs":{"secretId":{"ref":"mySecret"}}}')
SECRET_FORMATION_ID=$(printf '%s\n' "$SECRET_FORMATION_RESP" | jq -r '.id')
if [ -z "$SECRET_FORMATION_ID" ] || [ "$SECRET_FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation (secret) did not return an id" >&2
  printf '%s\n' "$SECRET_FORMATION_RESP" >&2
  exit 1
fi
echo "Secret formation created: $SECRET_FORMATION_ID"

FORMATION_SECRET_PHYSICAL_ID=$(printf '%s\n' "$SECRET_FORMATION_RESP" | jq -r '.resources[] | select(.logical_id == "mySecret") | .physical_resource_id')
FORMATION_TOOL_PHYSICAL_ID=$(printf '%s\n' "$SECRET_FORMATION_RESP" | jq -r '.resources[] | select(.logical_id == "myTool") | .physical_resource_id')
FORMATION_TOOL_GET=$($SOAT_CLI get-tool --tool-id "$FORMATION_TOOL_PHYSICAL_ID")
FORMATION_TOOL_AUTH=$(printf '%s\n' "$FORMATION_TOOL_GET" | jq -r '.execute.headers.Authorization')
if [ "$FORMATION_TOOL_AUTH" != "Bearer {{secret:$FORMATION_SECRET_PHYSICAL_ID}}" ]; then
  echo "ERROR: Expected formation tool header 'Bearer {{secret:$FORMATION_SECRET_PHYSICAL_ID}}', got '$FORMATION_TOOL_AUTH'" >&2
  printf '%s\n' "$FORMATION_TOOL_GET" >&2
  exit 1
fi
echo "Formation secret reference resolved into tool header: OK"

$SOAT_CLI delete-formation --formation_id "$SECRET_FORMATION_ID"
echo "Secret formation deleted."

# session formation
echo "--- Formation: session resource type ---"
SESSION_FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-formation-session" \
  --template "{\"resources\":{\"mySession\":{\"type\":\"session\",\"properties\":{\"agent_id\":\"$AGENT_ID\"}}},\"outputs\":{\"sessionId\":{\"ref\":\"mySession\"}}}")
SESSION_FORMATION_ID=$(printf '%s\n' "$SESSION_FORMATION_RESP" | jq -r '.id')
if [ -z "$SESSION_FORMATION_ID" ] || [ "$SESSION_FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation (session) did not return an id" >&2
  printf '%s\n' "$SESSION_FORMATION_RESP" >&2
  exit 1
fi
echo "Session formation created: $SESSION_FORMATION_ID"
$SOAT_CLI delete-formation --formation_id "$SESSION_FORMATION_ID"
echo "Session formation deleted."

# orchestration formation — an agent "squad": the formation creates an agent and
# an orchestration whose node references that agent via a ref, proving the ref is
# resolved to the physical agent id inside the orchestration's nodes.
echo "--- Formation: orchestration resource type (agent squad) ---"
SQUAD_TEMPLATE="{\"resources\":{\"squadAgent\":{\"type\":\"agent\",\"properties\":{\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Smoke Squad Agent\",\"instructions\":\"Summarize the input.\"}},\"squadFlow\":{\"type\":\"orchestration\",\"properties\":{\"name\":\"smoke-squad\",\"input_schema\":{\"type\":\"object\",\"properties\":{\"topic\":{\"type\":\"string\"}}},\"nodes\":[{\"id\":\"summarize\",\"type\":\"agent\",\"agent_id\":{\"ref\":\"squadAgent\"},\"input_mapping\":{\"prompt\":{\"var\":\"topic\"}},\"output_mapping\":{\"content\":\"state.summary\"}}],\"edges\":[]}}},\"outputs\":{\"orchestrationId\":{\"ref\":\"squadFlow\"}}}"
SQUAD_FORMATION_RESP=$($SOAT_CLI create-formation \
  --project_id "$PROJECT_PUBLIC_ID" \
  --name "smoke-formation-orchestration" \
  --template "$SQUAD_TEMPLATE")
SQUAD_FORMATION_ID=$(printf '%s\n' "$SQUAD_FORMATION_RESP" | jq -r '.id')
if [ -z "$SQUAD_FORMATION_ID" ] || [ "$SQUAD_FORMATION_ID" = "null" ]; then
  echo "ERROR: create-formation (orchestration) did not return an id" >&2
  printf '%s\n' "$SQUAD_FORMATION_RESP" >&2
  exit 1
fi
echo "Orchestration formation created: $SQUAD_FORMATION_ID"

SQUAD_AGENT_PHYSICAL_ID=$(printf '%s\n' "$SQUAD_FORMATION_RESP" | jq -r '.resources[] | select(.logical_id == "squadAgent") | .physical_resource_id')
SQUAD_ORCH_PHYSICAL_ID=$(printf '%s\n' "$SQUAD_FORMATION_RESP" | jq -r '.resources[] | select(.logical_id == "squadFlow") | .physical_resource_id')
if [ -z "$SQUAD_ORCH_PHYSICAL_ID" ] || [ "$SQUAD_ORCH_PHYSICAL_ID" = "null" ]; then
  echo "ERROR: formation did not create the orchestration resource" >&2
  printf '%s\n' "$SQUAD_FORMATION_RESP" >&2
  exit 1
fi

SQUAD_ORCH_GET=$($SOAT_CLI get-orchestration --orchestration-id "$SQUAD_ORCH_PHYSICAL_ID")
SQUAD_NODE_AGENT_ID=$(printf '%s\n' "$SQUAD_ORCH_GET" | jq -r '.nodes[0].agent_id')
if [ "$SQUAD_NODE_AGENT_ID" != "$SQUAD_AGENT_PHYSICAL_ID" ]; then
  echo "ERROR: expected orchestration node agent_id '$SQUAD_AGENT_PHYSICAL_ID', got '$SQUAD_NODE_AGENT_ID'" >&2
  printf '%s\n' "$SQUAD_ORCH_GET" >&2
  exit 1
fi
echo "Formation ref resolved into orchestration node agent_id: OK"

$SOAT_CLI delete-formation --formation_id "$SQUAD_FORMATION_ID"
echo "Orchestration formation deleted."

echo "Formations new resource types coverage: OK"

# single_session_per_actor
echo "--- single_session_per_actor enforcement ---"
SSA_ACTOR_RESP=$($SOAT_CLI create-actor \
  --project_id "$PROJECT_PUBLIC_ID" --name smoke-ssa-actor)
SSA_ACTOR_ID=$(printf '%s\n' "$SSA_ACTOR_RESP" | jq -r '.id')
if [ -z "$SSA_ACTOR_ID" ] || [ "$SSA_ACTOR_ID" = "null" ]; then
  echo "ERROR: Failed to create actor for single_session_per_actor test" >&2
  printf '%s\n' "$SSA_ACTOR_RESP" >&2
  exit 1
fi

SSA_AGENT_RESP=$($SOAT_CLI create-agent \
  --project_id "$PROJECT_PUBLIC_ID" \
  --ai_provider_id "$AI_PROVIDER_ID" \
  --name smoke-ssa-agent \
  --single_session_per_actor true)
SSA_AGENT_ID=$(printf '%s\n' "$SSA_AGENT_RESP" | jq -r '.id')
if [ -z "$SSA_AGENT_ID" ] || [ "$SSA_AGENT_ID" = "null" ]; then
  echo "ERROR: Failed to create single_session_per_actor agent" >&2
  printf '%s\n' "$SSA_AGENT_RESP" >&2
  exit 1
fi
echo "SSA agent created: $SSA_AGENT_ID"

SSA_SESSION_RESP=$($SOAT_CLI create-session \
  --agent_id "$SSA_AGENT_ID" \
  --actor_id "$SSA_ACTOR_ID")
SSA_SESSION_ID=$(printf '%s\n' "$SSA_SESSION_RESP" | jq -r '.id')
if [ -z "$SSA_SESSION_ID" ] || [ "$SSA_SESSION_ID" = "null" ]; then
  echo "ERROR: First session creation should succeed" >&2
  printf '%s\n' "$SSA_SESSION_RESP" >&2
  exit 1
fi
echo "First session created: $SSA_SESSION_ID"

expect_cli_error_status 409 create-session \
  --agent_id "$SSA_AGENT_ID" \
  --actor_id "$SSA_ACTOR_ID"
echo "Duplicate session correctly rejected with 409."

$SOAT_CLI delete-agent --agent-id "$SSA_AGENT_ID"
$SOAT_CLI delete-actor --actor-id "$SSA_ACTOR_ID"
echo "single_session_per_actor: OK"

# idempotency_key on add-session-message
echo "--- add-session-message idempotency_key deduplication ---"
IDEM_SESSION_RESP=$($SOAT_CLI create-session \
  --agent_id "$AGENT_ID")
IDEM_SESSION_ID=$(printf '%s\n' "$IDEM_SESSION_RESP" | jq -r '.id')
if [ -z "$IDEM_SESSION_ID" ] || [ "$IDEM_SESSION_ID" = "null" ]; then
  echo "ERROR: Failed to create session for idempotency test" >&2
  printf '%s\n' "$IDEM_SESSION_RESP" >&2
  exit 1
fi

IDEM_KEY="smoke-idem-key-$$"

IDEM_FIRST_RESP=$($SOAT_CLI add-session-message \
  --session_id "$IDEM_SESSION_ID" \
  --message "first message" \
  --idempotency_key "$IDEM_KEY")
IDEM_FIRST_CONTENT=$(printf '%s\n' "$IDEM_FIRST_RESP" | jq -r '.content')
if [ "$IDEM_FIRST_CONTENT" != "first message" ]; then
  echo "ERROR: first idempotency_key call did not return expected content" >&2
  printf '%s\n' "$IDEM_FIRST_RESP" >&2
  exit 1
fi
echo "First call with idempotency_key: OK"

IDEM_SECOND_RESP=$($SOAT_CLI add-session-message \
  --session_id "$IDEM_SESSION_ID" \
  --message "different message" \
  --idempotency_key "$IDEM_KEY")
IDEM_SECOND_CONTENT=$(printf '%s\n' "$IDEM_SECOND_RESP" | jq -r '.content')
if [ "$IDEM_SECOND_CONTENT" != "first message" ]; then
  echo "ERROR: duplicate idempotency_key call did not return original content" >&2
  printf '%s\n' "$IDEM_SECOND_RESP" >&2
  exit 1
fi
echo "Duplicate call with idempotency_key returns original message: OK"

echo "add-session-message idempotency_key: OK"

echo ""
echo "--- Project delete-block and force-delete ---"
DEL_PROJECT_RESP=$($SOAT_CLI create-project --name smoke-delete-project)
DEL_PROJECT_ID=$(echo "$DEL_PROJECT_RESP" | jq -r '.id')

DEL_AI_PROVIDER_RESP=$($SOAT_CLI create-ai-provider \
  --project_id "$DEL_PROJECT_ID" \
  --name smoke-delete-provider \
  --provider ollama \
  --default_model "qwen2.5:0.5b" \
  --base_url "http://ollama:11434")
DEL_AI_PROVIDER_ID=$(echo "$DEL_AI_PROVIDER_RESP" | jq -r '.id')

DEL_AGENT_RESP=$($SOAT_CLI create-agent \
  --project_id "$DEL_PROJECT_ID" \
  --ai_provider_id "$DEL_AI_PROVIDER_ID" \
  --name smoke-delete-agent)
DEL_AGENT_ID=$(echo "$DEL_AGENT_RESP" | jq -r '.id')

expect_cli_error_status 409 delete-project --project-id "$DEL_PROJECT_ID"
echo "Project delete-block: OK (409 PROJECT_HAS_DEPENDENTS as expected)"

$SOAT_CLI delete-project --project-id "$DEL_PROJECT_ID" --force true
expect_cli_error_status 404 get-project --project-id "$DEL_PROJECT_ID"
expect_cli_error_status 404 get-agent --agent-id "$DEL_AGENT_ID"
expect_cli_error_status 404 get-ai-provider --ai-provider-id "$DEL_AI_PROVIDER_ID"
echo "Project force-delete: OK (project and dependents removed)"

echo ""
echo "--- Smoke: GET /app returns HTML ---"
APP_HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/app")
if [ "$APP_HTTP_CODE" != "200" ]; then
  echo "ERROR: GET /app expected 200, got $APP_HTTP_CODE" >&2
  exit 1
fi
APP_CONTENT_TYPE=$(curl -s -D - -o /dev/null "$BASE_URL/app" | grep -i "^content-type:" | head -1)
case "$APP_CONTENT_TYPE" in
  *text/html*) ;;
  *) echo "ERROR: GET /app expected text/html content-type, got: $APP_CONTENT_TYPE" >&2; exit 1 ;;
esac
echo "GET /app: OK"

echo ""
echo "=== All smoke tests passed! ==="
