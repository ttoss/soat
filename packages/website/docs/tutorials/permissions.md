---
description: "Walk through a realistic SOAT permissions setup from scratch with users, policies, and API keys."
keywords:
  - AI agent permissions
  - IAM policies
  - API keys
  - access control
  - least privilege
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Permissions in Practice

Two users (`alice`, project lead; `bob`, read-only analyst), an **Analytics** project, a full-access and a read-only policy, project-scoped API keys for each, and a check of what each key can do.

## Prerequisites

- SOAT running locally at `http://localhost:5047` ([Quick Start](/docs/getting-started)).
- [Key Concepts](/docs/getting-started/concepts) if new to SOAT.
- [CLI](/docs/cli) or [SDK](/docs/sdk) set up.
- [Configuration](/docs/self-hosting/configuration) for production hardening.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

Export the server URL:

```bash
export SOAT_BASE_URL=http://localhost:5047
```

CLI path flags are kebab-cased per resource: `--user-id`, `--project-id`.

</TabItem>
<TabItem value="sdk" label="SDK">

Snippets use the authenticated `SoatClient` created in Step 1.

```ts
import { SoatClient } from '@soat/sdk';
```

</TabItem>
<TabItem value="curl" label="curl">

Export the server URL:

```bash
export SOAT_BASE_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role and bypasses policy evaluation ([IAM — Authentication](/docs/modules/iam#authentication)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat login-user --username admin --password Admin1234!
```

Save the token and update the profile:

```bash
soat configure
# Token: <paste token here>
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: session, error } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

if (error) throw new Error(JSON.stringify(error));

// Rebuild with admin credentials
const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: session.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')

echo "Admin token: $ADMIN_TOKEN"
```

</TabItem>
</Tabs>

---

## Step 2 — Create regular users

Only admins can create [users](/docs/modules/users#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ALICE_ID=$(soat create-user --username alice --password Alice1234! | jq -r '.id')
BOB_ID=$(soat create-user --username bob --password Bob1234! | jq -r '.id')
echo "alice: $ALICE_ID"
echo "bob  : $BOB_ID"
```

Keep each `id` (`user_…`) for attaching policies.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: alice, error: aliceErr } = await adminSoat.users.createUser({
  body: { username: 'alice', password: 'Alice1234!' },
});

if (aliceErr) throw new Error(JSON.stringify(aliceErr));

const { data: bob, error: bobErr } = await adminSoat.users.createUser({
  body: { username: 'bob', password: 'Bob1234!' },
});

if (bobErr) throw new Error(JSON.stringify(bobErr));

console.log('alice id:', alice.id); // user_…
console.log('bob id  :', bob.id); // user_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ALICE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"Alice1234!"}' | jq -r '.id')

BOB_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"Bob1234!"}' | jq -r '.id')

echo "alice: $ALICE_ID"
echo "bob  : $BOB_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Create the Analytics project

See [Projects](/docs/modules/projects#examples).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
PROJECT_ID=$(soat create-project --name "Analytics" | jq -r '.id')
echo "project: $PROJECT_ID"
```

Keep the returned `id` (`proj_…`).

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: project, error } = await adminSoat.projects.createProject({
  body: { name: 'Analytics' },
});

if (error) throw new Error(JSON.stringify(error));

const PROJECT_ID = project.id; // proj_…
console.log('project id:', PROJECT_ID);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Analytics"}' | jq -r '.id')

echo "project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create policies

Policies are global; the `resource` field uses [SRNs](/docs/modules/iam#soat-resource-names-srns) to restrict which projects a policy covers. Format and evaluation rules: [IAM — Policy Documents](/docs/modules/iam#policy-documents).

### 4a — Full-access policy (for Alice)

All actions on every resource inside the Analytics project.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
FULL_POLICY_ID=$(soat create-policy \
  --name "analytics-full-access" \
  --description "Full access to the Analytics project" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": ["*"],
        "resource": ["srn:'"$PROJECT_ID"':*:*"]
      }
    ]
  }' | jq -r '.id')
