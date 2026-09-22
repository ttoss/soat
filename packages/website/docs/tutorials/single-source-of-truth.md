---
description: 'Let two writers edit one report without a lost update, read the version a run cited, withdraw and restore a document, retract a fact, relate two reports and export the corpus.'
keywords:
  - single source of truth
  - optimistic concurrency
  - document versioning
  - memory retraction
  - document relations
  - NDJSON export
sidebar_position: 31
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Single Source of Truth

Several agents write reports into one project and read each other's. Two of them edit the same report at once, one report is produced from another, a fact stops holding, and at the end the corpus has to leave as a file. This tutorial runs that sequence against one project and shows what the record keeps of each step.

[Govern Metadata with Schemas](./govern-metadata-with-schemas.md) covers what a report must say. This tutorial covers what happens to it afterwards. The map of every mechanism is [Single Source of Truth](/docs/advanced/single-source-of-truth).

By the end you will have:

| What                                                             | Why it matters                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A report at version 4 with every earlier state readable          | A run can cite the version it read, and a reader can fetch exactly that        |
| One write refused with `409 VERSION_CONFLICT`                    | The second writer learns it is stale instead of silently overwriting the first |
| A withdrawn document brought back by restoring a version         | Removal keeps the history; `DELETE` is the only permanent operation            |
| A retracted memory and the assertion that records who retired it | A fact leaves every read at once and the ledger says why                       |
| A `derived_from` edge between two reports                        | A reader can ask what a report was produced from                               |
| Two NDJSON files                                                 | The corpus as a file, in the shape the listings return                         |

## Prerequisites

- SOAT running locally at `http://localhost:5047` ([Quick Start](/docs/getting-started)).
- An embedding model configured (`EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`); documents and memories are embedded on write. See [Generating Embeddings](./embeddings.md).
- `jq` on your `PATH`.
- [Key Concepts](/docs/getting-started/concepts) for projects, documents and the admin credential.

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

Every record in this tutorial belongs to one [project](/docs/modules/projects): the documents, the memory store and the exports are all scoped to it.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN

PROJECT_ID=$(soat create-project --name "Shared Reports" | jq -r '.id')
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
  await adminSoat.projects.createProject({ body: { name: 'Shared Reports' } });

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
  -d '{"name":"Shared Reports"}' | jq -r '.id')

echo "project: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 2 — File the report and read its version

[`POST /api/v1/documents`](/docs/api/documents/create-document) files the report at `/reports/q1.txt`. Version 1 is written on create, and every later write that changes the content or its annotations increments it ([Documents — Versioning](/docs/modules/documents#versioning)). Two writers read the document now; both hold version 1.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
Q1_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --path /reports/q1.txt \
  --content "Q1 revenue grew 12% quarter over quarter." | jq -r '.id')

soat get-document --document-id "$Q1_ID" | jq '{id, path, version}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: q1, error: q1Err } = await adminSoat.documents.createDocument({
  body: {
    project_id: PROJECT_ID,
    path: '/reports/q1.txt',
    content: 'Q1 revenue grew 12% quarter over quarter.',
  },
});

if (q1Err) throw new Error(JSON.stringify(q1Err));

const Q1_ID = q1.id; // doc_…
console.log(q1.version); // 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
Q1_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/reports/q1.txt\",\"content\":\"Q1 revenue grew 12% quarter over quarter.\"}" \
  | jq -r '.id')

curl -s "$SOAT_BASE_URL/api/v1/documents/$Q1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, path, version}'
```

</TabItem>
</Tabs>

---

## Step 3 — The first writer states the version it read

A write may name the version it is changing with `expected_version` in the body, or an `If-Match` header carrying the same number ([Concurrent Writes](/docs/advanced/concurrent-writes)). The document is at version 1, so this write lands and the document moves to version 2.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat update-document \
  --document-id "$Q1_ID" \
  --expected-version 1 \
  --content "Q1 revenue grew 12% quarter over quarter. Churn fell to 2.1%." \
  | jq '{id, version}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: first, error: firstErr } =
  await adminSoat.documents.updateDocument({
    path: { document_id: Q1_ID },
    body: {
      expected_version: 1,
      content: 'Q1 revenue grew 12% quarter over quarter. Churn fell to 2.1%.',
    },
  });

if (firstErr) throw new Error(JSON.stringify(firstErr));

console.log(first.version); // 2
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/documents/$Q1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "If-Match: 1" \
  -H "Content-Type: application/json" \
  -d '{"content":"Q1 revenue grew 12% quarter over quarter. Churn fell to 2.1%."}' \
  | jq '{id, version}'
```

