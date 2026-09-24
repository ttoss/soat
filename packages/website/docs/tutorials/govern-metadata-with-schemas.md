---
description: "Declare what a document's metadata must contain under a path prefix, watch a bad write be refused, and check a batch before sending it."
keywords:
  - metadata schema
  - JSON Schema
  - structured metadata
  - document governance
  - single source of truth
sidebar_position: 30
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Govern Metadata with Schemas

`metadata` is a free bag: whatever a writer attaches is what the next reader gets. In a corpus several agents and people write into, that is how one writer's `quarter` becomes another's `period`, and the reader finds out at query time.

A [metadata schema](/docs/modules/metadata-schemas) states the structure where every writer sees it. This tutorial declares one for `/reports`, watches a bad write be refused, checks a batch before sending it, and narrows the rule for one corner of the corpus.

By the end you will have:

| What | Why it matters |
|---|---|
| A declaration governing `/reports` | Every writer is judged against one rule, whichever door they came through |
| A refused write | The corpus cannot acquire a document that violates it |
| A dry run | A batch importer learns what it would be told, before sending anything |
| A nested declaration | One corner of the corpus can be different without loosening the rest |

## Prerequisites

- SOAT running locally at `http://localhost:5047` ([Quick Start](/docs/getting-started)).
- `jq` on your `PATH`.
- [Key Concepts](/docs/getting-started/concepts) for projects, documents and the admin credential.
- [Documents](/docs/modules/documents) for the `path` model this builds on.

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

A declaration is project-scoped: it governs writes into the [project](/docs/modules/projects) it belongs to and nothing else.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN

PROJECT_ID=$(soat create-project --name "Quarterly Reports" | jq -r '.id')
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
  await adminSoat.projects.createProject({ body: { name: 'Quarterly Reports' } });

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
  -d '{"name":"Quarterly Reports"}' | jq -r '.id')

echo "project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 2 — Declare what a report must carry

The declaration names three things: the `resource_type` it governs, the selector that type is addressed by, and the schema itself. A document is selected by `path_prefix`, because a path is what a document is filed under.

`/reports` is matched on a **path boundary**: it covers `/reports/q1.txt` and never `/reports-archive/q1.txt`.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
REPORT_SCHEMA_ID=$(soat create-metadata-schema \
  --project-id "$PROJECT_ID" \
  --resource-type document \
  --path-prefix /reports \
  --schema '{"type":"object","required":["quarter","owner"],"properties":{"quarter":{"type":"string","enum":["Q1","Q2","Q3","Q4"]},"owner":{"type":"string","minLength":1}}}' \
  | jq -r '.id')

echo "schema: $REPORT_SCHEMA_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: reportSchema, error: schemaErr } =
  await adminSoat.metadataSchemas.createMetadataSchema({
    body: {
      project_id: PROJECT_ID,
      resource_type: 'document',
      path_prefix: '/reports',
      schema: {
        type: 'object',
        required: ['quarter', 'owner'],
        properties: {
          quarter: { type: 'string', enum: ['Q1', 'Q2', 'Q3', 'Q4'] },
          owner: { type: 'string', minLength: 1 },
        },
      },
    },
  });

if (schemaErr) throw new Error(JSON.stringify(schemaErr));

const REPORT_SCHEMA_ID = reportSchema.id; // mdschema_…
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
REPORT_SCHEMA_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/metadata-schemas" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"resource_type\":\"document\",\"path_prefix\":\"/reports\",\"schema\":{\"type\":\"object\",\"required\":[\"quarter\",\"owner\"],\"properties\":{\"quarter\":{\"type\":\"string\",\"enum\":[\"Q1\",\"Q2\",\"Q3\",\"Q4\"]},\"owner\":{\"type\":\"string\",\"minLength\":1}}}}" \
  | jq -r '.id')

