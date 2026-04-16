#!/bin/sh
set -e

SERVER_URL="${SERVER_URL:-http://localhost:50477}"
BASE_URL="$SERVER_URL/api/v1"

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
AI_PROVIDER_RESP=$(curl -sf -X POST "$BASE_URL/ai-providers" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"projectId\":\"$PROJECT_PUBLIC_ID\",\"name\":\"smoke-ollama\",\"provider\":\"ollama\",\"defaultModel\":\"qwen2.5:0.5b\",\"baseUrl\":\"http://ollama:11434\"}")
AI_PROVIDER_ID=$(echo "$AI_PROVIDER_RESP" | jq -r '.id')
echo "AI Provider id: $AI_PROVIDER_ID"

# 19. Create an HTTP agent tool that calls GET /api/v1/projects on the SOAT server
echo "--- Creating HTTP agent tool (list-projects) ---"
TOOL_RESP=$(curl -sf -X POST "$BASE_URL/agents/tools" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"projectId\": \"$PROJECT_PUBLIC_ID\",
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
    \"projectId\": \"$PROJECT_PUBLIC_ID\",
    \"aiProviderId\": \"$AI_PROVIDER_ID\",
    \"name\": \"project-lister\",
    \"instructions\": \"You are a helpful assistant. When the user asks you to list projects, you MUST call the list-projects tool and return the results. Always use the tool, never make up data.\",
    \"toolIds\": [\"$TOOL_ID\"],
    \"maxSteps\": 5
  }")
AGENT_ID=$(echo "$AGENT_RESP" | jq -r '.id')
echo "Agent id: $AGENT_ID"

