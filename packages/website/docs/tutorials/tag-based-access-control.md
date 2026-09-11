---
description: "Tag documents, condition an IAM policy on those tags, and watch the list filter and knowledge search narrow to what the caller may see."
keywords:
  - attribute-based access control
  - ABAC
  - resource tags
  - IAM conditions
  - multi-tenant AI
sidebar_position: 1
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Tag-Based Access Control

[Permissions in Practice](./permissions.md) grants access by **action** and by **resource**. This tutorial grants it by **attribute**: two documents tagged `team: finance` and `team: eng`, and a user whose policy condition excludes the finance one — from the listing and from semantic search alike, without naming a single document ID.

The same tag bag drives three surfaces, so the vocabulary is written once:

| Surface | Reads the tags as |
|---|---|
| [`GET /api/v1/documents?tags=`](/docs/api/documents/list-documents) | a list filter |
| [`POST /api/v1/knowledge/search`](/docs/api/knowledge/search-knowledge) | a search filter over chunks |
| A policy condition on `soat:ResourceTag/<key>` | an authorization rule |

## Prerequisites

- SOAT running locally at `http://localhost:5047` ([Quick Start](/docs/getting-started)).
- An embedding model configured (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`) — Step 6 runs a real semantic search. See [Generating Embeddings](./embeddings.md).
- [Permissions in Practice](./permissions.md) for users, policies and attachment.
- [IAM — Tags](/docs/modules/iam#tags) for the condition-key reference.

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

## Step 1 — Log in as admin and create a project

Admin bypasses policy evaluation ([IAM — Authentication](/docs/modules/iam#authentication)), so every setup step below is unfiltered — that is what makes Step 5 and Step 6 meaningful.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN

PROJECT_ID=$(soat create-project --name "Handbook ABAC" | jq -r '.id')
echo "project: $PROJECT_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const soat = new SoatClient({ baseUrl: 'http://localhost:5047' });

const { data: login, error: loginErr } = await soat.users.loginUser({
  body: { username: 'admin', password: 'Admin1234!' },
});

if (loginErr) throw new Error(JSON.stringify(loginErr));

const adminSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: login.token,
});

const { data: project, error: projectErr } =
  await adminSoat.projects.createProject({ body: { name: 'Handbook ABAC' } });

if (projectErr) throw new Error(JSON.stringify(projectErr));

const PROJECT_ID = project.id; // proj_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
ADMIN_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin1234!"}' | jq -r '.token')

PROJECT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/projects" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Handbook ABAC"}' | jq -r '.id')

echo "project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 2 — Create two documents with different tags

`tags` is a flat object of string values on [`POST /api/v1/documents`](/docs/api/documents/create-document); an array or a nested object is rejected with `400 VALIDATION_FAILED` rather than coerced ([Documents — Tags](/docs/modules/documents#tags)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
FINANCE_DOC_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --path /handbook/payroll.txt \
  --content "Payroll runs on the 25th of each month. Salary bands are reviewed every January." \
  --tags '{"team":"finance"}' | jq -r '.id')

ENG_DOC_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --path /handbook/oncall.txt \
  --content "The on-call rotation changes every Monday. Page the primary before escalating." \
  --tags '{"team":"eng"}' | jq -r '.id')

echo "finance: $FINANCE_DOC_ID"
echo "eng    : $ENG_DOC_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: financeDoc, error: financeErr } =
  await adminSoat.documents.createDocument({
    body: {
      project_id: PROJECT_ID,
      path: '/handbook/payroll.txt',
      content:
        'Payroll runs on the 25th of each month. Salary bands are reviewed every January.',
      tags: { team: 'finance' },
    },
  });

if (financeErr) throw new Error(JSON.stringify(financeErr));

const { data: engDoc, error: engErr } =
  await adminSoat.documents.createDocument({
    body: {
      project_id: PROJECT_ID,
      path: '/handbook/oncall.txt',
      content:
        'The on-call rotation changes every Monday. Page the primary before escalating.',
      tags: { team: 'eng' },
    },
  });

if (engErr) throw new Error(JSON.stringify(engErr));

const FINANCE_DOC_ID = financeDoc.id; // doc_…
const ENG_DOC_ID = engDoc.id; // doc_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
FINANCE_DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"path\": \"/handbook/payroll.txt\",
    \"content\": \"Payroll runs on the 25th of each month. Salary bands are reviewed every January.\",
    \"tags\": {\"team\": \"finance\"}
  }" | jq -r '.id')

ENG_DOC_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"project_id\": \"$PROJECT_ID\",
    \"path\": \"/handbook/oncall.txt\",
    \"content\": \"The on-call rotation changes every Monday. Page the primary before escalating.\",
    \"tags\": {\"team\": \"eng\"}
  }" | jq -r '.id')

echo "finance: $FINANCE_DOC_ID"
echo "eng    : $ENG_DOC_ID"
```

</TabItem>
</Tabs>

---

## Step 3 — Filter the listing by tag

Repeat `?tags=` for several pairs; **all** must be present with exactly that value. The pair splits on the first colon, so a value may itself contain colons.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-documents --project-id "$PROJECT_ID" --tags team:finance \
  | jq -e --arg id "$FINANCE_DOC_ID" '(.data | length) == 1 and .data[0].id == $id'
```

`jq -e` exits non-zero when the assertion is false, so this line fails loudly rather than printing something wrong.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: financeOnly } = await adminSoat.documents.listDocuments({
  query: { project_id: PROJECT_ID, tags: ['team:finance'] },
});

console.log(financeOnly.data.map((d) => d.id)); // [FINANCE_DOC_ID]
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -G "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data-urlencode "project_id=$PROJECT_ID" \
  --data-urlencode "tags=team:finance" \
  | jq '[.data[].id]'
```

</TabItem>
</Tabs>

---

## Step 4 — Grant access by attribute, not by ID

One statement allows listing and searching across the whole project, then **subtracts** everything tagged `team: finance` with a `StringNotEquals` condition on `soat:ResourceTag/team`.

The condition never names `$FINANCE_DOC_ID`. A document tagged `team: finance` tomorrow is out of scope the moment it is written — no policy edit.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DANA_ID=$(soat create-user --username dana-tags --password Dana1234! | jq -r '.id')

POLICY_ID=$(soat create-policy \
  --name "handbook-except-finance" \
  --description "Read and search the handbook, except anything tagged team:finance" \
  --document '{
    "statement": [
      {
        "effect": "Allow",
        "action": ["documents:ListDocuments", "knowledge:SearchKnowledge"],
        "resource": ["srn:'"$PROJECT_ID"':*:*"],
        "condition": {
          "StringNotEquals": { "soat:ResourceTag/team": "finance" }
        }
      }
    ]
  }' | jq -r '.id')

soat attach-user-policies --user-id "$DANA_ID" --policy-ids '["'"$POLICY_ID"'"]'

DANA_TOKEN=$(soat login-user --username dana-tags --password Dana1234! | jq -r '.token')
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: dana, error: danaErr } = await adminSoat.users.createUser({
  body: { username: 'dana-tags', password: 'Dana1234!' },
});