echo "full-access policy: $FULL_POLICY_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: fullPolicy, error: fullErr } =
  await adminSoat.policies.createPolicy({
    body: {
      name: 'analytics-full-access',
      description: 'Full access to the Analytics project',
      document: {
        statement: [
          {
            effect: 'Allow',
            action: ['*'],
            resource: [`srn:${PROJECT_ID}:*:*`],
          },
        ],
      },
    },
  });

if (fullErr) throw new Error(JSON.stringify(fullErr));

const FULL_POLICY_ID = fullPolicy.id; // pol_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
FULL_POLICY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"analytics-full-access\",
    \"description\": \"Full access to the Analytics project\",
    \"document\": {
      \"statement\": [
        {
          \"effect\": \"Allow\",
          \"action\": [\"*\"],
          \"resource\": [\"srn:${PROJECT_ID}:*:*\"]
        }
      ]
    }
  }" | jq -r '.id')

echo "full-access policy: $FULL_POLICY_ID"
```

</TabItem>
</Tabs>

### 4b — Read-only policy (for Bob)

Read actions on files inside the project only. `files:*` and `documents:*` actions: [Permissions Reference](/docs/permissions).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
READ_POLICY_ID=$(soat create-policy \
  --name "analytics-read-only" \
  --description "Read-only access to files and documents in Analytics" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": [
          "files:GetFile",
          "documents:ListDocuments",
          "documents:GetDocument"
        ],
        "resource": ["srn:'"$PROJECT_ID"':*:*"]
      }
    ]
  }' | jq -r '.id')
echo "read-only policy: $READ_POLICY_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: readPolicy, error: readErr } =
  await adminSoat.policies.createPolicy({
    body: {
      name: 'analytics-read-only',
      description: 'Read-only access to files and documents in Analytics',
      document: {
        statement: [
          {
            effect: 'Allow',
            action: ['files:GetFile'],
            resource: [`srn:${PROJECT_ID}:*:*`],
          },
        ],
      },
    },
  });

if (readErr) throw new Error(JSON.stringify(readErr));

const READ_POLICY_ID = readPolicy.id; // pol_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
READ_POLICY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"analytics-read-only\",
    \"description\": \"Read-only access to files and documents in Analytics\",
    \"document\": {
      \"statement\": [
        {
          \"effect\": \"Allow\",
          \"action\": [
            \"files:GetFile\",
            \"documents:ListDocuments\",
            \"documents:GetDocument\"
          ],
          \"resource\": [\"srn:${PROJECT_ID}:*:*\"]
        }
      ]
    }
  }" | jq -r '.id')

echo "read-only policy: $READ_POLICY_ID"
```

</TabItem>
</Tabs>

---

## Step 5 — Attach policies to users

Full-access to Alice, read-only to Bob ([Policies — Attaching Policies to Users](/docs/modules/policies#attaching-policies-to-users)).

:::note
[`PUT /users/:user_id/policies`](/docs/api/users/attach-user-policies) **replaces** the user's entire policy list with the provided array.
:::

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Give Alice full access
soat attach-user-policies \
  --user-id "$ALICE_ID" \
  --policy-ids '["'"$FULL_POLICY_ID"'"]'

# Give Bob read-only access
soat attach-user-policies \
  --user-id "$BOB_ID" \
  --policy-ids '["'"$READ_POLICY_ID"'"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error: attachAlice } = await adminSoat.users.attachUserPolicies({
  path: { user_id: alice.id },
  body: { policy_ids: [FULL_POLICY_ID] },
});

if (attachAlice) throw new Error(JSON.stringify(attachAlice));

const { error: attachBob } = await adminSoat.users.attachUserPolicies({
  path: { user_id: bob.id },
  body: { policy_ids: [READ_POLICY_ID] },
});

if (attachBob) throw new Error(JSON.stringify(attachBob));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Alice — full access
curl -s -X PUT "$SOAT_BASE_URL/api/v1/users/$ALICE_ID/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"policy_ids\":[\"$FULL_POLICY_ID\"]}" | jq .

