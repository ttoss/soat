#!/bin/sh
set -e

BASE_URL="${SERVER_URL:-http://localhost:50477}/api/v1"

echo "=== Smoke test started ==="

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
echo "Token: $(echo "$TOKEN" | cut -c1-20)..."

# 3. Create a project
echo "--- Creating project ---"
PROJECT_RESP=$(curl -sf -X POST "$BASE_URL/projects" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"name":"smoke-test-project"}')
PROJECT_PUBLIC_ID=$(echo "$PROJECT_RESP" | jq -r '.id')
echo "Project id: $PROJECT_PUBLIC_ID"

# 4. Upload a file via multipart form
echo "--- Uploading file ---"
echo "Hello, smoke test!" > /tmp/smoke.txt
UPLOAD_RESP=$(curl -sf -X POST "$BASE_URL/files/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/tmp/smoke.txt;type=text/plain" \
  -F "projectId=$PROJECT_PUBLIC_ID")
FILE_ID=$(echo "$UPLOAD_RESP" | jq -r '.id')
echo "File id: $FILE_ID"

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

# 10. Create first document
echo "--- Creating first document ---"
DOC1_RESP=$(curl -sf -X POST "$BASE_URL/documents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"projectId\":\"$PROJECT_PUBLIC_ID\",\"content\":\"The quick brown fox jumps over the lazy dog\",\"filename\":\"fox.txt\"}")
DOC1_ID=$(echo "$DOC1_RESP" | jq -r '.id')
echo "Document 1 id: $DOC1_ID"

# 11. Create second document
echo "--- Creating second document ---"
DOC2_RESP=$(curl -sf -X POST "$BASE_URL/documents" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"projectId\":\"$PROJECT_PUBLIC_ID\",\"content\":\"Machine learning models require large amounts of training data\",\"filename\":\"ml.txt\"}")
DOC2_ID=$(echo "$DOC2_RESP" | jq -r '.id')
echo "Document 2 id: $DOC2_ID"

# 12. Search documents
echo "--- Searching documents ---"
SEARCH_RESP=$(curl -sf -X POST "$BASE_URL/documents/search" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"projectId\":\"$PROJECT_PUBLIC_ID\",\"query\":\"fox animal jumping\",\"limit\":5}")
SEARCH_COUNT=$(echo "$SEARCH_RESP" | jq 'length')
if [ "$SEARCH_COUNT" -lt 1 ]; then
  echo "ERROR: Document search returned $SEARCH_COUNT results, expected at least 1" >&2
  exit 1
fi
echo "Search returned $SEARCH_COUNT result(s)."

# 13. Delete documents
echo "--- Deleting documents ---"
DELETE_DOC1=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/documents/$DOC1_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$DELETE_DOC1" != "204" ]; then
  echo "ERROR: DELETE document 1 returned $DELETE_DOC1, expected 204" >&2
  exit 1
fi
DELETE_DOC2=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/documents/$DOC2_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$DELETE_DOC2" != "204" ]; then
  echo "ERROR: DELETE document 2 returned $DELETE_DOC2, expected 204" >&2
  exit 1
fi
echo "Documents deleted."

# 14. Agent SSE stream — 401 without auth
echo "--- Agent SSE stream: 401 without auth ---"
AGENT_UNAUTH=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/agents/run/stream" \
  -H "Content-Type: application/json" \
  -d '{"prompt":"hello"}')
if [ "$AGENT_UNAUTH" != "401" ]; then
  echo "ERROR: Expected 401, got $AGENT_UNAUTH" >&2
  exit 1
fi
echo "401 without auth: OK"

# 15. Agent SSE stream — 400 without prompt
echo "--- Agent SSE stream: 400 without prompt ---"
AGENT_NOPROMPT=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/agents/run/stream" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{}')
if [ "$AGENT_NOPROMPT" != "400" ]; then
  echo "ERROR: Expected 400, got $AGENT_NOPROMPT" >&2
  exit 1
fi
echo "400 without prompt: OK"

# 16. Agent SSE stream — valid request
echo "--- Agent SSE stream: valid request ---"
AGENT_STATUS=$(curl -s -o /tmp/agent_sse.txt -w "%{http_code}" -X POST "$BASE_URL/agents/run/stream" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"prompt":"tell me a joke"}')
if [ "$AGENT_STATUS" != "200" ]; then
  echo "ERROR: Agent stream returned $AGENT_STATUS, expected 200" >&2
  exit 1
fi
if ! grep -q "event: done" /tmp/agent_sse.txt; then
  echo "ERROR: Agent stream missing 'event: done'" >&2
  cat /tmp/agent_sse.txt >&2
  exit 1
fi
echo "Agent SSE stream OK."
echo "--- Agent SSE stream output ---"
cat /tmp/agent_sse.txt

echo ""
echo "=== All smoke tests passed! ==="
