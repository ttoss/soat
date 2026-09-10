---
description: "Give an agent a tool that calls a real AWS or Google Cloud API — SigV4 signed per request, or a service account access token minted and cached for you — without writing a proxy."
keywords:
  - AWS SigV4 agent tool
  - GCP service account agent
  - authenticated API tool
  - agent calling AWS API
  - BigQuery agent
  - LLM tool authentication
sidebar_position: 24
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Call AWS and GCP APIs from an Agent

A static `Authorization` header on an HTTP [tool](/docs/modules/tools) does not cover AWS (Signature Version 4 HMAC per request over method, URL, headers and body) or Google Cloud (short-lived OAuth 2.0 access token minted from a signed service account assertion, expiring in about an hour).

`execute.auth` is an authentication strategy on the `http` transport, so [guardrails](/docs/modules/guardrails), [approvals](/docs/modules/approvals), `body_mode` and `output_mapping` behave as usual. You build a SigV4-signed S3 tool and a GCP service-account BigQuery tool, hand one to an agent, and read the failure modes.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts).
- `SECRETS_ENCRYPTION_KEY` set — [secrets](/docs/modules/secrets) refuses to start without it ([Configuration](/docs/self-hosting/configuration)).
- [Ollama](https://ollama.com) with `qwen2.5:0.5b`; other providers: [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- [CLI](/docs/cli) or [SDK](/docs/sdk); server at `http://localhost:5047`.
- Real cloud credentials: an AWS key pair with `s3:GetObject` on one bucket, and/or a GCP service account key file with BigQuery access. Only Steps 3 and 7 call the live APIs.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { SoatClient } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in and create a project

See [Projects](/docs/modules/projects) and [Users](/docs/modules/users#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN

PROJECT_ID=$(soat create-project --name "Cloud Tools" | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: login } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: login.token,
});

const { data: project } = await adminSoat.projects.createProject({
  body: { name: 'Cloud Tools' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')

PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Cloud Tools"}' | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 2 — Store the AWS credentials as secrets

[`GET /tools/{tool_id}`](/docs/api/tools/get-tool) echoes `execute` verbatim to every project reader, so store credentials as [secrets](/docs/modules/secrets#secret-references-secret) and reference them; the reference is resolved only immediately before signing.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AWS_KEY_ID_SECRET=$(soat create-secret --project-id "$PROJECT_ID" \
  --name "aws-access-key-id" --value "$AWS_ACCESS_KEY_ID" | jq -r '.id')

AWS_SECRET_SECRET=$(soat create-secret --project-id "$PROJECT_ID" \
  --name "aws-secret-access-key" --value "$AWS_SECRET_ACCESS_KEY" | jq -r '.id')

echo "$AWS_KEY_ID_SECRET / $AWS_SECRET_SECRET"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: keyIdSecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: project.id,
    name: 'aws-access-key-id',
    value: process.env.AWS_ACCESS_KEY_ID,
  },
});

const { data: secretKeySecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: project.id,
    name: 'aws-secret-access-key',
    value: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AWS_KEY_ID_SECRET=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"aws-access-key-id\",\"value\":\"$AWS_ACCESS_KEY_ID\"}" | jq -r '.id')

AWS_SECRET_SECRET=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"aws-secret-access-key\",\"value\":\"$AWS_SECRET_ACCESS_KEY\"}" | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 3 — Create a SigV4-signed S3 tool

`auth.type: aws_sigv4` requires `region`, `service`, `access_key_id` and `secret_access_key`; optional `session_token` is sent as `X-Amz-Security-Token`. Replace `my-bucket` with a bucket your key can read. See [Tools — Computed credentials](/docs/modules/tools#computed-credentials-executeauth).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
S3_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "get-s3-object" \
  --type http \
  --description "Reads an object from the reports bucket" \
  --parameters '{"type":"object","properties":{"key":{"type":"string","description":"Object key inside the bucket"}},"required":["key"]}' \
  --execute '{
"url": "https://my-bucket.s3.us-east-1.amazonaws.com/{key}",
"method": "GET",
"auth": {
  "type": "aws_sigv4",
  "region": "us-east-1",
  "service": "s3",
  "access_key_id": "{{secret:'"$AWS_KEY_ID_SECRET"'}}",
  "secret_access_key": "{{secret:'"$AWS_SECRET_SECRET"'}}"
}
}' | jq -r '.id')