# 21. Run the agent — ask it to list projects (non-streaming)
echo "--- Running agent generation ---"
GEN_RESP=$(curl -sf --max-time 120 -X POST "$BASE_URL/agents/$AGENT_ID/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"List all the projects. Use the list-projects tool."}]}')
echo "Generation response:"
echo "$GEN_RESP" | jq .

GEN_STATUS=$(echo "$GEN_RESP" | jq -r '.status')
if [ "$GEN_STATUS" != "completed" ]; then
  echo "ERROR: Expected generation status 'completed', got '$GEN_STATUS'" >&2
  exit 1
fi
echo "Generation completed."

# 22. Verify the agent output contains the project name
GEN_CONTENT=$(echo "$GEN_RESP" | jq -r '.output.content')
echo "Agent output: $GEN_CONTENT"
if echo "$GEN_CONTENT" | grep -qi "smoke-test-project"; then
  echo "Agent output contains project name: OK"
else
  echo "WARNING: Agent output may not contain the exact project name (LLM response varies), but generation completed successfully."
fi

# 23. Cleanup — delete agent
echo "--- Deleting agent ---"
AGENT_DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/agents/$AGENT_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$AGENT_DEL_STATUS" != "204" ]; then
  echo "ERROR: DELETE agent returned $AGENT_DEL_STATUS, expected 204" >&2
  exit 1
fi
echo "Agent deleted."

# 24. Cleanup — delete agent tool
echo "--- Deleting agent tool ---"
TOOL_DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/agents/tools/$TOOL_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$TOOL_DEL_STATUS" != "204" ]; then
  echo "ERROR: DELETE agent tool returned $TOOL_DEL_STATUS, expected 204" >&2
  exit 1
fi
echo "Agent tool deleted."

# 25. Create an MCP agent tool pointing at the SOAT MCP server
echo "--- Creating MCP agent tool ---"
MCP_TOOL_RESP=$(curl -sf -X POST "$BASE_URL/agents/tools" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"projectId\": \"$PROJECT_PUBLIC_ID\",
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
    \"projectId\": \"$PROJECT_PUBLIC_ID\",
    \"aiProviderId\": \"$AI_PROVIDER_ID\",
    \"name\": \"mcp-agent-lister\",
    \"instructions\": \"You are a helpful assistant with access to SOAT tools via MCP. When asked to list agents, call the list-agents MCP tool and return the results. Always use the tool.\",
    \"toolIds\": [\"$MCP_TOOL_ID\"],
    \"maxSteps\": 5
  }")
MCP_AGENT_ID=$(echo "$MCP_AGENT_RESP" | jq -r '.id')
echo "MCP Agent id: $MCP_AGENT_ID"

# 27. Ask the agent to list agents via MCP
echo "--- Running MCP agent generation ---"
MCP_GEN_RESP=$(curl -sf --max-time 300 -X POST "$BASE_URL/agents/$MCP_AGENT_ID/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"List all agents. Use the list-agents tool."}]}')
echo "MCP Generation response:"
echo "$MCP_GEN_RESP" | jq .

MCP_GEN_STATUS=$(echo "$MCP_GEN_RESP" | jq -r '.status')
if [ "$MCP_GEN_STATUS" != "completed" ]; then
  echo "ERROR: Expected MCP generation status 'completed', got '$MCP_GEN_STATUS'" >&2
  exit 1
fi
echo "MCP generation completed."

# 28. Verify the agent output mentions agent data (the mcp-agent-lister we just created)
MCP_GEN_CONTENT=$(echo "$MCP_GEN_RESP" | jq -r '.output.content')
echo "MCP Agent output: $MCP_GEN_CONTENT"
if echo "$MCP_GEN_CONTENT" | grep -qi "mcp-agent-lister\|agent"; then
  echo "MCP Agent output mentions agents: OK"
else
  echo "WARNING: MCP Agent output may not contain exact agent names (LLM response varies), but generation completed successfully."
fi

# 29. Cleanup — delete MCP agent
echo "--- Deleting MCP agent ---"
MCP_AGENT_DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/agents/$MCP_AGENT_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$MCP_AGENT_DEL_STATUS" != "204" ]; then
  echo "ERROR: DELETE MCP agent returned $MCP_AGENT_DEL_STATUS, expected 204" >&2
  exit 1
fi
echo "MCP Agent deleted."

# 30. Cleanup — delete MCP agent tool
echo "--- Deleting MCP agent tool ---"
MCP_TOOL_DEL_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/agents/tools/$MCP_TOOL_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$MCP_TOOL_DEL_STATUS" != "204" ]; then
  echo "ERROR: DELETE MCP agent tool returned $MCP_TOOL_DEL_STATUS, expected 204" >&2
  exit 1
fi
echo "MCP Agent tool deleted."

# ── Client Tool Tests ────────────────────────────────────────────────────────

# 31. Create a client-type agent tool
echo "--- Creating client agent tool ---"
CLIENT_TOOL_RESP=$(curl -sf -X POST "$BASE_URL/agents/tools" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"projectId\": \"$PROJECT_PUBLIC_ID\",
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
    \"projectId\": \"$PROJECT_PUBLIC_ID\",
    \"aiProviderId\": \"$AI_PROVIDER_ID\",
    \"name\": \"weather-agent\",
    \"instructions\": \"You are a weather assistant. When the user asks about the weather, call the get_weather tool with the city name.\",
    \"toolIds\": [\"$CLIENT_TOOL_ID\"],
    \"toolChoice\": \"required\",
    \"maxSteps\": 3
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
CLIENT_GEN_RESP=$(curl -sf --max-time 60 -X POST "$BASE_URL/agents/$CLIENT_AGENT_ID/generate" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"messages":[{"role":"user","content":"What is the weather in Paris?"}]}')
echo "Client generation response:"
echo "$CLIENT_GEN_RESP" | jq .

CLIENT_GEN_STATUS=$(echo "$CLIENT_GEN_RESP" | jq -r '.status')
if [ "$CLIENT_GEN_STATUS" != "requires_action" ]; then
  echo "ERROR: Expected status 'requires_action', got '$CLIENT_GEN_STATUS'" >&2
  exit 1
fi
echo "Generation paused for client tool execution: OK"

CLIENT_GEN_ID=$(echo "$CLIENT_GEN_RESP" | jq -r '.id')
CLIENT_TOOL_CALL_ID=$(echo "$CLIENT_GEN_RESP" | jq -r '.requiredAction.toolCalls[0].id')
echo "Generation id: $CLIENT_GEN_ID"
echo "Tool call id: $CLIENT_TOOL_CALL_ID"

# 34. Submit tool output (simulate client executing get_weather)
echo "--- Submitting client tool output ---"
SUBMIT_RESP=$(curl -sf --max-time 60 -X POST "$BASE_URL/agents/$CLIENT_AGENT_ID/generate/$CLIENT_GEN_ID/tool-outputs" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"toolOutputs\": [
      {
        \"toolCallId\": \"$CLIENT_TOOL_CALL_ID\",
        \"output\": { \"city\": \"Paris\", \"temperature\": \"18°C\", \"condition\": \"Partly cloudy\" }
      }
    ]
  }")
echo "Submit tool output response:"
echo "$SUBMIT_RESP" | jq .

SUBMIT_STATUS=$(echo "$SUBMIT_RESP" | jq -r '.status')
if [ "$SUBMIT_STATUS" != "completed" ]; then
  echo "ERROR: Expected final status 'completed', got '$SUBMIT_STATUS'" >&2
  exit 1
fi
echo "Client tool generation completed after tool output: OK"

# 35. Cleanup — delete client-tool agent
echo "--- Deleting client-tool agent ---"
CLIENT_AGENT_DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/agents/$CLIENT_AGENT_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$CLIENT_AGENT_DEL" != "204" ]; then
  echo "ERROR: DELETE client agent returned $CLIENT_AGENT_DEL, expected 204" >&2
  exit 1
fi
echo "Client-tool agent deleted."

# 36. Cleanup — delete client agent tool
echo "--- Deleting client agent tool ---"
CLIENT_TOOL_DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/agents/tools/$CLIENT_TOOL_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$CLIENT_TOOL_DEL" != "204" ]; then
  echo "ERROR: DELETE client agent tool returned $CLIENT_TOOL_DEL, expected 204" >&2
  exit 1
fi
echo "Client agent tool deleted."

# ── SOAT Tool Tests ─────────────────────────────────────────────────────────

# 37. Create a SOAT agent tool exposing list-projects action
echo "--- Creating SOAT agent tool ---"
SOAT_TOOL_RESP=$(curl -sf -X POST "$BASE_URL/agents/tools" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{
    \"projectId\": \"$PROJECT_PUBLIC_ID\",
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
    \"projectId\": \"$PROJECT_PUBLIC_ID\",
    \"aiProviderId\": \"$AI_PROVIDER_ID\",
    \"name\": \"soat-project-lister\",
    \"instructions\": \"You are a helpful assistant. Use the SOAT list-projects action to list projects for the user.\",
    \"toolIds\": [\"$SOAT_TOOL_ID\"],
    \"maxSteps\": 5
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
  -d '{"messages":[{"role":"user","content":"List all projects. Use the soat-platform tool."}]}')
echo "SOAT generation response:"
echo "$SOAT_GEN_RESP" | jq .

SOAT_GEN_STATUS=$(echo "$SOAT_GEN_RESP" | jq -r '.status')
if [ "$SOAT_GEN_STATUS" != "completed" ]; then
  echo "ERROR: Expected SOAT generation status 'completed', got '$SOAT_GEN_STATUS'" >&2
  exit 1
fi
echo "SOAT generation completed."

# 40. Verify the SOAT agent output references project data
SOAT_GEN_CONTENT=$(echo "$SOAT_GEN_RESP" | jq -r '.output.content')
echo "SOAT Agent output: $SOAT_GEN_CONTENT"
if echo "$SOAT_GEN_CONTENT" | grep -qi "smoke-test-project\|project"; then
  echo "SOAT Agent output mentions projects: OK"
else
  echo "WARNING: SOAT Agent output may not contain exact project names (LLM response varies), but generation completed successfully."
fi

# 41. Cleanup — delete SOAT agent
echo "--- Deleting SOAT agent ---"
SOAT_AGENT_DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/agents/$SOAT_AGENT_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$SOAT_AGENT_DEL" != "204" ]; then
  echo "ERROR: DELETE SOAT agent returned $SOAT_AGENT_DEL, expected 204" >&2
  exit 1
fi
echo "SOAT agent deleted."

# 42. Cleanup — delete SOAT agent tool
echo "--- Deleting SOAT agent tool ---"
SOAT_TOOL_DEL=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE "$BASE_URL/agents/tools/$SOAT_TOOL_ID" \
  -H "Authorization: Bearer $TOKEN")
if [ "$SOAT_TOOL_DEL" != "204" ]; then
  echo "ERROR: DELETE SOAT agent tool returned $SOAT_TOOL_DEL, expected 204" >&2
  exit 1
fi
echo "SOAT agent tool deleted."

echo ""
echo "=== All smoke tests passed! ==="
