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

An HTTP [tool](/docs/modules/tools) with an `Authorization` header covers every target whose credential is a fixed string. AWS and Google Cloud are not such targets:

- **AWS** expects a Signature Version 4 HMAC computed **per request**, over that request's method, URL, headers and body.
- **Google** expects a short-lived OAuth 2.0 access token, minted from a signed service account assertion and expiring in about an hour.

Neither is expressible as a static header, so a `{{secret:...}}` reference in `headers` would send a constant where the target requires a per-request value. The usual workaround is a bespoke proxy service that holds the credential and re-signs — one more deployment to run, secure and page someone about.

`execute.auth` removes it. It is an authentication strategy on the existing `http` transport, so `parameters`, path placeholders, `body_mode`, `output_mapping`, `preset_parameters`, [guardrails](/docs/modules/guardrails), [approvals](/docs/modules/approvals), pipeline steps and error mapping all behave exactly as they do for any other HTTP tool.

You will:

1. Store cloud credentials as [secrets](/docs/modules/secrets), never as literals in a tool config.
2. Build an **AWS SigV4** tool that reads an S3 object, and call it.
3. Hand it to an agent so the model can call it mid-conversation.
4. Build a **GCP service account** tool that submits a BigQuery job.
5. Learn the failure modes and the one combination that is refused on write.

## Prerequisites