if (danaErr) throw new Error(JSON.stringify(danaErr));

const { data: policy, error: policyErr } =
  await adminSoat.policies.createPolicy({
    body: {
      name: 'handbook-except-finance',
      description:
        'Read and search the handbook, except anything tagged team:finance',
      document: {
        statement: [
          {
            effect: 'Allow',
            action: ['documents:ListDocuments', 'knowledge:SearchKnowledge'],
            resource: [`srn:${PROJECT_ID}:*:*`],
            condition: {
              StringNotEquals: { 'soat:ResourceTag/team': 'finance' },
            },
          },
        ],
      },
    },
  });

if (policyErr) throw new Error(JSON.stringify(policyErr));

await adminSoat.users.attachUserPolicies({
  path: { user_id: dana.id },
  body: { policy_ids: [policy.id] },
});

const { data: danaLogin } = await soat.users.loginUser({
  body: { username: 'dana-tags', password: 'Dana1234!' },
});

const danaSoat = new SoatClient({
  baseUrl: 'http://localhost:5047',
  token: danaLogin.token,
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
DANA_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"dana-tags","password":"Dana1234!"}' | jq -r '.id')

POLICY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"handbook-except-finance\",
    \"description\": \"Read and search the handbook, except anything tagged team:finance\",
    \"document\": {
      \"statement\": [
        {
          \"effect\": \"Allow\",
          \"action\": [\"documents:ListDocuments\", \"knowledge:SearchKnowledge\"],
          \"resource\": [\"srn:${PROJECT_ID}:*:*\"],
          \"condition\": {
            \"StringNotEquals\": {\"soat:ResourceTag/team\": \"finance\"}
          }
        }
      ]
    }
  }" | jq -r '.id')