soat call-tool --tool-id "$S3_TOOL_ID" --input '{"key":"reports/2026-08.txt"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: s3Tool } = await adminSoat.tools.createTool({
  body: {
    project_id: project.id,
    name: 'get-s3-object',
    type: 'http',
    description: 'Reads an object from the reports bucket',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    execute: {
      url: 'https://my-bucket.s3.us-east-1.amazonaws.com/{key}',
      method: 'GET',
      auth: {
        type: 'aws_sigv4',
        region: 'us-east-1',
        service: 's3',
        access_key_id: `{{secret:${keyIdSecret.id}}}`,
        secret_access_key: `{{secret:${secretKeySecret.id}}}`,
      },
    },
  },
});

const { data: object } = await adminSoat.tools.callTool({
  path: { tool_id: s3Tool.id },
  body: { input: { key: 'reports/2026-08.txt' } },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
S3_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"get-s3-object\",
    \"type\": \"http\",
    \"description\": \"Reads an object from the reports bucket\",
    \"parameters\": {\"type\":\"object\",\"properties\":{\"key\":{\"type\":\"string\"}},\"required\":[\"key\"]},
    \"execute\": {
      \"url\": \"https://my-bucket.s3.us-east-1.amazonaws.com/{key}\",
      \"method\": \"GET\",
      \"auth\": {
        \"type\": \"aws_sigv4\",
        \"region\": \"us-east-1\",
        \"service\": \"s3\",
        \"access_key_id\": \"{{secret:$AWS_KEY_ID_SECRET}}\",
        \"secret_access_key\": \"{{secret:$AWS_SECRET_SECRET}}\"
      }
    }
  }" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/tools/$S3_TOOL_ID/call" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":{"key":"reports/2026-08.txt"}}'
```

</TabItem>
</Tabs>

SOAT sends `Authorization: AWS4-HMAC-SHA256 …`, `X-Amz-Date` and `X-Amz-Content-Sha256` where applicable, signing last over the final request. Signed headers: [Tools — Computed credentials](/docs/modules/tools#computed-credentials-executeauth).

---

## Step 4 — Let an agent call it

Attach it like any other HTTP tool — [Agents — Tool Bindings](/docs/modules/agents#tool-bindings).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
AI_PROVIDER_ID=$(soat create-ai-provider \
  --project-id "$PROJECT_ID" \
  --name "Local Ollama" \
  --provider "ollama" \
  --default-model "qwen2.5:0.5b" | jq -r '.id')

AGENT_ID=$(soat create-agent \
  --project-id "$PROJECT_ID" \
  --ai-provider-id "$AI_PROVIDER_ID" \
  --name "Reports Analyst" \
  --instructions "You read report files from object storage. Use get-s3-object when asked about a report." \
  --tool-bindings '[{"tool_id":"'"$S3_TOOL_ID"'"}]' | jq -r '.id')

soat create-agent-generation --wait true --agent-id "$AGENT_ID" \
  --messages '[{"role":"user","content":"Summarize reports/2026-08.txt in one sentence."}]' \
  | jq '{status}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: provider } = await adminSoat.aiProviders.createAiProvider({
  body: {
    project_id: project.id,
    name: 'Local Ollama',
    provider: 'ollama',
    default_model: 'qwen2.5:0.5b',
  },
});

const { data: agent } = await adminSoat.agents.createAgent({
  body: {
    project_id: project.id,
    ai_provider_id: provider.id,
    name: 'Reports Analyst',
    instructions:
      'You read report files from object storage. Use get-s3-object when asked about a report.',
    tool_bindings: [{ tool_id: s3Tool.id }],
  },
});

const { data: generation } = await adminSoat.agents.createAgentGeneration({
  path: { agent_id: agent.id },
  query: { wait: true },
  body: {
    messages: [
      { role: 'user', content: 'Summarize reports/2026-08.txt in one sentence.' },
    ],
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
AGENT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/agents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"ai_provider_id\":\"$AI_PROVIDER_ID\",\"name\":\"Reports Analyst\",\"instructions\":\"You read report files from object storage.\",\"tool_bindings\":[{\"tool_id\":\"$S3_TOOL_ID\"}]}" | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate?wait=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Summarize reports/2026-08.txt in one sentence."}]}' | jq '{status}'
```