</TabItem>
</Tabs>

---

## Step 4 — The second writer is refused, re-reads, and lands

The second writer still holds version 1. Its write is refused whole with `409 VERSION_CONFLICT`, and `error.meta.current_version` tells it what the document is at now. It re-reads, states version 2, and lands as version 3. Nothing the first writer wrote is lost.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
# → 409
soat update-document \
  --document-id "$Q1_ID" \
  --expected-version 1 \
  --content "Q1 revenue grew 12% quarter over quarter. Headcount reached 48."

CURRENT=$(soat get-document --document-id "$Q1_ID" | jq -r '.version')

soat update-document \
  --document-id "$Q1_ID" \
  --expected-version "$CURRENT" \
  --content "Q1 revenue grew 12% quarter over quarter. Churn fell to 2.1%. Headcount reached 48." \
  | jq '{id, version}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { error: stale } = await adminSoat.documents.updateDocument({
  path: { document_id: Q1_ID },
  body: {
    expected_version: 1,
    content: 'Q1 revenue grew 12% quarter over quarter. Headcount reached 48.',
  },
});

console.log(stale?.error.code, stale?.error.meta); // VERSION_CONFLICT { expected_version: 1, current_version: 2 }

const { data: current } = await adminSoat.documents.getDocument({
  path: { document_id: Q1_ID },
});

const { data: second, error: secondErr } =
  await adminSoat.documents.updateDocument({
    path: { document_id: Q1_ID },
    body: {
      expected_version: current!.version,
      content:
        'Q1 revenue grew 12% quarter over quarter. Churn fell to 2.1%. Headcount reached 48.',
    },
  });

if (secondErr) throw new Error(JSON.stringify(secondErr));

console.log(second.version); // 3
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X PATCH "$SOAT_BASE_URL/api/v1/documents/$Q1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "If-Match: 1" \
  -H "Content-Type: application/json" \
  -d '{"content":"Q1 revenue grew 12% quarter over quarter. Headcount reached 48."}' \
  | jq '.error | {code, meta}'