# Bob — read-only
curl -s -X PUT "$SOAT_BASE_URL/api/v1/users/$BOB_ID/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"policy_ids\":[\"$READ_POLICY_ID\"]}" | jq .
```

</TabItem>
</Tabs>

---

## Step 6 — Create API keys

[API keys](/docs/modules/api-keys#examples) give programmatic access without a password. Both are scoped to the Analytics project: Alice's inherits her full-access policy; Bob's is further restricted to the read-only policy. Log in as each user first to obtain their JWT tokens.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Log in as Alice and save her token to a named profile
soat login-user --username alice --password Alice1234!
soat configure --profile alice

# Log in as Bob and save his token
soat login-user --username bob --password Bob1234!
soat configure --profile bob

# Create Alice's API key (using her profile)
ALICE_API_KEY=$(soat --profile alice create-api-key \
  --name "alice-analytics-key" \
  --project-id "$PROJECT_ID" | jq -r '.key')

# Create Bob's API key, explicitly restricting it to the read-only policy
BOB_API_KEY=$(soat --profile bob create-api-key \
  --name "bob-analytics-key" \
  --project-id "$PROJECT_ID" \
  --policy-ids '["'"$READ_POLICY_ID"'"]' | jq -r '.key')

echo "Alice key: $ALICE_API_KEY"
echo "Bob key  : $BOB_API_KEY"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Log in as Alice
const { data: aliceSession } = await soat.users.loginUser({
  body: { username: 'alice', password: 'Alice1234!' },
});

const aliceSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: aliceSession.token,
});

// Log in as Bob
const { data: bobSession } = await soat.users.loginUser({
  body: { username: 'bob', password: 'Bob1234!' },
});

const bobSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: bobSession.token,
});

// Alice creates her key — inherits full-access policy via user policies
const { data: aliceKey, error: aliceKeyErr } =
  await aliceSoat.apiKeys.createApiKey({
    body: {
      name: 'alice-analytics-key',
      project_id: PROJECT_ID,
    },
  });

if (aliceKeyErr) throw new Error(JSON.stringify(aliceKeyErr));

// Bob creates his key — further restricted to read-only policy
const { data: bobKey, error: bobKeyErr } = await bobSoat.apiKeys.createApiKey({
  body: {
    name: 'bob-analytics-key',
    project_id: PROJECT_ID,
    policy_ids: [READ_POLICY_ID],
  },
});

if (bobKeyErr) throw new Error(JSON.stringify(bobKeyErr));

// Save these — they are shown only once
const ALICE_API_KEY = aliceKey.key; // sk_…
const BOB_API_KEY = bobKey.key; // sk_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Log in as Alice
ALICE_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"Alice1234!"}' | jq -r '.token')

# Log in as Bob
BOB_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"Bob1234!"}' | jq -r '.token')

# Alice's API key — inherits full-access
ALICE_API_KEY=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/api-keys" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"alice-analytics-key\",\"project_id\":\"$PROJECT_ID\"}" \
  | jq -r '.key')

# Bob's API key — further restricted to read-only
BOB_API_KEY=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/api-keys" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"bob-analytics-key\",\"project_id\":\"$PROJECT_ID\",\"policy_ids\":[\"$READ_POLICY_ID\"]}" \
  | jq -r '.key')

echo "Alice key: $ALICE_API_KEY"
echo "Bob key  : $BOB_API_KEY"
```

</TabItem>
</Tabs>

:::warning
The raw `sk_…` key is returned **only once**; store it in a secret manager. If lost, delete the key and create a new one.
:::

---

## Step 7 — Verify permissions

Upload and list operations are from the [Files](/docs/modules/files#examples) module.

### Alice can upload a file

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
echo "hello world" > sample.txt

SOAT_TOKEN="$ALICE_API_KEY" soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --content "$(base64 -w 0 sample.txt)" \
  --filename "sample.txt"

# Switch to Bob's profile to test his permissions
# → expect-fail
SOAT_TOKEN="$BOB_API_KEY" soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --content "$(base64 -w 0 sample.txt)" \
  --filename "sample.txt"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const aliceKeySoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: ALICE_API_KEY,
});

// Alice can upload
const { data: uploadedFile, error: uploadErr } =
  await aliceKeySoat.files.uploadFile({
    body: {
      file: new Blob(['hello world'], { type: 'text/plain' }),
      project_id: PROJECT_ID,
    },
  });