</TabItem>
</Tabs>

The model sees `parameters` only; signing happens server-side after the model has chosen its arguments.

---

## Step 5 — One combination is refused on write

`aws_sigv4` cannot be combined with `body_mode: "multipart"`: `fetch` generates the multipart body and boundary, so the bytes SigV4 must hash are unknown at signing time. SOAT rejects the combination on create and update with `400 VALIDATION_FAILED` ([Tools](/docs/modules/tools#computed-credentials-executeauth)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat create-tool --project-id "$PROJECT_ID" --name "bad-upload" --type http --description "Rejected on write" --parameters '{"type":"object","properties":{"file":{"type":"string"}}}' --execute '{"url":"https://my-bucket.s3.us-east-1.amazonaws.com/upload","method":"POST","body_mode":"multipart","auth":{"type":"aws_sigv4","region":"us-east-1","service":"s3","access_key_id":"{{secret:'"$AWS_KEY_ID_SECRET"'}}","secret_access_key":"{{secret:'"$AWS_SECRET_SECRET"'}}"}}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error } = await adminSoat.tools.createTool({
  body: {
    project_id: project.id,
    name: 'bad-upload',
    type: 'http',
    execute: {
      url: 'https://my-bucket.s3.us-east-1.amazonaws.com/upload',
      method: 'POST',
      body_mode: 'multipart',
      auth: {
        type: 'aws_sigv4',
        region: 'us-east-1',
        service: 's3',
        access_key_id: `{{secret:${keyIdSecret.id}}}`,
        secret_access_key: `{{secret:${secretKeySecret.id}}}`,
      },
    },
  },
});
console.log(error.error.code); // VALIDATION_FAILED (400)
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"bad-upload\",\"type\":\"http\",\"execute\":{\"url\":\"https://my-bucket.s3.us-east-1.amazonaws.com/upload\",\"method\":\"POST\",\"body_mode\":\"multipart\",\"auth\":{\"type\":\"aws_sigv4\",\"region\":\"us-east-1\",\"service\":\"s3\",\"access_key_id\":\"{{secret:$AWS_KEY_ID_SECRET}}\",\"secret_access_key\":\"{{secret:$AWS_SECRET_SECRET}}\"}}}" \
  | jq '{code: .error.code}'   # VALIDATION_FAILED
```

</TabItem>
</Tabs>

Every `auth` field is validated on write (a missing `region`, an unknown `type`) and during `validate-formation`, before a [formation](/docs/modules/formations) apply starts.

---

## Step 6 — Store the GCP service account key

The whole key file JSON is one [secret](/docs/modules/secrets) value; `jq -Rs` slurps the file into a single JSON string for `--value`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
GCP_SECRET_ID=$(soat create-secret --project-id "$PROJECT_ID" \
  --name "gcp-service-account" \
  --value "$(cat ./service-account.json)" | jq -r '.id')

echo "GCP_SECRET_ID: $GCP_SECRET_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { readFileSync } from 'node:fs';

const { data: gcpSecret } = await adminSoat.secrets.createSecret({
  body: {
    project_id: project.id,
    name: 'gcp-service-account',
    value: readFileSync('./service-account.json', 'utf8'),
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
GCP_SECRET_ID=$(jq -n \
  --arg p "$PROJECT_ID" \
  --arg v "$(cat ./service-account.json)" \
  '{project_id: $p, name: "gcp-service-account", value: $v}' \
  | curl -s -X POST "$SOAT_BASE_URL/api/v1/secrets" \
      -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
      -d @- | jq -r '.id')
```