curl -s -X PUT "$SOAT_BASE_URL/api/v1/users/$DANA_ID/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"policy_ids\":[\"$POLICY_ID\"]}" | jq .

DANA_TOKEN=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/users/login" \
  -H "Content-Type: application/json" \
  -d '{"username":"dana-tags","password":"Dana1234!"}' | jq -r '.token')
```

</TabItem>
</Tabs>

---

## Step 5 — The listing narrows

Dana asks for the whole project and gets one document. The condition compiled into the SQL query — the finance row is never read, so there is nothing to filter client-side ([IAM — Tags](/docs/modules/iam#tags)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SOAT_TOKEN="$DANA_TOKEN" soat list-documents --project-id "$PROJECT_ID" \
  | jq -e --arg eng "$ENG_DOC_ID" --arg fin "$FINANCE_DOC_ID" \
      '[.data[].id] as $ids | ($ids | index($eng)) != null and ($ids | index($fin)) == null'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: visible } = await danaSoat.documents.listDocuments({
  query: { project_id: PROJECT_ID },
});

console.log(visible.data.map((d) => d.id)); // [ENG_DOC_ID]
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -G "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $DANA_TOKEN" \
  --data-urlencode "project_id=$PROJECT_ID" \
  | jq '[.data[].id]'
```

</TabItem>
</Tabs>

---

## Step 6 — Semantic search narrows the same way

This is the step that matters. The query below is deliberately about **both** documents. As admin it retrieves both; as Dana the finance chunk is not in the candidate set at all, because the same condition compiled into the vector query ([Knowledge](/docs/modules/knowledge)).

Retrieval that filters after ranking leaks: the excluded document still consumes result slots and still reaches whatever ranks them. Here it is never a candidate.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
QUESTION="what should I know about the on-call rotation and the payroll date"

# Admin sees both documents — the finance chunk is indexed and reachable
soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "$QUESTION" \
  --limit 10 \
  | jq -e --arg eng "$ENG_DOC_ID" --arg fin "$FINANCE_DOC_ID" \
      '[.results[].document_id] as $ids | ($ids | index($eng)) != null and ($ids | index($fin)) != null'

# Dana, same query, same project — only the eng chunk comes back
SOAT_TOKEN="$DANA_TOKEN" soat search-knowledge \
  --project-id "$PROJECT_ID" \
  --query "$QUESTION" \
  --limit 10 \
  | jq -e --arg eng "$ENG_DOC_ID" --arg fin "$FINANCE_DOC_ID" \
      '[.results[].document_id] as $ids | ($ids | index($eng)) != null and ($ids | index($fin)) == null'