CURRENT=$(curl -s "$SOAT_BASE_URL/api/v1/documents/$Q1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq -r '.version')

curl -s -X PATCH "$SOAT_BASE_URL/api/v1/documents/$Q1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "If-Match: $CURRENT" \
  -H "Content-Type: application/json" \
  -d '{"content":"Q1 revenue grew 12% quarter over quarter. Churn fell to 2.1%. Headcount reached 48."}' \
  | jq '{id, version}'
```

</TabItem>
</Tabs>

```json
{
  "code": "VERSION_CONFLICT",
  "meta": { "expected_version": 1, "current_version": 2 }
}
```

A write that states no version is still serialized against a concurrent one: the loser of the race gets the same `409`. Stating the version adds the case a request-scoped race cannot catch, a writer whose read is minutes old.

---

## Step 5 — Read what a run read, then restore it

[`GET /api/v1/documents/{document_id}/versions`](/docs/api/documents/list-document-versions) lists the archive newest first, and [`GET /api/v1/documents/{document_id}/versions/{version}`](/docs/api/documents/get-document-version) returns one state whole, `content` included. A run that cited version 1 resolves to the text it read, whatever has been written since.

[`POST /api/v1/documents/{document_id}/versions/{version}/restore`](/docs/api/documents/restore-document-version) writes version 1's state back as **version 4**. The counter never rewinds, so a run citing version 2 or 3 still resolves.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat list-document-versions --document-id "$Q1_ID" | jq '[.data[] | .version]'

soat get-document-version --document-id "$Q1_ID" --version 1 | jq '.config.content'

soat restore-document-version --document-id "$Q1_ID" --version 1 | jq '{version, status}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: versions } = await adminSoat.documents.listDocumentVersions({
  path: { document_id: Q1_ID },
});

console.log(versions!.data.map((v) => v.version)); // [3, 2, 1]

const { data: v1 } = await adminSoat.documents.getDocumentVersion({
  path: { document_id: Q1_ID, version: 1 },
});

console.log(v1!.config.content); // Q1 revenue grew 12% quarter over quarter.

const { data: restored, error: restoreErr } =
  await adminSoat.documents.restoreDocumentVersion({
    path: { document_id: Q1_ID, version: 1 },
  });

if (restoreErr) throw new Error(JSON.stringify(restoreErr));

console.log(restored.version); // 4
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/documents/$Q1_ID/versions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.data[] | .version]'

curl -s "$SOAT_BASE_URL/api/v1/documents/$Q1_ID/versions/1" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.config.content'

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/$Q1_ID/versions/1/restore" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{version, status}'
```

</TabItem>
</Tabs>

The restore runs through the ordinary update path, so the restored content is re-chunked and re-embedded, and a metadata schema declared since is applied to it like any other write.

---

## Step 6 — Withdraw the report, then bring it back

[`POST /api/v1/documents/{document_id}/withdraw`](/docs/api/documents/withdraw-document) takes the document out of every default read and archives the withdrawal as a tombstone version ([Documents — Withdrawal](/docs/modules/documents#withdrawal)). It leaves the listing and its chunks leave the index, so knowledge search never returns it. It stays readable by id, and `?include_withdrawn=true` shows it in the listing again.

Restoring any content version brings it back. The tombstone itself holds no content and cannot be restored.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat withdraw-document --document-id "$Q1_ID" | jq '{id, status, version}'

soat list-documents --project-id "$PROJECT_ID" --path-prefix /reports | jq '.total'

soat list-documents --project-id "$PROJECT_ID" --path-prefix /reports --include-withdrawn true \
  | jq '[.data[] | {path, status}]'

soat restore-document-version --document-id "$Q1_ID" --version 3 | jq '{status, version}'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: withdrawn, error: withdrawErr } =
  await adminSoat.documents.withdrawDocument({
    path: { document_id: Q1_ID },
    body: {},
  });

if (withdrawErr) throw new Error(JSON.stringify(withdrawErr));

console.log(withdrawn.status, withdrawn.version); // withdrawn 5

const { data: live } = await adminSoat.documents.listDocuments({
  query: { project_id: PROJECT_ID, path_prefix: '/reports' },
});

console.log(live!.total); // 0

const { data: all } = await adminSoat.documents.listDocuments({
  query: {
    project_id: PROJECT_ID,
    path_prefix: '/reports',
    include_withdrawn: true,
  },
});

console.log(all!.data.map((d) => d.status)); // ['withdrawn']

const { data: back, error: backErr } =
  await adminSoat.documents.restoreDocumentVersion({
    path: { document_id: Q1_ID, version: 3 },
  });

if (backErr) throw new Error(JSON.stringify(backErr));

console.log(back.status, back.version); // ready 6
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/$Q1_ID/withdraw" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{id, status, version}'

curl -s "$SOAT_BASE_URL/api/v1/documents?project_id=$PROJECT_ID&path_prefix=/reports" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '.total'

curl -s "$SOAT_BASE_URL/api/v1/documents?project_id=$PROJECT_ID&path_prefix=/reports&include_withdrawn=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.data[] | {path, status}]'

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/$Q1_ID/versions/3/restore" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, version}'
```

</TabItem>
</Tabs>

---

## Step 7 — Say what a report was produced from

A second agent writes a summary of the report. [`POST /api/v1/documents/{document_id}/relations`](/docs/api/documents/create-document-relation) asserts a typed edge from the summary to its source ([Documents — Relations](/docs/modules/documents#relations)). The edge is a write of the summary alone. `?related_to=` on the listing finds neighbours on either side of it.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
SUMMARY_ID=$(soat create-document \
  --project-id "$PROJECT_ID" \
  --path /reports/q1-summary.txt \
  --content "Q1: revenue up 12%, churn down, headcount 48." | jq -r '.id')

soat create-document-relation \
  --document-id "$SUMMARY_ID" \
  --type derived_from \
  --to-document-id "$Q1_ID" | jq '{type, from_document_id, to_document_id}'

soat list-documents --project-id "$PROJECT_ID" --related-to "$Q1_ID" | jq '[.data[] | .path]'

soat get-document --document-id "$SUMMARY_ID" | jq '.relations'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: summary, error: summaryErr } =
  await adminSoat.documents.createDocument({
    body: {
      project_id: PROJECT_ID,
      path: '/reports/q1-summary.txt',
      content: 'Q1: revenue up 12%, churn down, headcount 48.',
    },
  });

if (summaryErr) throw new Error(JSON.stringify(summaryErr));

const SUMMARY_ID = summary.id;

const { error: edgeErr } = await adminSoat.documents.createDocumentRelation({
  path: { document_id: SUMMARY_ID },
  body: { type: 'derived_from', to_document_id: Q1_ID },
});

if (edgeErr) throw new Error(JSON.stringify(edgeErr));

const { data: neighbours } = await adminSoat.documents.listDocuments({
  query: { project_id: PROJECT_ID, related_to: Q1_ID },
});

console.log(neighbours!.data.map((d) => d.path)); // ['/reports/q1-summary.txt']
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
SUMMARY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"/reports/q1-summary.txt\",\"content\":\"Q1: revenue up 12%, churn down, headcount 48.\"}" \
  | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/documents/$SUMMARY_ID/relations" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"derived_from\",\"to_document_id\":\"$Q1_ID\"}" \
  | jq '{type, from_document_id, to_document_id}'

curl -s "$SOAT_BASE_URL/api/v1/documents?project_id=$PROJECT_ID&related_to=$Q1_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.data[] | .path]'
```

</TabItem>
</Tabs>

Asserting the same edge twice is `409`, and both documents have to live in this project.

---

## Step 8 — Retract a fact

Facts live in a [memory store](/docs/modules/memories). One agent records that the Q1 report is final; a later review finds it is not. [`POST /api/v1/memories/{memory_id}/retract`](/docs/api/memories/retract-memory) retires the fact with nothing replacing it ([Memories — Retraction](/docs/modules/memories#retraction)): it leaves the listing, dedup and knowledge search at once, `invalidated_at` is set with `superseded_by_memory_id` null, and the [assertion ledger](/docs/modules/memories#assertions) gains a `retracted` line naming who withdrew it.

The retraction claims the memory's `version` like any other write, so it takes `expected_version` too.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
STORE_ID=$(soat create-memory-store --project-id "$PROJECT_ID" --name "report-facts" | jq -r '.id')

FACT_ID=$(soat create-memory \
  --memory-store-id "$STORE_ID" \
  --content "The Q1 report is final and approved for the board." | jq -r '.id')

soat retract-memory --memory-id "$FACT_ID" --expected-version 1 \
  | jq '{id, invalidated_at, superseded_by_memory_id, version}'

soat list-memories --memory-store-id "$STORE_ID" | jq '.total'

soat list-memories --memory-store-id "$STORE_ID" --include-invalidated true | jq '.total'

soat list-memory-assertions --memory-id "$FACT_ID" | jq '[.data[] | {outcome, mechanism, principal_type}]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: store, error: storeErr } =
  await adminSoat.memoryStores.createMemoryStore({
    body: { project_id: PROJECT_ID, name: 'report-facts' },
  });

if (storeErr) throw new Error(JSON.stringify(storeErr));

const STORE_ID = store.id;

const { data: fact, error: factErr } = await adminSoat.memories.createMemory({
  body: {
    memory_store_id: STORE_ID,
    content: 'The Q1 report is final and approved for the board.',
  },
});

if (factErr) throw new Error(JSON.stringify(factErr));

const FACT_ID = fact.id;

const { data: retracted, error: retractErr } =
  await adminSoat.memories.retractMemory({
    path: { memory_id: FACT_ID },
    body: { expected_version: 1 },
  });

if (retractErr) throw new Error(JSON.stringify(retractErr));

console.log(retracted.invalidated_at, retracted.superseded_by_memory_id); // <timestamp> null

const { data: assertions } = await adminSoat.memories.listMemoryAssertions({
  path: { memory_id: FACT_ID },
});

console.log(assertions!.data.map((a) => a.outcome)); // ['created', 'retracted']
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
STORE_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/memory-stores" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"report-facts\"}" | jq -r '.id')

FACT_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/memories" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"memory_store_id\":\"$STORE_ID\",\"content\":\"The Q1 report is final and approved for the board.\"}" \
  | jq -r '.id')

curl -s -X POST "$SOAT_BASE_URL/api/v1/memories/$FACT_ID/retract" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "If-Match: 1" | jq '{id, invalidated_at, superseded_by_memory_id, version}'

curl -s "$SOAT_BASE_URL/api/v1/memories/$FACT_ID/assertions" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '[.data[] | {outcome, mechanism, principal_type}]'
```

</TabItem>
</Tabs>

Restating the fact later lands as a new memory: dedup only ever matches a valid one. A memory that is already invalidated answers `409 MEMORY_ALREADY_INVALIDATED`.

---

## Step 9 — Export the corpus

[`GET /api/v1/documents/export`](/docs/api/documents/export-documents) and [`GET /api/v1/memory-stores/{memory_store_id}/export`](/docs/api/memory-stores/export-memories) stream newline-delimited JSON, oldest first, one object per line, in the shape the listings return for the same caller. The document export leaves withdrawn documents out; the memory export leaves retired facts out unless `include_invalidated=true`. Each is its own IAM action, separate from the listing.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat export-documents --project-id "$PROJECT_ID" > reports.ndjson
jq -c '{path, version}' reports.ndjson

soat export-memories --memory-store-id "$STORE_ID" --include-invalidated true > facts.ndjson
jq -c '{content, invalidated_at}' facts.ndjson
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: reports, error: reportsErr } =
  await adminSoat.documents.exportDocuments({
    query: { project_id: PROJECT_ID },
  });

if (reportsErr) throw new Error(JSON.stringify(reportsErr));

// `reports` is the raw NDJSON body — one document per line.
console.log(String(reports).trim().split('\n').length); // 2

const { data: facts } = await adminSoat.memoryStores.exportMemories({
  path: { memory_store_id: STORE_ID },
  query: { include_invalidated: true },
});

console.log(String(facts).trim().split('\n').length); // 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -s "$SOAT_BASE_URL/api/v1/documents/export?project_id=$PROJECT_ID" \
  -H "Authorization: Bearer $ADMIN_TOKEN" > reports.ndjson
jq -c '{path, version}' reports.ndjson

curl -s "$SOAT_BASE_URL/api/v1/memory-stores/$STORE_ID/export?include_invalidated=true" \
  -H "Authorization: Bearer $ADMIN_TOKEN" > facts.ndjson
jq -c '{content, invalidated_at}' facts.ndjson
```

</TabItem>
</Tabs>

Two rows in `reports.ndjson`: the report at version 6 and its summary. The tombstone and the archive are not rows; the file holds what the project currently asserts.

---

## What you built

| Rule                                             | Where it held                                                           |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| A stale write is refused whole                   | Step 4: `409 VERSION_CONFLICT` with `current_version`                   |
| Every past state is readable by version          | Step 5: version 1 read back after two later writes                      |
| Restore appends, never rewinds                   | Step 5: version 1 came back as version 4                                |
| Withdrawal is a version                          | Step 6: the tombstone, and a restore that brings the document back      |
| A fact leaves every read at once                 | Step 8: one retraction, one `invalidated_at`, one `retracted` assertion |
| An edge is owned by the document that asserts it | Step 7: writing the summary's relation left the report untouched        |
| The corpus is a file                             | Step 9: two exports in the listings' shape                              |

## Next steps

- [Single Source of Truth](/docs/advanced/single-source-of-truth) — every mechanism a shared record needs, and the module that provides it.
- [Concurrent Writes](/docs/advanced/concurrent-writes) — the precondition in full, including what happens when nobody states one.
- [Govern Metadata with Schemas](./govern-metadata-with-schemas.md) — what a report must say before it is accepted.
- [Automate a Flow with Triggers](./automate-a-flow-with-triggers.md) — react to `documents.updated`, `documents.withdrawn` and `memories.retracted` as they happen.