echo "schema: $REPORT_SCHEMA_ID"
```

</TabItem>
</Tabs>

The schema is compiled as it is stored, so one JSON Schema cannot parse is refused here rather than kept as a rule that silently governs nothing.

---

## Step 3 — Write a report that satisfies it

Nothing about the write changes: the declaration is enforced inside [`POST /api/v1/documents`](/docs/api/documents/create-document), not by anything the caller has to remember to call.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-document \
  --project-id "$PROJECT_ID" \
  --path /reports/q1.txt \
  --content "Revenue grew 12% quarter over quarter." \
  --metadata '{"quarter":"Q1","owner":"finance"}' | jq '{id, path, metadata}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: q1, error: q1Err } = await adminSoat.documents.createDocument({
  body: {
    project_id: PROJECT_ID,
    path: '/reports/q1.txt',
    content: 'Revenue grew 12% quarter over quarter.',
    metadata: { quarter: 'Q1', owner: 'finance' },
  },
});

if (q1Err) throw new Error(JSON.stringify(q1Err));

console.log(q1.id, q1.metadata);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/reports/q1.txt\",\"content\":\"Revenue grew 12% quarter over quarter.\",\"metadata\":{\"quarter\":\"Q1\",\"owner\":\"finance\"}}" \
  | jq '{id, path, metadata}'
```

</TabItem>
</Tabs>

---

## Step 4 — Watch a bad write be refused

A misspelled quarter and a missing owner. The refusal names the declaration that produced it, so a writer knows which rule to read rather than guessing which of its fields was wrong.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → expect-fail
soat create-document \
  --project-id "$PROJECT_ID" \
  --path /reports/q2.txt \
  --content "Revenue was flat." \
  --metadata '{"quarter":"Quarter 2"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error: refused } = await adminSoat.documents.createDocument({
  body: {
    project_id: PROJECT_ID,
    path: '/reports/q2.txt',
    content: 'Revenue was flat.',
    metadata: { quarter: 'Quarter 2' },
  },
});

// VALIDATION_FAILED, with meta.metadata_schema_id naming the declaration
console.log(refused);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/reports/q2.txt\",\"content\":\"Revenue was flat.\",\"metadata\":{\"quarter\":\"Quarter 2\"}}" \
  | jq '.error | {code, message, meta}'
```

</TabItem>
</Tabs>

```json
{
  "code": "VALIDATION_FAILED",
  "message": "metadata does not satisfy the schema declared for '/reports': (root) must have required property 'owner'; /quarter must be equal to one of the allowed values",
  "meta": {
    "metadata_schema_id": "mdschema_V1StGXR8Z5jdHi6B",
    "resource_type": "document",
    "path_prefix": "/reports"
  }
}
```

Two more things this refuses, for the same reason:

- **Clearing the bag.** `"metadata": null` on [`PATCH /api/v1/documents/{document_id}`](/docs/api/documents/update-document) is a write of the metadata, so a `required` field refuses it.
- **Moving a document in.** Repathing a document into `/reports` is judged against `/reports`, because the move is what changed which rule applies.

A document that carries **no** metadata is judged as carrying an empty bag, so under `/reports` it is refused for the missing `quarter`. [`POST /api/v1/documents/ingest`](/docs/api/documents/ingest-document) carries no bag at all: the document it files is judged when metadata is first written to it.

---

## Step 5 — Check a batch before sending it

An importer with a thousand rows wants to know what it would be told, without writing anything. [`POST /api/v1/metadata-schemas/validate`](/docs/api/metadata-schemas/validate-metadata) answers exactly that: which declaration governs the path, and what the bag violates.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat validate-metadata \
  --project-id "$PROJECT_ID" \
  --path /reports/q3.txt \
  --metadata '{"quarter":"Q3"}' | jq
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: verdict, error: verdictErr } =
  await adminSoat.metadataSchemas.validateMetadata({
    body: {
      project_id: PROJECT_ID,
      path: '/reports/q3.txt',
      metadata: { quarter: 'Q3' },
    },
  });

if (verdictErr) throw new Error(JSON.stringify(verdictErr));

console.log(verdict.valid, verdict.error);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/metadata-schemas/validate" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/reports/q3.txt\",\"metadata\":{\"quarter\":\"Q3\"}}" | jq
```

</TabItem>
</Tabs>

```json
{
  "valid": false,
  "resource_type": "document",
  "metadata_schema_id": "mdschema_V1StGXR8Z5jdHi6B",
  "path_prefix": "/reports",
  "error": "(root) must have required property 'owner'"
}
```