```

The two assertions are a pair: the first proves the finance document is in the index and matches the query, so its absence from the second is the policy and not the ranking.

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const QUESTION =
  'what should I know about the on-call rotation and the payroll date';

const { data: asAdmin } = await adminSoat.knowledge.searchKnowledge({
  body: { project_id: PROJECT_ID, query: QUESTION, limit: 10 },
});

// Both — the finance chunk is indexed and matches the query
console.log(asAdmin.results.map((r) => r.document_id));

const { data: asDana } = await danaSoat.knowledge.searchKnowledge({
  body: { project_id: PROJECT_ID, query: QUESTION, limit: 10 },
});

// Only ENG_DOC_ID — the condition compiled into the vector query
console.log(asDana.results.map((r) => r.document_id));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
QUESTION="what should I know about the on-call rotation and the payroll date"

# Admin — both documents
curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"$QUESTION\",\"limit\":10}" \
  | jq '[.results[].document_id] | unique'

# Dana — only the eng document
curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
  -H "Authorization: Bearer $DANA_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"$QUESTION\",\"limit\":10}" \
  | jq '[.results[].document_id] | unique'
```

</TabItem>
</Tabs>

---

## Step 7 — A misspelled condition key is refused at write time

`soat:ResourceType` and `soat:ResourceTag/<key>` are the only keys the platform supplies. A key it never supplies can never match, so a `Deny` carrying a typo would silently stop denying — a fail-open produced by a plural. [`POST /api/v1/policies`](/docs/api/policies/create-policy) rejects it with `400 VALIDATION_FAILED` instead ([IAM — Condition Keys](/docs/modules/iam#condition-keys)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat create-policy \
  --name "typo-condition-key" \
  --description "Rejected: ResourceTags is not a condition key" \
  --document '{
    "statement": [
      {
        "effect": "Deny",
        "action": ["documents:ListDocuments"],
        "resource": ["srn:'"$PROJECT_ID"':*:*"],
        "condition": {
          "StringEquals": { "soat:ResourceTags/team": "finance" }
        }
      }
    ]
  }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error: typoErr } = await adminSoat.policies.createPolicy({
  body: {
    name: 'typo-condition-key',
    description: 'Rejected: ResourceTags is not a condition key',
    document: {
      statement: [
        {
          effect: 'Deny',
          action: ['documents:ListDocuments'],
          resource: [`srn:${PROJECT_ID}:*:*`],
          // Plural — not a key the platform supplies
          condition: {
            StringEquals: { 'soat:ResourceTags/team': 'finance' },
          },
        },
      ],
    },
  },
});

console.log(typoErr?.status); // 400
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -o /dev/null -w "%{http_code}\n" \
  -X POST "$SOAT_BASE_URL/api/v1/policies" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"typo-condition-key\",
    \"description\": \"Rejected: ResourceTags is not a condition key\",
    \"document\": {
      \"statement\": [
        {
          \"effect\": \"Deny\",
          \"action\": [\"documents:ListDocuments\"],
          \"resource\": [\"srn:${PROJECT_ID}:*:*\"],
          \"condition\": {
            \"StringEquals\": {\"soat:ResourceTags/team\": \"finance\"}
          }
        }
      ]
    }
  }"
```

</TabItem>
</Tabs>

---

## What this buys you

One tag bag, read three ways: `?tags=` filtered the listing, the same pairs scoped the knowledge search, and `soat:ResourceTag/team` decided authorization — all reading the same column, with the same exact-match rule. Tag a resource and every surface already knows what to do with it.

The scope of a policy is then a property of the data, not a list of IDs: onboard a team by tagging its documents, and revoke by retagging.

Tags work the same way on actors, conversations, files and sessions ([IAM — Tags](/docs/modules/iam#tags)). Memories and memory entries store and filter tags today but do not yet evaluate them in policy conditions — tracked in [#1279](https://github.com/ttoss/soat/issues/1279).

## Next steps

- [IAM — Tags](/docs/modules/iam#tags) — the condition keys, operators, and which resources honor them.
- [Permissions in Practice](./permissions.md) — users, policies, API keys and the intersection rule.
- [Knowledge](/docs/modules/knowledge) — the other filters search accepts.