</TabItem>
</Tabs>

---

## Step 7 — Create a BigQuery tool

`auth.type: gcp_service_account` requires `credentials` (the key file JSON as a string) and `scopes`. SOAT signs the assertion, exchanges it for an access token, and sends `Authorization: Bearer <access token>` ([Tools](/docs/modules/tools#computed-credentials-executeauth)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
BQ_TOOL_ID=$(soat create-tool \
  --project-id "$PROJECT_ID" \
  --name "create-bigquery-job" \
  --type http \
  --description "Submits a BigQuery query job" \
  --parameters '{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}' \
  --execute '{
"url": "https://bigquery.googleapis.com/bigquery/v2/projects/my-gcp-project/jobs",
"method": "POST",
"auth": {
  "type": "gcp_service_account",
  "credentials": "{{secret:'"$GCP_SECRET_ID"'}}",
  "scopes": ["https://www.googleapis.com/auth/bigquery"]
}
}' | jq -r '.id')

soat call-tool --tool-id "$BQ_TOOL_ID" \
  --input '{"configuration":{"query":{"query":"SELECT 1","useLegacySql":false}}}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: bqTool } = await adminSoat.tools.createTool({
  body: {
    project_id: project.id,
    name: 'create-bigquery-job',
    type: 'http',
    description: 'Submits a BigQuery query job',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
    execute: {
      url: 'https://bigquery.googleapis.com/bigquery/v2/projects/my-gcp-project/jobs',
      method: 'POST',
      auth: {
        type: 'gcp_service_account',
        credentials: `{{secret:${gcpSecret.id}}}`,
        scopes: ['https://www.googleapis.com/auth/bigquery'],
      },
    },
  },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
BQ_TOOL_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"name\": \"create-bigquery-job\",
    \"type\": \"http\",
    \"description\": \"Submits a BigQuery query job\",
    \"parameters\": {\"type\":\"object\",\"properties\":{\"query\":{\"type\":\"string\"}},\"required\":[\"query\"]},
    \"execute\": {
      \"url\": \"https://bigquery.googleapis.com/bigquery/v2/projects/my-gcp-project/jobs\",
      \"method\": \"POST\",
      \"auth\": {
        \"type\": \"gcp_service_account\",
        \"credentials\": \"{{secret:$GCP_SECRET_ID}}\",
        \"scopes\": [\"https://www.googleapis.com/auth/bigquery\"]
      }
    }
  }" | jq -r '.id')
```

</TabItem>
</Tabs>

Tokens are cached per service account, token endpoint and scope set, and refreshed shortly before expiry.

:::note
`input` becomes the request body verbatim; use the target API's casing (`useLegacySql`, not `use_legacy_sql`). See [Tools — Request body encoding](/docs/modules/tools#request-body-encoding-body_mode).
:::

---

## Step 8 — Read the failure modes

- `502 TOOL_AUTH_FAILED` — the credential could not be produced; the request never reached the target.
- `502 TOOL_HTTP_ERROR` — the target rejected the call.
- `400 VALIDATION_FAILED` — malformed `auth` config caught on write.

Full semantics, including signature and path-encoding gotchas: [Tools — Computed credentials](/docs/modules/tools#computed-credentials-executeauth).

---

## What's next

[Tools — Computed credentials](/docs/modules/tools#computed-credentials-executeauth), [Secrets](/docs/modules/secrets), [Gate a Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails).