It reports and refuses nothing. The enforcement stays in the document write path, because a check a writer has to call is advisory — and the writer who skips it is the one the rule exists for.

---

## Step 6 — Make one corner of the corpus different

Legal reports carry a reviewing counsel that ordinary reports do not. Declare a second schema for the nested prefix: **the longest matching prefix decides, and it decides alone** ([Metadata Schemas — a declaration is a row](/docs/modules/metadata-schemas#a-declaration-is-a-row)). A nested declaration replaces the outer rule rather than adding to it, which is what lets this corner differ instead of only ever being stricter.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-metadata-schema \
  --project-id "$PROJECT_ID" \
  --resource-type document \
  --path-prefix /reports/legal \
  --schema '{"type":"object","required":["counsel"],"properties":{"counsel":{"type":"string","minLength":1}}}' \
  | jq '{id, path_prefix}'

# Governed by /reports/legal, so `counsel` alone is enough — `owner` is the
# outer rule's requirement and the outer rule does not apply here.
soat create-document \
  --project-id "$PROJECT_ID" \
  --path /reports/legal/q1-review.txt \
  --content "No material litigation exposure this quarter." \
  --metadata '{"counsel":"external"}' | jq '{path, metadata}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error: legalErr } =
  await adminSoat.metadataSchemas.createMetadataSchema({
    body: {
      project_id: PROJECT_ID,
      resource_type: 'document',
      path_prefix: '/reports/legal',
      schema: {
        type: 'object',
        required: ['counsel'],
        properties: { counsel: { type: 'string', minLength: 1 } },
      },
    },
  });

if (legalErr) throw new Error(JSON.stringify(legalErr));

const { data: review, error: reviewErr } =
  await adminSoat.documents.createDocument({
    body: {
      project_id: PROJECT_ID,
      path: '/reports/legal/q1-review.txt',
      content: 'No material litigation exposure this quarter.',
      metadata: { counsel: 'external' },
    },
  });

if (reviewErr) throw new Error(JSON.stringify(reviewErr));

console.log(review.metadata);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/metadata-schemas" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"resource_type\":\"document\",\"path_prefix\":\"/reports/legal\",\"schema\":{\"type\":\"object\",\"required\":[\"counsel\"],\"properties\":{\"counsel\":{\"type\":\"string\",\"minLength\":1}}}}" \
  | jq '{id, path_prefix}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/reports/legal/q1-review.txt\",\"content\":\"No material litigation exposure this quarter.\",\"metadata\":{\"counsel\":\"external\"}}" \
  | jq '{path, metadata}'
```

</TabItem>
</Tabs>

---

## Step 7 — Tighten the rule without touching what is stored

Reports now need a `published_at`. Replace the schema on the existing declaration with [`PATCH /api/v1/metadata-schemas/{metadata_schema_id}`](/docs/api/metadata-schemas/update-metadata-schema): the **next** write of the fields it governs is judged against it, and the documents already stored are left alone.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-metadata-schema \
  --metadata-schema-id "$REPORT_SCHEMA_ID" \
  --schema '{"type":"object","required":["quarter","owner","published_at"],"properties":{"quarter":{"type":"string","enum":["Q1","Q2","Q3","Q4"]},"owner":{"type":"string","minLength":1},"published_at":{"type":"string"}}}' \
  | jq '{id, path_prefix}'

# The Q1 report stored in Step 3 still reads back exactly as written.
soat list-documents --project-id "$PROJECT_ID" --path-prefix /reports \
  | jq '[.data[] | {path, metadata}]'

# A new report without the new field is refused.
# → expect-fail
soat create-document \
  --project-id "$PROJECT_ID" \
  --path /reports/q4.txt \
  --content "Revenue grew 4%." \
  --metadata '{"quarter":"Q4","owner":"finance"}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error: tightenErr } =
  await adminSoat.metadataSchemas.updateMetadataSchema({
    path: { metadata_schema_id: REPORT_SCHEMA_ID },
    body: {
      schema: {
        type: 'object',
        required: ['quarter', 'owner', 'published_at'],
        properties: {
          quarter: { type: 'string', enum: ['Q1', 'Q2', 'Q3', 'Q4'] },
          owner: { type: 'string', minLength: 1 },
          published_at: { type: 'string' },
        },
      },
    },
  });

if (tightenErr) throw new Error(JSON.stringify(tightenErr));

const { error: q4Err } = await adminSoat.documents.createDocument({
  body: {
    project_id: PROJECT_ID,
    path: '/reports/q4.txt',
    content: 'Revenue grew 4%.',
    metadata: { quarter: 'Q4', owner: 'finance' },
  },
});

// VALIDATION_FAILED: published_at is required now.
console.log(q4Err);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/metadata-schemas/$REPORT_SCHEMA_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"schema":{"type":"object","required":["quarter","owner","published_at"],"properties":{"quarter":{"type":"string","enum":["Q1","Q2","Q3","Q4"]},"owner":{"type":"string","minLength":1},"published_at":{"type":"string"}}}}' \
  | jq '{id, path_prefix}'

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/reports/q4.txt\",\"content\":\"Revenue grew 4%.\",\"metadata\":{\"quarter\":\"Q4\",\"owner\":\"finance\"}}" \
  | jq '.error.code'
```

</TabItem>
</Tabs>

---

## Step 8 — Read the contract, and stop enforcing it

[`GET /api/v1/metadata-schemas`](/docs/api/metadata-schemas/list-metadata-schemas) is what a new writer reads to learn what the project expects. Deleting a declaration stops governing new writes; the documents already stored keep the metadata they hold, because the rule governed writes rather than rows.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-metadata-schemas --project-id "$PROJECT_ID" \
  | jq '[.data[] | {resource_type, path_prefix, required: .schema.required}]'

soat delete-metadata-schema --metadata-schema-id "$REPORT_SCHEMA_ID"

# Free again: /reports/legal still has its own rule, /reports has none.
soat create-document \
  --project-id "$PROJECT_ID" \
  --path /reports/q4.txt \
  --content "Revenue grew 4%." \
  --metadata '{"quarter":"Q4"}' | jq '{path, metadata}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: declared, error: listErr } =
  await adminSoat.metadataSchemas.listMetadataSchemas({
    query: { project_id: PROJECT_ID },
  });

if (listErr) throw new Error(JSON.stringify(listErr));

console.log(declared.data.map((d) => [d.path_prefix, d.schema]));

await adminSoat.metadataSchemas.deleteMetadataSchema({
  path: { metadata_schema_id: REPORT_SCHEMA_ID },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/metadata-schemas?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  | jq '[.data[] | {resource_type, path_prefix}]'

curl -s -X DELETE "$SOAT_BASE_URL/api/v1/metadata-schemas/$REPORT_SCHEMA_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -o /dev/null -w '%{http_code}\n'

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/reports/q4.txt\",\"content\":\"Revenue grew 4%.\",\"metadata\":{\"quarter\":\"Q4\"}}" \
  | jq '{path, metadata}'
```

</TabItem>
</Tabs>

---

## What you built

A corpus whose structure is stated once and enforced everywhere it is written:

| Rule | Where it holds |
|---|---|
| A prefix is a path boundary | `/reports` covers `/reports/q1.txt`, never `/reports-archive/q1.txt` |
| The longest matching prefix decides, alone | `/reports/legal` replaces `/reports` for what it covers |
| No bag is an empty bag | A create without metadata and a clearing `null` are both judged as `{}` |
| Tightening applies forward | Stored documents are untouched; the next write of those fields is judged |
| The check is not the enforcement | `validate` reports; the document write path refuses |

The same declaration governs a `document` resource in a [formation](/docs/modules/formations), so a template can ship a corpus and the rule governing it together.

Today `document` is the resource type the registry enforces. A type joins it in the change that gives its write path the same gate — the declaration's shape does not change, only which selector it carries.

## Next steps

- [Metadata Schemas](/docs/modules/metadata-schemas) — the module reference.
- [Documents — Metadata schemas](/docs/modules/documents#metadata-schemas) — how the gate reads on the document side.
- [Tag-Based Access Control](./tag-based-access-control.md) — tags govern *who may see* a document; a metadata schema governs *what it must say*.
