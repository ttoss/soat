---
description: "Measure knowledge search on your own corpus with recall@k and MRR: build a golden set, run it through search-knowledge, read the per-slice table, and see what a ranking knob costs."
keywords:
  - retrieval quality
  - recall@k
  - mean reciprocal rank
  - RAG evaluation
  - knowledge search
sidebar_position: 9
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Measuring Retrieval Quality

[Knowledge search](/docs/modules/knowledge) ships three ranking knobs, `min_similarity`, `rrf_k` and `recency_half_life_days`, and none has a default that is right for every corpus. This tutorial builds the instrument that settles the question for yours: a golden set of queries with known answers, scored with recall@5, recall@10 and MRR over the ranked output of [`POST /api/v1/knowledge/search`](/docs/api/knowledge/search-knowledge).

The [Evaluations](/docs/modules/evaluations) module is not the tool for this: an `Eval` runs an agent per dataset item, so measuring a ranking through it costs one LLM generation per query and mixes model behaviour into the number. Retrieval is scored with a loop over the search endpoint and a few lines of arithmetic; no generation happens anywhere in this tutorial.

## Prerequisites

- SOAT running locally ([Quick Start](/docs/getting-started)); [Key Concepts](/docs/getting-started/concepts); [Configuration](/docs/self-hosting/configuration).
- An embedding provider configured, `EMBEDDING_PROVIDER` and `EMBEDDING_MODEL` ([Knowledge — Configuration](/docs/modules/knowledge#configuration)); [Generating Embeddings](/docs/tutorials/embeddings) shows the Ollama setup.
- `curl`, `jq`, and `node` available in your shell.

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

Obtain an admin token ([Users](/docs/modules/users#examples)) and a project to hold the corpus ([Projects](/docs/modules/projects)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
ADMIN_TOKEN=$(soat login-user --username admin --password Admin1234! | jq -r '.token')
export SOAT_TOKEN=$ADMIN_TOKEN
PROJECT_ID=$(soat create-project --name "Retrieval Quality" | jq -r '.id')
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
  body: { name: 'Retrieval Quality' },
});
const PROJECT_ID = project.id;
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
  -d '{"name":"Retrieval Quality"}' | jq -r '.id')
echo "PROJECT_ID: $PROJECT_ID"
```

</TabItem>
</Tabs>

---

## Step 2 — Seed the document corpus

Ten short handbook pages, each on one topic, written with [`POST /api/v1/documents`](/docs/api/documents/create-document), which indexes a text document before it answers, so every page is `ready` before the first search ([Documents](/docs/modules/documents)). A useful golden set needs candidates that compete: pages on nearby topics (on-call, severity, escalation) are what make the ranks non-trivial.

Keep the ids. The golden set names its expected answers by `document_id`, which is what the search response returns.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
DOC_ONCALL=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/on-call.txt" \
  --content "On-call rotation: engineers rotate weekly. The pager is held by the primary on-call; if they do not acknowledge within 15 minutes the secondary is paged. Production outages at night go to the pager, never to email or chat." | jq -r '.id')
DOC_SEVERITY=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/incident-severity.txt" \
  --content "Incident severity: SEV1 is a full outage or data loss affecting all customers. SEV2 is degraded service for a subset of customers. SEV3 is a cosmetic or single-user issue. Only SEV1 and SEV2 trigger an incident call." | jq -r '.id')
DOC_ESCALATION=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/escalation.txt" \
  --content "Escalation path: the incident commander escalates to the engineering manager after 30 minutes without a mitigation, and to the VP of Engineering for any SEV1 lasting more than two hours." | jq -r '.id')
DOC_FREEZE=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/deploy-freeze.txt" \
  --content "Deploy freeze: no production releases from December 20 to January 3 and during the last two business days of each quarter. Hotfixes for SEV1 incidents are exempt with manager approval." | jq -r '.id')
DOC_BACKUPS=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/database-backups.txt" \
  --content "Database backups: a full snapshot runs nightly at 02:00 UTC and is retained for 35 days. A restore drill into a scratch cluster runs on the first Tuesday of every month and its duration is recorded." | jq -r '.id')
DOC_REVIEW=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/code-review.txt" \
  --content "Code review: every change needs two approvals and a green CI run before merge. Reviewers respond within one business day. Force pushes to shared branches are forbidden." | jq -r '.id')
DOC_VPN=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/vpn-access.txt" \
  --content "VPN access: install the company VPN client, enrol a hardware security key for multi-factor authentication, and request the staging network group from IT. Access is reviewed quarterly." | jq -r '.id')
DOC_EXPENSES=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/expenses.txt" \
  --content "Expense policy: submit receipts within 30 days. Meals are reimbursed up to 60 USD per day while travelling. Flights over six hours may be booked in premium economy." | jq -r '.id')
DOC_LAPTOPS=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/laptops.txt" \
  --content "Laptop refresh: hardware is replaced every three years. Request a replacement through the IT portal; disk encryption and the device management agent are mandatory on every machine." | jq -r '.id')
DOC_TIMEOFF=$(soat create-document --project-id "$PROJECT_ID" --path "/handbook/time-off.txt" \
  --content "Time off: 25 days of paid leave per year, requested at least two weeks ahead. Unused days carry over up to five. Public holidays follow the office country." | jq -r '.id')
soat get-document-status --document-id "$DOC_ONCALL" | jq '{status, chunk_count}'
```

Expected output (each page is one chunk):

```json
{ "status": "ready", "chunk_count": 1 }
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const pages = {
  DOC_ONCALL: ['/handbook/on-call.txt', 'On-call rotation: engineers rotate weekly. The pager is held by the primary on-call; if they do not acknowledge within 15 minutes the secondary is paged. Production outages at night go to the pager, never to email or chat.'],
  DOC_SEVERITY: ['/handbook/incident-severity.txt', 'Incident severity: SEV1 is a full outage or data loss affecting all customers. SEV2 is degraded service for a subset of customers. SEV3 is a cosmetic or single-user issue. Only SEV1 and SEV2 trigger an incident call.'],
  DOC_ESCALATION: ['/handbook/escalation.txt', 'Escalation path: the incident commander escalates to the engineering manager after 30 minutes without a mitigation, and to the VP of Engineering for any SEV1 lasting more than two hours.'],
  DOC_FREEZE: ['/handbook/deploy-freeze.txt', 'Deploy freeze: no production releases from December 20 to January 3 and during the last two business days of each quarter. Hotfixes for SEV1 incidents are exempt with manager approval.'],
  DOC_BACKUPS: ['/handbook/database-backups.txt', 'Database backups: a full snapshot runs nightly at 02:00 UTC and is retained for 35 days. A restore drill into a scratch cluster runs on the first Tuesday of every month and its duration is recorded.'],
  DOC_REVIEW: ['/handbook/code-review.txt', 'Code review: every change needs two approvals and a green CI run before merge. Reviewers respond within one business day. Force pushes to shared branches are forbidden.'],
  DOC_VPN: ['/handbook/vpn-access.txt', 'VPN access: install the company VPN client, enrol a hardware security key for multi-factor authentication, and request the staging network group from IT. Access is reviewed quarterly.'],
  DOC_EXPENSES: ['/handbook/expenses.txt', 'Expense policy: submit receipts within 30 days. Meals are reimbursed up to 60 USD per day while travelling. Flights over six hours may be booked in premium economy.'],
  DOC_LAPTOPS: ['/handbook/laptops.txt', 'Laptop refresh: hardware is replaced every three years. Request a replacement through the IT portal; disk encryption and the device management agent are mandatory on every machine.'],
  DOC_TIMEOFF: ['/handbook/time-off.txt', 'Time off: 25 days of paid leave per year, requested at least two weeks ahead. Unused days carry over up to five. Public holidays follow the office country.'],
};

const docIds: Record<string, string> = {};
for (const [key, [path, content]] of Object.entries(pages)) {
  const { data: doc } = await adminSoat.documents.createDocument({
    body: { project_id: PROJECT_ID, path, content },
  });
  docIds[key] = doc.id;
}

const { data: status } = await adminSoat.documents.getDocumentStatus({
  path: { document_id: docIds.DOC_ONCALL },
});
console.log(status.status, status.chunk_count); // "ready" 1
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
create_page() {
  curl -s -X POST "$SOAT_BASE_URL/api/v1/documents" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"project_id\":\"$PROJECT_ID\",\"path\":\"$1\",\"content\":\"$2\"}" | jq -r '.id'
}
DOC_ONCALL=$(create_page "/handbook/on-call.txt" "On-call rotation: engineers rotate weekly. The pager is held by the primary on-call; if they do not acknowledge within 15 minutes the secondary is paged. Production outages at night go to the pager, never to email or chat.")
DOC_SEVERITY=$(create_page "/handbook/incident-severity.txt" "Incident severity: SEV1 is a full outage or data loss affecting all customers. SEV2 is degraded service for a subset of customers. SEV3 is a cosmetic or single-user issue. Only SEV1 and SEV2 trigger an incident call.")
DOC_ESCALATION=$(create_page "/handbook/escalation.txt" "Escalation path: the incident commander escalates to the engineering manager after 30 minutes without a mitigation, and to the VP of Engineering for any SEV1 lasting more than two hours.")
DOC_FREEZE=$(create_page "/handbook/deploy-freeze.txt" "Deploy freeze: no production releases from December 20 to January 3 and during the last two business days of each quarter. Hotfixes for SEV1 incidents are exempt with manager approval.")
DOC_BACKUPS=$(create_page "/handbook/database-backups.txt" "Database backups: a full snapshot runs nightly at 02:00 UTC and is retained for 35 days. A restore drill into a scratch cluster runs on the first Tuesday of every month and its duration is recorded.")
DOC_REVIEW=$(create_page "/handbook/code-review.txt" "Code review: every change needs two approvals and a green CI run before merge. Reviewers respond within one business day. Force pushes to shared branches are forbidden.")
DOC_VPN=$(create_page "/handbook/vpn-access.txt" "VPN access: install the company VPN client, enrol a hardware security key for multi-factor authentication, and request the staging network group from IT. Access is reviewed quarterly.")
DOC_EXPENSES=$(create_page "/handbook/expenses.txt" "Expense policy: submit receipts within 30 days. Meals are reimbursed up to 60 USD per day while travelling. Flights over six hours may be booked in premium economy.")
DOC_LAPTOPS=$(create_page "/handbook/laptops.txt" "Laptop refresh: hardware is replaced every three years. Request a replacement through the IT portal; disk encryption and the device management agent are mandatory on every machine.")
DOC_TIMEOFF=$(create_page "/handbook/time-off.txt" "Time off: 25 days of paid leave per year, requested at least two weeks ahead. Unused days carry over up to five. Public holidays follow the office country.")
curl -s "$SOAT_BASE_URL/api/v1/documents/$DOC_ONCALL/status" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | jq '{status, chunk_count}'
```

</TabItem>
</Tabs>

---

## Step 3 — Seed a memory store

A [memory store](/docs/modules/memories) with five memories. Memory results share the result list with document chunks, so a golden set that has only document queries cannot see a change that only moves memories; the recency blend in [Step 7](#step-7--read-a-knob-off-the-table) is exactly such a change.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
MEMORY_ID=$(soat create-memory-store --project-id "$PROJECT_ID" --name "Team Facts" \
  --description "Facts about teams, owners and dates" | jq -r '.id')
ENTRY_PAYMENTS=$(soat create-memory --memory-store-id "$MEMORY_ID" \
  --content "The payments service is owned by the Orion team; their on-call lead is Priya." | jq -r '.id')
ENTRY_CREDS=$(soat create-memory --memory-store-id "$MEMORY_ID" \
  --content "Staging database credentials rotate on the first Monday of each month." | jq -r '.id')
ENTRY_OFFSITE=$(soat create-memory --memory-store-id "$MEMORY_ID" \
  --content "The Q3 planning offsite is in Lisbon during the second week of October." | jq -r '.id')
ENTRY_ACME=$(soat create-memory --memory-store-id "$MEMORY_ID" \
  --content "Customer Acme requires a four-hour response SLA on SEV1 incidents." | jq -r '.id')
ENTRY_SEARCH=$(soat create-memory --memory-store-id "$MEMORY_ID" \
  --content "The search index is rebuilt every Sunday night by the Data Platform team." | jq -r '.id')
echo "MEMORY_ID: $MEMORY_ID"
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data: memoryStore } = await adminSoat.memoryStores.createMemoryStore({
  body: {
    project_id: PROJECT_ID,
    name: 'Team Facts',
    description: 'Facts about teams, owners and dates',
  },
});
const MEMORY_ID = memoryStore.id;

const facts = {
  ENTRY_PAYMENTS: 'The payments service is owned by the Orion team; their on-call lead is Priya.',
  ENTRY_CREDS: 'Staging database credentials rotate on the first Monday of each month.',
  ENTRY_OFFSITE: 'The Q3 planning offsite is in Lisbon during the second week of October.',
  ENTRY_ACME: 'Customer Acme requires a four-hour response SLA on SEV1 incidents.',
  ENTRY_SEARCH: 'The search index is rebuilt every Sunday night by the Data Platform team.',
};

const entryIds: Record<string, string> = {};
for (const [key, content] of Object.entries(facts)) {
  const { data: entry } = await adminSoat.memories.createMemory({
    body: { memory_store_id: MEMORY_ID, content },
  });
  entryIds[key] = entry.id;
}
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
MEMORY_ID=$(curl -s -X POST "$SOAT_BASE_URL/api/v1/memory-stores" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"project_id\":\"$PROJECT_ID\",\"name\":\"Team Facts\",\"description\":\"Facts about teams, owners and dates\"}" | jq -r '.id')
create_fact() {
  curl -s -X POST "$SOAT_BASE_URL/api/v1/memories" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"memory_store_id\":\"$MEMORY_ID\",\"content\":\"$1\"}" | jq -r '.id'
}
ENTRY_PAYMENTS=$(create_fact "The payments service is owned by the Orion team; their on-call lead is Priya.")
ENTRY_CREDS=$(create_fact "Staging database credentials rotate on the first Monday of each month.")
ENTRY_OFFSITE=$(create_fact "The Q3 planning offsite is in Lisbon during the second week of October.")
ENTRY_ACME=$(create_fact "Customer Acme requires a four-hour response SLA on SEV1 incidents.")
ENTRY_SEARCH=$(create_fact "The search index is rebuilt every Sunday night by the Data Platform team.")
echo "MEMORY_ID: $MEMORY_ID"
```

</TabItem>
</Tabs>

---

## Step 4 — Write the golden set

A golden set is a list of `{slice, query, expected}` rows. `expected` is the id the top of the ranking should hold, a `document_id` or a `memory_id`. `slice` groups rows whose failure would mean different things; here it separates document questions from memory questions, the split that matters for [Step 7](#step-7--read-a-knob-off-the-table).

Write queries as a user would ask them, not as the page is worded. A query that repeats the page's own sentence saturates the lexical channel of [hybrid retrieval](/docs/modules/knowledge#hybrid-retrieval) and measures nothing.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
GOLDEN='[
  {"slice":"document","query":"who do I page when production is down at night","expected":"'"$DOC_ONCALL"'"},
  {"slice":"document","query":"how bad does an outage have to be to count as SEV1","expected":"'"$DOC_SEVERITY"'"},
  {"slice":"document","query":"can I ship a release the week before Christmas","expected":"'"$DOC_FREEZE"'"},
  {"slice":"document","query":"how often do we practise restoring the database","expected":"'"$DOC_BACKUPS"'"},
  {"slice":"document","query":"how many reviewers does a pull request need","expected":"'"$DOC_REVIEW"'"},
  {"slice":"document","query":"how do I get onto the staging network from home","expected":"'"$DOC_VPN"'"},
  {"slice":"memory","query":"which team owns payments","expected":"'"$ENTRY_PAYMENTS"'"},
  {"slice":"memory","query":"when do the staging DB passwords change","expected":"'"$ENTRY_CREDS"'"},
  {"slice":"memory","query":"where is the planning offsite","expected":"'"$ENTRY_OFFSITE"'"},
  {"slice":"memory","query":"what response time did Acme negotiate for outages","expected":"'"$ENTRY_ACME"'"}
]'
echo "$GOLDEN" | jq 'length'
```

Expected output:

```
10
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const golden = [
  { slice: 'document', query: 'who do I page when production is down at night', expected: docIds.DOC_ONCALL },
  { slice: 'document', query: 'how bad does an outage have to be to count as SEV1', expected: docIds.DOC_SEVERITY },
  { slice: 'document', query: 'can I ship a release the week before Christmas', expected: docIds.DOC_FREEZE },
  { slice: 'document', query: 'how often do we practise restoring the database', expected: docIds.DOC_BACKUPS },
  { slice: 'document', query: 'how many reviewers does a pull request need', expected: docIds.DOC_REVIEW },
  { slice: 'document', query: 'how do I get onto the staging network from home', expected: docIds.DOC_VPN },
  { slice: 'memory', query: 'which team owns payments', expected: entryIds.ENTRY_PAYMENTS },
  { slice: 'memory', query: 'when do the staging DB passwords change', expected: entryIds.ENTRY_CREDS },
  { slice: 'memory', query: 'where is the planning offsite', expected: entryIds.ENTRY_OFFSITE },
  { slice: 'memory', query: 'what response time did Acme negotiate for outages', expected: entryIds.ENTRY_ACME },
];
console.log(golden.length); // 10
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
GOLDEN='[
  {"slice":"document","query":"who do I page when production is down at night","expected":"'"$DOC_ONCALL"'"},
  {"slice":"document","query":"how bad does an outage have to be to count as SEV1","expected":"'"$DOC_SEVERITY"'"},
  {"slice":"document","query":"can I ship a release the week before Christmas","expected":"'"$DOC_FREEZE"'"},
  {"slice":"document","query":"how often do we practise restoring the database","expected":"'"$DOC_BACKUPS"'"},
  {"slice":"document","query":"how many reviewers does a pull request need","expected":"'"$DOC_REVIEW"'"},
  {"slice":"document","query":"how do I get onto the staging network from home","expected":"'"$DOC_VPN"'"},
  {"slice":"memory","query":"which team owns payments","expected":"'"$ENTRY_PAYMENTS"'"},
  {"slice":"memory","query":"when do the staging DB passwords change","expected":"'"$ENTRY_CREDS"'"},
  {"slice":"memory","query":"where is the planning offsite","expected":"'"$ENTRY_OFFSITE"'"},
  {"slice":"memory","query":"what response time did Acme negotiate for outages","expected":"'"$ENTRY_ACME"'"}
]'
echo "$GOLDEN" | jq 'length'
```

</TabItem>
</Tabs>

---

## Step 5 — Run the golden set through search

One search per row at `limit: 10`, keeping only the ranked list of ids. Positions are raw result positions and `score` is never read ([Retrieval Quality — Metrics](/docs/advanced/retrieval-quality#metrics)).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
RESULTS=$(echo "$GOLDEN" | jq -c '.[]' | while read -r item; do \
  soat search-knowledge --project-id "$PROJECT_ID" --limit 10 \
    --query "$(echo "$item" | jq -r '.query')" \
    | jq -c --argjson item "$item" '$item + {ranked: [.results[] | (.document_id // .memory_id)]}'; \
done | jq -s '.')
echo "$RESULTS" | jq -e 'all(.[]; (.ranked | length) > 0)' > /dev/null && echo "every query returned results"
echo "$RESULTS" | jq -e 'any(.[]; .expected as $e | .ranked[:10] | any(. == $e))' > /dev/null && echo "an expected key is in the top 10"
```

Expected output:

```
every query returned results
an expected key is in the top 10
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const results = [];
for (const item of golden) {
  const { data } = await adminSoat.knowledge.searchKnowledge({
    body: { project_id: PROJECT_ID, query: item.query, limit: 10 },
  });
  results.push({
    ...item,
    ranked: data.results.map((r) => ('document_id' in r ? r.document_id : r.memory_id)),
  });
}
console.log(results.every((r) => r.ranked.length > 0)); // true
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
RESULTS=$(echo "$GOLDEN" | jq -c '.[]' | while read -r item; do \
  curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(echo "$item" | jq -c --arg p "$PROJECT_ID" '{project_id: $p, query: .query, limit: 10}')" \
    | jq -c --argjson item "$item" '$item + {ranked: [.results[] | (.document_id // .memory_id)]}'; \
done | jq -s '.')
echo "$RESULTS" | jq -e 'all(.[]; (.ranked | length) > 0)' > /dev/null && echo "every query returned results"
```

</TabItem>
</Tabs>

---

## Step 6 — Compute recall@k and MRR

For each row, `rank` is the 1-based position of `expected` in `ranked`, `0` when it is missing.

Definitions: [Retrieval Quality — Metrics](/docs/advanced/retrieval-quality#metrics).

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
node << EOF
const runs = $RESULTS;
const rankOf = (r) => r.ranked.indexOf(r.expected) + 1;
const metrics = (rows) => {
  const ranks = rows.map(rankOf);
  const recallAt = (k) => ranks.filter((p) => p > 0 && p <= k).length / ranks.length;
  const mrr = ranks.reduce((s, p) => s + (p > 0 ? 1 / p : 0), 0) / ranks.length;
  return { queries: rows.length, 'recall@5': recallAt(5).toFixed(4), 'recall@10': recallAt(10).toFixed(4), MRR: mrr.toFixed(4) };
};
const slices = [...new Set(runs.map((r) => r.slice))];
const table = { overall: metrics(runs) };
for (const s of slices) table[s] = metrics(runs.filter((r) => r.slice === s));
console.table(table);
runs.forEach((r) => console.log(String(rankOf(r)).padStart(2), r.slice.padEnd(8), r.query));
if (Number(table.overall['recall@10']) === 0) process.exit(1);
EOF
```

Expected output (your figures will differ; the shape is the point):

```
┌──────────┬─────────┬──────────┬───────────┬──────────┐
│ (index)  │ queries │ recall@5 │ recall@10 │ MRR      │
├──────────┼─────────┼──────────┼───────────┼──────────┤
│ overall  │ 10      │ '1.0000' │ '1.0000'  │ '0.9167' │
│ document │ 6       │ '1.0000' │ '1.0000'  │ '0.9167' │
│ memory   │ 4       │ '1.0000' │ '1.0000'  │ '0.9167' │
└──────────┴─────────┴──────────┴───────────┴──────────┘
 1 document who do I page when production is down at night
 2 document how bad does an outage have to be to count as SEV1
 ...
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const rankOf = (r: { ranked: string[]; expected: string }) => r.ranked.indexOf(r.expected) + 1;

const metrics = (rows: typeof results) => {
  const ranks = rows.map(rankOf);
  const recallAt = (k: number) => ranks.filter((p) => p > 0 && p <= k).length / ranks.length;
  const mrr = ranks.reduce((s, p) => s + (p > 0 ? 1 / p : 0), 0) / ranks.length;
  return {
    queries: rows.length,
    'recall@5': recallAt(5).toFixed(4),
    'recall@10': recallAt(10).toFixed(4),
    MRR: mrr.toFixed(4),
  };
};

const slices = [...new Set(results.map((r) => r.slice))];
const table: Record<string, ReturnType<typeof metrics>> = { overall: metrics(results) };
for (const s of slices) table[s] = metrics(results.filter((r) => r.slice === s));
console.table(table);
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
node << EOF
const runs = $RESULTS;
const rankOf = (r) => r.ranked.indexOf(r.expected) + 1;
const metrics = (rows) => {
  const ranks = rows.map(rankOf);
  const recallAt = (k) => ranks.filter((p) => p > 0 && p <= k).length / ranks.length;
  const mrr = ranks.reduce((s, p) => s + (p > 0 ? 1 / p : 0), 0) / ranks.length;
  return { queries: rows.length, 'recall@5': recallAt(5).toFixed(4), 'recall@10': recallAt(10).toFixed(4), MRR: mrr.toFixed(4) };
};
const slices = [...new Set(runs.map((r) => r.slice))];
const table = { overall: metrics(runs) };
for (const s of slices) table[s] = metrics(runs.filter((r) => r.slice === s));
console.table(table);
EOF
```

</TabItem>
</Tabs>

How to read it, and why both metrics are needed: [Retrieval Quality — Reading the table](/docs/advanced/retrieval-quality#reading-the-table).

---

## Step 7 — Read a knob off the table

The method for any knob: change one parameter, re-run [Step 5](#step-5--run-the-golden-set-through-search) and [Step 6](#step-6--compute-recallk-and-mrr), compare the two tables slice by slice. This step does it for `rrf_k` and shows what a `score` on fused output is worth ([Relevance knobs](/docs/modules/knowledge#relevance-knobs)).

Fused scores are compressed, so a multiplier applied after fusion is far stronger than it looks; the figures are in [Retrieval Quality — What a multiplier costs](/docs/advanced/retrieval-quality#what-a-multiplier-costs-on-fused-output). The block below reproduces them.

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat search-knowledge --project-id "$PROJECT_ID" --limit 3 --rrf-k 60 \
  --query "who do I page when production is down at night" \
  | jq '[.results[] | .score]'
soat search-knowledge --project-id "$PROJECT_ID" --limit 3 --rrf-k 5 \
  --query "who do I page when production is down at night" \
  | jq '[.results[] | .score]'
node << EOF
const ranksLost = (k, multiplier) => {
  const top = 1 / (k + 1);
  let rank = 1;
  while (1 / (k + rank + 1) > top * multiplier) rank++;
  return rank - 1;
};
for (const k of [60, 20, 5]) console.log('rrf_k', k, 'x0.87 costs', ranksLost(k, 0.87), 'rank(s)');
console.log('days of age for x0.87 at a 30-day half-life:', (-30 * Math.log2(0.87)).toFixed(1));
EOF
```

Expected output (the second list is wider spread than the first; absolute values vary):

```json
[0.0328, 0.0161, 0.0159]
[0.3333, 0.1429, 0.125]
```

```
rrf_k 60 x0.87 costs 9 rank(s)
rrf_k 20 x0.87 costs 3 rank(s)
rrf_k 5 x0.87 costs 0 rank(s)
days of age for x0.87 at a 30-day half-life: 6.0
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
for (const rrf_k of [60, 5]) {
  const { data } = await adminSoat.knowledge.searchKnowledge({
    body: {
      project_id: PROJECT_ID,
      query: 'who do I page when production is down at night',
      limit: 3,
      rrf_k,
    },
  });
  console.log(rrf_k, data.results.map((r) => r.score));
}

const ranksLost = (k: number, multiplier: number) => {
  const top = 1 / (k + 1);
  let rank = 1;
  while (1 / (k + rank + 1) > top * multiplier) rank++;
  return rank - 1;
};
for (const k of [60, 20, 5]) console.log('rrf_k', k, 'x0.87 costs', ranksLost(k, 0.87), 'rank(s)');
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
for K in 60 5; do
  curl -s -X POST "$SOAT_BASE_URL/api/v1/knowledge/search" \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"project_id\":\"$PROJECT_ID\",\"query\":\"who do I page when production is down at night\",\"limit\":3,\"rrf_k\":$K}" \
    | jq '[.results[] | .score]'
done
```

</TabItem>
</Tabs>

The recency blend is measured the same way, with one constraint this corpus cannot meet: every memory above was written seconds ago, so `2^(-age/half_life)` is `1.0` for all of them and `recency_half_life_days` reorders nothing here. On a store with real ages, run Step 5 with `--recency-half-life-days 30`, compute Step 6 again, and read the `memory` row against the run without it ([the blend is never free](/docs/advanced/retrieval-quality#the-recency-blend-is-never-free)).

---

## What's next

- **Score other knobs** — `min_similarity` drops vector candidates below a cosine floor; a value that lifts MRR on one slice can zero recall on another ([Relevance knobs](/docs/modules/knowledge#relevance-knobs)).
- **Grow the golden set** — add a row every time a user reports a miss, with the id they should have seen; a slice per question type keeps the table legible.
- **Scope what you rank** — `memory_store_ids` and `document_paths` narrow the candidate set before fusion ([Agent with Persistent Memory — Step 12](/docs/tutorials/memories-agent#step-12--query-the-knowledge-layer-directly)).
- **Feed an agent** — [knowledge injection](/docs/modules/agents#knowledge-config) uses the same ranking; the table above is what the agent sees before it answers.