if (uploadErr) throw new Error(JSON.stringify(uploadErr)); // should not throw

// Bob cannot upload — his policy allows only files:GetFile
const bobKeySoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: BOB_API_KEY,
});

const { error: bobUploadErr } = await bobKeySoat.files.uploadFile({
  body: {
    file: new Blob(['hello world'], { type: 'text/plain' }),
    project_id: PROJECT_ID,
  },
});

console.log(bobUploadErr?.status); // 403
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
echo "hello world" > sample.txt

# Alice uploads — expect 201
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$SOAT_BASE_URL/api/v1/files/upload" \
  -H "Authorization: Bearer $ALICE_API_KEY" \
  -F "project_id=$PROJECT_ID" \
  -F "file=@sample.txt"

# Bob tries to upload — expect 403
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$SOAT_BASE_URL/api/v1/files/upload" \
  -H "Authorization: Bearer $BOB_API_KEY" \
  -F "project_id=$PROJECT_ID" \
  -F "file=@sample.txt"
```

</TabItem>
</Tabs>

### Bob can read files

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Bob can list files — read is allowed
SOAT_TOKEN="$BOB_API_KEY" soat list-files --project-id "$PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: files, error: listErr } = await bobKeySoat.files.listFiles({
  query: { project_id: PROJECT_ID },
});

if (listErr) throw new Error(JSON.stringify(listErr)); // should not throw
console.log('files visible to bob:', files.length);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Bob lists files — expect 200
curl -s "$SOAT_BASE_URL/api/v1/files?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $BOB_API_KEY" | jq '.[] | .id'
```

</TabItem>
</Tabs>

### Bob's key cannot exceed Bob's own permissions

Assigning `FULL_POLICY_ID` to Bob's API key grants nothing beyond Bob's user policies: effective permissions are the **intersection** ([IAM — Authorization Model](/docs/modules/iam#authorization-model)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Attempt to create a key for Bob with the full-access policy
# Key is created, but when used it is still limited to Bob's read-only permissions
# because Bob's user policies are the ceiling.
ESCALATED_KEY=$(soat --profile bob create-api-key \
  --name "bob-escalation-attempt" \
  --project-id "$PROJECT_ID" \
  --policy-ids '["'"$FULL_POLICY_ID"'"]' | jq -r '.key')

# → expect-fail
SOAT_TOKEN="$ESCALATED_KEY" soat upload-file-base64 \
  --project-id "$PROJECT_ID" \
  --content "$(base64 -w 0 sample.txt)" \
  --filename "sample.txt"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Bob creates a key referencing the full-access policy
const { data: escalatedKey } = await bobSoat.apiKeys.createApiKey({
  body: {
    name: 'bob-escalation-attempt',
    project_id: PROJECT_ID,
    policy_ids: [FULL_POLICY_ID], // full-access policy
  },
});

const escalatedSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: escalatedKey.key,
});

// Still gets 403 — the intersection with Bob's read-only user policy wins
const { error } = await escalatedSoat.files.uploadFile({
  body: {
    file: new Blob(['hello world'], { type: 'text/plain' }),
    project_id: PROJECT_ID,
  },
});

console.log(error?.status); // 403
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ESCALATED_KEY=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/api-keys" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"bob-escalation-attempt\",\"project_id\":\"$PROJECT_ID\",\"policy_ids\":[\"$FULL_POLICY_ID\"]}" \
  | jq -r '.key')

# Still 403 — Bob's user policies are the ceiling
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$SOAT_BASE_URL/api/v1/files/upload" \
  -H "Authorization: Bearer $ESCALATED_KEY" \
  -F "project_id=$PROJECT_ID" \
  -F "file=@sample.txt"
```

</TabItem>
</Tabs>

---

## Next steps

- [IAM](/docs/modules/iam#policy-documents) — policy document format, wildcard actions, SRN patterns.
- [Policies](/docs/modules/policies#examples) — policy CRUD API.
- [API Keys](/docs/modules/api-keys#examples) — rotation and revocation.
