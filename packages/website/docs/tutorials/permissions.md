---
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Permissions in Practice

This tutorial walks through a realistic permissions setup from scratch. You will:

1. Log in as admin.
2. Create two regular users — `alice` (project lead) and `bob` (read-only analyst).
3. Create a project called **Analytics**.
4. Define two policies: one that grants full access to the project, and one that only allows read operations.
5. Attach policies to each user.
6. Create project-scoped API keys for both users, each with its own policy constraint.
7. Verify what each key can and cannot do.

By the end you will understand how policies, users, and API keys compose together to produce fine-grained access control.

## Prerequisites

- SOAT running locally. Follow [Quick Start](/docs/getting-started) if needed.
- CLI installed and configured, or SDK set up. See [CLI](/docs/cli) or [SDK](/docs/sdk).
- Server is at `http://localhost:5047`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

Export your server URL (used in subsequent steps):

```bash
export SOAT_BASE_URL=http://localhost:5047/api/v1
```

</TabItem>
<TabItem value="sdk" label="SDK">

All code snippets below share a single `client`. Swap the `auth` token as you progress through the tutorial:

```ts
import { createClient, createConfig } from '@soat/sdk';

const client = createClient(
  createConfig({ baseUrl: 'http://localhost:5047/api/v1', auth: '' })
);
```

</TabItem>
<TabItem value="curl" label="curl">

Export your server URL once:

```bash
export SOAT_URL=http://localhost:5047
```

</TabItem>
</Tabs>

---

## Step 1 — Log in as admin

Admin is the built-in superuser role. It bypasses policy evaluation entirely. See [IAM — Authentication](/docs/modules/iam#authentication) for details on JWT tokens and the admin role.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat login-user --username admin --password Admin1234!
```

The CLI prints a token. Save it and update your profile:

```bash
soat configure
# Token: <paste token here>
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: session, error } = await Users.loginUser({
  client,
  body: { username: 'admin', password: 'Admin1234!' },
});

if (error) throw new Error(JSON.stringify(error));

const ADMIN_TOKEN = session.token;

// Rebuild the client with admin credentials
const adminClient = createClient(
  createConfig({ baseUrl: 'http://localhost:5047/api/v1', auth: ADMIN_TOKEN })
);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')

echo "Admin token: $ADMIN_TOKEN"
```

</TabItem>
</Tabs>

---

## Step 2 — Create regular users

Create `alice` (project lead) and `bob` (read-only analyst). Only admins can create users. See [Users](/docs/modules/users) for the full user management reference.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-user --username alice --password Alice1234!
soat create-user --username bob   --password Bob1234!
```

Note the `id` field (`usr_…`) for each user — you will need them when attaching policies.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: alice, error: aliceErr } = await Users.createUser({
  client: adminClient,
  body: { username: 'alice', password: 'Alice1234!' },
});

if (aliceErr) throw new Error(JSON.stringify(aliceErr));

const { data: bob, error: bobErr } = await Users.createUser({
  client: adminClient,
  body: { username: 'bob', password: 'Bob1234!' },
});

if (bobErr) throw new Error(JSON.stringify(bobErr));

console.log('alice id:', alice.id); // usr_…
console.log('bob id  :', bob.id); // usr_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ALICE_ID=$(curl -s -X POST "$SOAT_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"Alice1234!"}' | jq -r '.id')

