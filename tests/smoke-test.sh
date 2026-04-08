#!/bin/sh
set -e

BASE_URL="${SERVER_URL:-http://localhost:5047}/api/v1"

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
echo "Token: ${TOKEN:0:20}..."

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

echo ""
echo "=== All smoke tests passed! ==="