- SOAT running locally. Follow the [Quick Start](/docs/getting-started) guide to bring the stack up with Docker Compose.
- `SECRETS_ENCRYPTION_KEY` set on the server — the [secrets](/docs/modules/secrets) module refuses to start without it. See [Configuration](/docs/self-hosting/configuration).
- [Ollama](https://ollama.com) running locally with `qwen2.5:0.5b` available. To connect xAI, OpenAI, Anthropic, or Amazon Bedrock instead, see [Connect Third-Party LLMs](/docs/tutorials/connect-third-party-llms).
- New to SOAT? Read [Key Concepts](/docs/getting-started/concepts) to understand projects, agents, and tools first.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- **Real cloud credentials.** An AWS access key pair with `s3:GetObject` on one bucket, and/or a GCP service account key file with BigQuery access. Steps 3 and 7 call the live APIs; everything else works without them.
- Server is at `http://localhost:5047`.

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

Tools, secrets and agents are all project-scoped. See [Projects](/docs/modules/projects) and [Users](/docs/modules/users#examples).

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

`GET /tools/{tool_id}` echoes `execute` back verbatim to anyone with read access on the project. A pasted access key would therefore be readable by every project member. Store the values as [secrets](/docs/modules/secrets#secret-references-secret) and reference them: the reference is what is stored and returned, and it is resolved only immediately before signing.

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

`auth.type: aws_sigv4` requires `region`, `service`, `access_key_id` and `secret_access_key`; `session_token` is optional and is sent as `X-Amz-Security-Token` when present. Replace `my-bucket` with a bucket your key can read. See [Tools — Computed credentials](/docs/modules/tools#computed-credentials-executeauth).

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

What SOAT sends: `Authorization: AWS4-HMAC-SHA256 …`, `X-Amz-Date`, and `X-Amz-Content-Sha256` where applicable. Signing happens **last** — over the final method, URL, headers and body — so nothing is added to the request after the signature is computed. Only headers SOAT itself controls are signed (`host`, `content-type`, `x-amz-*`); [context headers](/docs/modules/tools#context-headers-x-soat-context-) and `Idempotency-Key` are injected afterwards and stay unsigned, which AWS permits because verification covers only the `SignedHeaders` set.

---

## Step 4 — Let an agent call it

Nothing about attaching an authenticated tool differs from attaching any other HTTP tool — which is the point of putting `auth` on the transport instead of inventing an `aws` tool type. See [Agents — Tool Bindings](/docs/modules/agents#tool-bindings).

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

soat create-agent-generation --agent-id "$AGENT_ID" \
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

curl -s -X POST "$SOAT_BASE_URL/api/v1/agents/$AGENT_ID/generate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Summarize reports/2026-08.txt in one sentence."}]}' | jq '{status}'
```

</TabItem>
</Tabs>

The credential never enters the model's context: the tool schema the model sees is `parameters` only, and signing happens server-side after the model has chosen its arguments.

---

## Step 5 — One combination is refused on write

`aws_sigv4` cannot be combined with `body_mode: "multipart"`. SigV4 signs a hash of the exact payload, but in multipart mode `fetch` generates the body and its boundary — the bytes are not knowable at signing time, so any signature would be rejected upstream with an opaque `403`. SOAT rejects it at create and update time instead, with `400 VALIDATION_FAILED`.

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
console.log(error.code); // VALIDATION_FAILED (400)
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/tools" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"bad-upload\",\"type\":\"http\",\"execute\":{\"url\":\"https://my-bucket.s3.us-east-1.amazonaws.com/upload\",\"method\":\"POST\",\"body_mode\":\"multipart\",\"auth\":{\"type\":\"aws_sigv4\",\"region\":\"us-east-1\",\"service\":\"s3\",\"access_key_id\":\"{{secret:$AWS_KEY_ID_SECRET}}\",\"secret_access_key\":\"{{secret:$AWS_SECRET_SECRET}}\"}}}" \
  | jq '{code}'   # VALIDATION_FAILED
```

</TabItem>
</Tabs>

Every field in `auth` is validated on write the same way — a missing `region` or an unknown `type` fails at create time rather than at the first call. The same rule runs during `validate-formation`, so a malformed credential config fails before a [formation](/docs/modules/formations) apply starts.

---

## Step 6 — Store the GCP service account key

The whole key file JSON is one secret value. Read it from disk rather than pasting it — `jq -Rs` slurps the file into a single JSON string, and `--value` takes it as-is.

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

`auth.type: gcp_service_account` requires `credentials` (the key file JSON, as a string) and `scopes`. SOAT signs the assertion, exchanges it for an access token, and sends `Authorization: Bearer <access token>`.

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

Tokens are **cached** per service account, token endpoint and scope set, and refreshed shortly before they expire. Two tools sharing one service account and scope set share its token; a different scope set gets its own.

:::note
A tool's `input` becomes the request body **verbatim** — SOAT does not rewrite its keys. Author it in whatever casing the target API expects (`useLegacySql`, not `use_legacy_sql`). See [Tools — Request body encoding](/docs/modules/tools#request-body-encoding-body_mode).
:::

---

## Step 8 — Read the failure modes

When something goes wrong, the error code tells you which side failed — which is the difference between paging a cloud on-call and rotating a key.

| Code | Status | Meaning |
| --- | --- | --- |
| `TOOL_AUTH_FAILED` | `502` | The credential itself could not be produced: malformed service account JSON, an unusable private key, or a token endpoint that rejected the assertion. The request never reached the target. When the token endpoint responded, its status and body are in `meta.upstream_status` / `meta.upstream_body`. |
| `TOOL_HTTP_ERROR` | `502` | The credential was produced and sent; the **target** rejected or failed the call. |
| `VALIDATION_FAILED` | `400` | The `auth` config is malformed — caught on write, not at call time. |

Two more behaviors worth knowing before you debug a signature:

- **`service` and `region` are part of the signature,** not just routing. A `service` that does not match the host (say `s3` against a Lambda endpoint) produces a signature the target rejects, with no hint about why.
- **Path encoding follows the service.** Path segments are URI-encoded twice for every service except `s3`, which expects a single encoding, matching the SigV4 specification.

---

## What you built

| Target | `auth.type` | What is sent |
| --- | --- | --- |
| S3, DynamoDB, Lambda, any SigV4 API | `aws_sigv4` | `Authorization: AWS4-HMAC-SHA256 …`, `X-Amz-Date`, `X-Amz-Security-Token`, `X-Amz-Content-Sha256` |
| BigQuery, Cloud Storage, any Google API | `gcp_service_account` | `Authorization: Bearer <minted, cached access token>` |

`auth` is a slot on the HTTP transport, not a tool type — so a future strategy (`azure_ad`, `oauth2_client_credentials`) lands in the same place, and every tool feature keeps working across all of them.

Read next: [Tools — Computed credentials](/docs/modules/tools#computed-credentials-executeauth), [Secrets](/docs/modules/secrets), and [Gate a Tool with Guardrails](/docs/tutorials/gate-a-tool-with-guardrails) to require an approval before an agent is allowed to call one of these.