BOB_ID=$(curl -s -X POST "$SOAT_URL/api/v1/users" \
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

See [Projects](/docs/modules/projects) for the full project management reference.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-project --name "Analytics"
```

Copy the returned `id` (e.g. `proj_…`).

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { Projects } from '@soat/sdk';

const { data: project, error } = await Projects.createProject({
  client: adminClient,
  body: { name: 'Analytics' },
});

if (error) throw new Error(JSON.stringify(error));

const PROJECT_ID = project.id; // proj_…
console.log('project id:', PROJECT_ID);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
PROJECT_ID=$(curl -s -X POST "$SOAT_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Analytics"}' | jq -r '.id')

echo "project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Create policies

You will create two policies. Replace `$PROJECT_ID` with the actual value from the previous step.

Policies are global (not scoped to any project). The `resource` field uses [SOAT Resource Names (SRNs)](/docs/modules/iam#soat-resource-names-srns) to restrict which projects a policy covers. For the full policy document format and evaluation rules, see [IAM — Policy Documents](/docs/modules/iam#policy-documents).

### 4a — Full-access policy (for Alice)

This policy allows all actions on every resource inside the Analytics project.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-policy \
  --name "analytics-full-access" \
  --description "Full access to the Analytics project" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": ["*"],
        "resource": ["soat:'"$PROJECT_ID"':*:*"]
      }
    ]
  }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { Policies } from '@soat/sdk';

const { data: fullPolicy, error: fullErr } = await Policies.createPolicy({
  client: adminClient,
  body: {
    name: 'analytics-full-access',
    description: 'Full access to the Analytics project',
    document: {
      statement: [
        {
          effect: 'Allow',
          action: ['*'],
          resource: [`soat:${PROJECT_ID}:*:*`],
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
FULL_POLICY_ID=$(curl -s -X POST "$SOAT_URL/api/v1/policies" \
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
          \"resource\": [\"soat:${PROJECT_ID}:*:*\"]
        }
      ]
    }
  }" | jq -r '.id')

echo "full-access policy: $FULL_POLICY_ID"
```

</TabItem>
</Tabs>

### 4b — Read-only policy (for Bob)

This policy only allows read actions on files inside the project. For the full list of `files:*` and `documents:*` actions, see [Files — Permissions](/docs/modules/files#permissions) and [Documents — Permissions](/docs/modules/documents#permissions).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-policy \
  --name "analytics-read-only" \
  --description "Read-only access to files and documents in Analytics" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": [
          "files:ListFiles",
          "files:GetFile",
          "documents:ListDocuments",
          "documents:GetDocument"
        ],
        "resource": ["soat:'"$PROJECT_ID"':*:*"]
      }
    ]
  }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: readPolicy, error: readErr } = await Policies.createPolicy({
  client: adminClient,
  body: {
    name: 'analytics-read-only',
    description: 'Read-only access to files and documents in Analytics',
    document: {
      statement: [
        {
          effect: 'Allow',
          action: ['files:GetFile'],
          resource: [`soat:${PROJECT_ID}:*:*`],
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
READ_POLICY_ID=$(curl -s -X POST "$SOAT_URL/api/v1/policies" \
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
            \"files:ListFiles\",
            \"files:GetFile\",
            \"documents:ListDocuments\",
            \"documents:GetDocument\"
          ],
          \"resource\": [\"soat:${PROJECT_ID}:*:*\"]
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

Attach the full-access policy to Alice and the read-only policy to Bob. See [Policies — Attaching Policies to Users](/docs/modules/policies#attaching-policies-to-users) for more details.

:::note
`PUT /users/:userId/policies` **replaces** the user's entire policy list with the provided array.
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
const { error: attachAlice } = await Users.attachUserPolicies({
  client: adminClient,
  path: { userId: alice.id },
  body: { policy_ids: [FULL_POLICY_ID] },
});

if (attachAlice) throw new Error(JSON.stringify(attachAlice));

const { error: attachBob } = await Users.attachUserPolicies({
  client: adminClient,
  path: { userId: bob.id },
  body: { policy_ids: [READ_POLICY_ID] },
});

if (attachBob) throw new Error(JSON.stringify(attachBob));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Alice — full access
curl -s -X PUT "$SOAT_URL/api/v1/users/$ALICE_ID/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"policy_ids\":[\"$FULL_POLICY_ID\"]}" | jq .

# Bob — read-only
curl -s -X PUT "$SOAT_URL/api/v1/users/$BOB_ID/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"policy_ids\":[\"$READ_POLICY_ID\"]}" | jq .
```

</TabItem>
</Tabs>

---

## Step 6 — Create API keys

API keys allow programmatic access without sending a username and password. See [API Keys](/docs/modules/api-keys) for key rotation and revocation. Here you create two keys:

- **Alice's key** — scoped to the Analytics project, inherits her full-access policy.
- **Bob's key** — scoped to the Analytics project, further restricted to the read-only policy.

First, log in as each user to obtain their JWT tokens.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Log in as Alice and save her token to a separate profile
soat login-user --username alice --password Alice1234!
soat configure --profile alice
# Token: <paste Alice's token>

# Log in as Bob and save his token
soat login-user --username bob --password Bob1234!
soat configure --profile bob
# Token: <paste Bob's token>

# Create Alice's project key (using her profile)
soat --profile alice create-api-key \
  --name "alice-analytics-key" \
  --project_id "$PROJECT_ID"

# Create Bob's project key, explicitly restricting it to the read-only policy
soat --profile bob create-api-key \
  --name "bob-analytics-key" \
  --project_id "$PROJECT_ID" \
  --policy_ids '["'"$READ_POLICY_ID"'"]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
import { ApiKeys } from '@soat/sdk';

// Log in as Alice
const { data: aliceSession } = await Users.loginUser({
  client,
  body: { username: 'alice', password: 'Alice1234!' },
});

const aliceClient = createClient(
  createConfig({
    baseUrl: 'http://localhost:5047/api/v1',
    auth: aliceSession.token,
  })
);

// Log in as Bob
const { data: bobSession } = await Users.loginUser({
  client,
  body: { username: 'bob', password: 'Bob1234!' },
});

const bobClient = createClient(
  createConfig({
    baseUrl: 'http://localhost:5047/api/v1',
    auth: bobSession.token,
  })
);

// Alice creates her key — inherits full-access policy via user policies
const { data: aliceKey, error: aliceKeyErr } = await ApiKeys.createApiKey({
  client: aliceClient,
  body: {
    name: 'alice-analytics-key',
    project_id: PROJECT_ID,
  },
});

if (aliceKeyErr) throw new Error(JSON.stringify(aliceKeyErr));

// Bob creates his key — further restricted to read-only policy
const { data: bobKey, error: bobKeyErr } = await ApiKeys.createApiKey({
  client: bobClient,
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
ALICE_TOKEN=$(curl -s -X POST "$SOAT_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"alice","password":"Alice1234!"}' | jq -r '.token')

# Log in as Bob
BOB_TOKEN=$(curl -s -X POST "$SOAT_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"bob","password":"Bob1234!"}' | jq -r '.token')

# Alice's project key — inherits full-access
ALICE_API_KEY=$(curl -s -X POST "$SOAT_URL/api/v1/api-keys" \
  -H "Authorization: Bearer $ALICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"alice-analytics-key\",\"project_id\":\"$PROJECT_ID\"}" \
  | jq -r '.key')

# Bob's project key — further restricted to read-only
BOB_API_KEY=$(curl -s -X POST "$SOAT_URL/api/v1/api-keys" \
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
Store the key value. The raw `sk_…` key is returned **only once**. Store it in a secret manager or environment variable immediately. There is no way to retrieve it again — if lost, delete the key and create a new one.
:::

---

## Step 7 — Verify permissions

Confirm that each key behaves as expected.

### Alice can upload a file

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
echo "hello world" > sample.txt

soat --profile alice upload-file \
  --project_id "$PROJECT_ID" \
  --file sample.txt
# → 201, file created

soat --profile bob upload-file \
  --project_id "$PROJECT_ID" \
  --file sample.txt
# → 403, Bob's policy does not allow files:UploadFile
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Alice can upload
const fileBlob = new Blob(['hello world'], { type: 'text/plain' });
const form = new FormData();
form.append('file', fileBlob, 'sample.txt');

const aliceKeyClient = createClient(
  createConfig({ baseUrl: 'http://localhost:5047/api/v1', auth: ALICE_API_KEY })
);

const { data: uploadedFile, error: uploadErr } = await Files.uploadFile({
  client: aliceKeyClient,
  body: form,
});

if (uploadErr) throw new Error(JSON.stringify(uploadErr)); // should not throw

// Bob cannot upload — his policy allows only List/Get
const bobKeyClient = createClient(
  createConfig({ baseUrl: 'http://localhost:5047/api/v1', auth: BOB_API_KEY })
);

const { error: bobUploadErr } = await Files.uploadFile({
  client: bobKeyClient,
  body: form,
});

console.log(bobUploadErr?.status); // 403
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Alice uploads — expect 201
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$SOAT_URL/api/v1/files" \
  -H "Authorization: Bearer $ALICE_API_KEY" \
  -F "file=@sample.txt"

# Bob tries to upload — expect 403
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$SOAT_URL/api/v1/files" \
  -H "Authorization: Bearer $BOB_API_KEY" \
  -F "file=@sample.txt"
```

</TabItem>
</Tabs>

### Bob can read files

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Bob can list files — read is allowed
soat --profile bob list-files --project_id "$PROJECT_ID"
# → 200, file list
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: files, error: listErr } = await Files.listFiles({
  client: bobKeyClient,
  query: { project_id: PROJECT_ID },
});

if (listErr) throw new Error(JSON.stringify(listErr)); // should not throw
console.log('files visible to bob:', files.length);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
# Bob lists files — expect 200
curl -s "$SOAT_URL/api/v1/files?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $BOB_API_KEY" | jq '.[] | .id'
```

</TabItem>
</Tabs>

### Bob's key cannot exceed Bob's own permissions

Even if you tried to assign `FULL_POLICY_ID` to Bob's API key, it would not grant more than what Bob's user policies already allow. The effective permissions are always the **intersection**. See [IAM — Authorization Model](/docs/modules/iam#authorization-model) for the full rules.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# Attempt to create a key for Bob with the full-access policy
soat --profile bob create-api-key \
  --name "bob-escalation-attempt" \
  --project_id "$PROJECT_ID" \
  --policy_ids '["'"$FULL_POLICY_ID"'"]'
# Key is created, but when used it is still limited to Bob's read-only permissions
# because Bob's user policies are the ceiling.
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
// Bob creates a key referencing the full-access policy
const { data: escalatedKey } = await ApiKeys.createApiKey({
  client: bobClient,
  body: {
    name: 'bob-escalation-attempt',
    project_id: PROJECT_ID,
    policy_ids: [FULL_POLICY_ID], // full-access policy
  },
});

const escalatedClient = createClient(
  createConfig({
    baseUrl: 'http://localhost:5047/api/v1',
    auth: escalatedKey.key,
  })
);

// Still gets 403 — the intersection with Bob's read-only user policy wins
const { error } = await Files.uploadFile({
  client: escalatedClient,
  body: form,
});

console.log(error?.status); // 403
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ESCALATED_KEY=$(curl -s -X POST "$SOAT_URL/api/v1/api-keys" \
  -H "Authorization: Bearer $BOB_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"bob-escalation-attempt\",\"project_id\":\"$PROJECT_ID\",\"policy_ids\":[\"$FULL_POLICY_ID\"]}" \
  | jq -r '.key')

# Still 403 — Bob's user policies are the ceiling
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$SOAT_URL/api/v1/files" \
  -H "Authorization: Bearer $ESCALATED_KEY" \
  -F "file=@sample.txt"
```

</TabItem>
</Tabs>

---

## What you learned

| Concept                      | Takeaway                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| **Bootstrap**                | The first user is created via a special one-shot endpoint.                                  |
| **Admin vs. regular user**   | Admins bypass the policy engine. Regular users need explicit `Allow` statements.            |
| **Policies are global**      | Policies live outside projects. SRNs carry the project ID to scope access.                  |
| **User → policy attachment** | Attach one or more policies to a user; all are evaluated together.                          |
| **API key scoping**          | A key with `project_id` is hard-locked to that project.                                     |
| **Intersection semantics**   | A key's `policy_ids` narrow permissions — they can never exceed the owning user's policies. |
| **One-time key**             | The raw `sk_…` key is returned only on creation. Store it immediately.                      |

## Next steps

- Explore [IAM](/docs/modules/iam) for the full policy document format including wildcard actions and SRN patterns.
- See [Policies](/docs/modules/policies) for the complete policy CRUD API.
- See [API Keys](/docs/modules/api-keys) for key rotation and revocation patterns.
