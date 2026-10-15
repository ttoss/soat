---
description: 'Playbooks: versioned templates of nodes whose inputs a person fills or an earlier node produces, and the cases that fill one version for one subject.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Playbooks

A **playbook** is a versioned template of nodes; a **case** fills one version of it for one subject.

## Overview

A playbook declares what has to be known before a goal can be reached: each node holds inputs, and each input is either written by a person or an integration (`manual`) or read from a field of an earlier node. Those sources are the graph's edges. A case is one subject — a client, an application, a claim — filled against the version the playbook was at when the case was created. Every write to a case is an append-only entry, and each node's state is computed from the entries and executions on every read. A node runs its executor — an [agent](./agents.md), [tool](./tools.md), [decider](./deciders.md), [workflow](./workflows.md) or [orchestration](./orchestrations.md) — as the author of the case's version.

An [orchestration](./orchestrations.md) is a pipeline that runs once and ends, and a [workflow](./workflows.md) task holds one state; a case keeps a value per field and answers what is still missing before a node can be reached.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Playbook

| Field         | Type           | Description                                         |
| ------------- | -------------- | --------------------------------------------------- |
| `id`          | string         | Public identifier (`pbk_…`)                         |
| `project_id`  | string         | Owning project                                      |
| `name`        | string         | Human-readable name, unique per project             |
| `description` | string \| null | Optional                                            |
| `version`     | integer        | The definition's version; see [Versions](#versions) |
| `definition`  | object         | `{ nodes }`, 1 to 200 [nodes](#node)                |
| `created_at`  | string         | ISO 8601 creation timestamp                         |
| `updated_at`  | string         | ISO 8601 last-update timestamp                      |

### Node

| Field             | Type    | Description                                                                                                                                                                                                                              |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`             | string  | Stable across versions. Letters, digits and underscores, starting with a letter or underscore                                                                                                                                            |
| `title`           | string  | Human-readable label                                                                                                                                                                                                                     |
| `description`     | string  | Optional                                                                                                                                                                                                                                 |
| `kind`            | string  | `collect` (its output is its inputs), `execute` (its executor produces the output), `confirm` (a person confirms its inputs)                                                                                                             |
| `final`           | boolean | A goal of the playbook. Default `false`                                                                                                                                                                                                  |
| `inputs`          | array   | Up to 50 [inputs](#input)                                                                                                                                                                                                                |
| `executor`        | object  | Required on an `execute` node, refused on any other: `{ type, id, input? }`, `type` one of `agent`, `tool`, `decider`, `workflow`, `orchestration`; `input` maps each field of the executor's input to JSON Logic over the node's inputs |
| `transformations` | array   | Final nodes only: `{ name, format, tool }`, a tool that renders the node's output as a file                                                                                                                                              |

### Input

| Field         | Type             | Description                                                                                             |
| ------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| `name`        | string           | Unique in its node; same character rules as `key`                                                       |
| `schema`      | object           | The JSON Schema a value must satisfy                                                                    |
| `required`    | boolean          | The node cannot be reached while a required input is unset                                              |
| `description` | string           | What to ask for; returned with the input when it is [missing](#what-a-node-still-needs)                 |
| `source`      | string \| object | `manual`, or `{ node, field }` with `field` `output[.path]` or `input.<name>[.path]` of an earlier node |

### Case

| Field              | Type    | Description                                                                              |
| ------------------ | ------- | ---------------------------------------------------------------------------------------- |
| `id`               | string  | Public identifier (`pbk_case_…`)                                                         |
| `project_id`       | string  | Owning project                                                                           |
| `playbook_id`      | string  | The playbook                                                                             |
| `playbook_version` | integer | The version the case was created on and is evaluated against                             |
| `subject`          | string  | Who or what the case is about                                                            |
| `revision`         | integer | The case's counter; every entry takes the next value                                     |
| `nodes`            | array   | On a single-case read: every node's `state`, `missing`, `waiting`, `inputs` and `output` |

### Entry

| Field              | Type           | Description                                                                    |
| ------------------ | -------------- | ------------------------------------------------------------------------------ |
| `id`               | string         | Public identifier (`pbk_ent_…`)                                                |
| `revision`         | integer        | The case revision it took                                                      |
| `node`             | string         | The node key                                                                   |
| `kind`             | string         | `input`, `output`, `confirmation` or `rejection`                               |
| `input`            | string \| null | The input written, on an `input` entry                                         |
| `value`            | any            | The value written                                                              |
| `basis`            | object \| null | The revision of each input an output, confirmation or rejection was decided on |
| `playbook_version` | integer        | The version the case was on when it was written                                |
| `created_by`       | string \| null | The user who wrote it                                                          |

### Execution

| Field              | Type            | Description                                                                          |
| ------------------ | --------------- | ------------------------------------------------------------------------------------ |
| `id`               | string          | Public identifier (`pbk_exe_…`)                                                      |
| `case_id`          | string          | The case                                                                             |
| `node`             | string          | The node that ran                                                                    |
| `playbook_version` | integer         | The version the case runs on                                                         |
| `executor`         | object \| null  | `{ type, id }`; null for a `collect` node                                            |
| `status`           | string          | `running`, `succeeded` or `failed`                                                   |
| `result`           | string \| null  | Once settled: `current`, or `superseded` when the node's inputs changed while it ran |
| `run_id`           | string \| null  | The generation, decision, task or orchestration run it started                       |
| `input`            | any             | What the executor was given                                                          |
| `output`           | any             | What the executor answered; null until it succeeds                                   |
| `output_revision`  | integer \| null | The revision of the output entry it wrote; null when it wrote none                   |
| `error`            | object \| null  | Why it failed                                                                        |
| `created_by`       | string \| null  | Who asked for the run                                                                |
| `finished_at`      | string \| null  | ISO 8601 settle timestamp                                                            |

## Key Concepts

### Definition checks

A create or update is refused with `400 PLAYBOOK_VALIDATION_FAILED` when the definition holds a duplicate node or input, an input reading a missing node or a field that node does not declare, an `execute` node without an executor or another kind with one, transformations on a non-final node, or a cycle. `meta.problems` lists every one, each with its `code` and the `node`, `input` or `nodes` it concerns. [`POST /api/v1/playbooks/validate`](/docs/api/playbooks/validate-playbook) answers the same check without writing.

### Versions

`version` starts at 1 and increments on every write that changes `definition`; each version's definition is archived. A rename, a new description or a rewrite of the definition the playbook already holds leaves it alone. A case runs on the version it was created on, so editing a playbook never reshapes a case in flight.

[`PATCH /api/v1/playbooks/{playbook_id}`](/docs/api/playbooks/update-playbook) takes `expected_version` (or `If-Match`) and answers `409 VERSION_CONFLICT` on a stale one. [`POST /api/v1/playbooks/{playbook_id}/versions/{version}/restore`](/docs/api/playbooks/restore-playbook-version) writes an archived definition back as a new version. A playbook with cases cannot be deleted (`409 PLAYBOOK_HAS_CASES`).

### Node states

Computed from the case's entries and executions on each read, never stored:

| State      | When                                                                                   |
| ---------- | -------------------------------------------------------------------------------------- |
| `blocked`  | A required input is unset or refused by its schema, or reads a node that is not `done` |
| `ready`    | Every required input is set and current, and there is no output yet                    |
| `running`  | An execution is in flight                                                              |
| `done`     | The output exists and every input still has the revision it was produced from          |
| `stale`    | The output exists and an input changed since                                           |
| `failed`   | The last execution failed on the current inputs                                        |
| `rejected` | A `confirm` node's inputs were rejected and have not changed since                     |

`missing` names the required inputs a node lacks; `waiting` names the nodes it reads that are not `done`.

### Writing inputs

[`POST /api/v1/playbook-cases/{case_id}/inputs`](/docs/api/playbooks/write-playbook-case-inputs) writes a batch of manual inputs, all or none. Each write names the revision of the field it read in `expected_revision`, `null` for a field read as unset:

- a field written since is refused with `409 PLAYBOOK_INPUT_CONFLICT`, `meta.conflicts` naming each field with both revisions, and nothing in the batch is written;
- an input the case's version does not declare, one that reads another node, or a value its schema refuses is `400 PLAYBOOK_INPUT_INVALID`;
- a value equal to the field's current one writes no revision.

### What a node still needs

[`GET /api/v1/playbook-cases/{case_id}/missing`](/docs/api/playbooks/get-playbook-case-missing) takes a node key and returns the manual inputs still unset or refused upstream of it, grouped in waves: nothing in a later wave can be reached before an earlier one is filled. Each carries its `schema` and `description`, which is what an agent asks for.

### Running a node

[`POST /api/v1/playbook-cases/{case_id}/nodes/{node}/run`](/docs/api/playbooks/run-playbook-case-node) runs one node now and records an [execution](#execution). Only a `ready`, `stale` or `failed` node with every required input set runs; a `confirm` node, a blocked one, a `running` one and a `done` one answer `409 PLAYBOOK_NODE_NOT_RUNNABLE`, `meta` carrying its `state`, `missing` and `waiting`.

A `collect` node's output is its input values. Any other node starts its executor with the node's input values, mapped through the executor's `input` when it declares one:

| Executor        | Started as                                  | Output                                                |
| --------------- | ------------------------------------------- | ----------------------------------------------------- |
| `agent`         | A generation with the input as JSON         | The object its output schema asked for, else its text |
| `tool`          | A call, under the project's tool guardrails | The tool's result                                     |
| `decider`       | A decision                                  | `answers_by_name`                                     |
| `workflow`      | A task whose `payload` is the input         | The task's `payload` when it closes                   |
| `orchestration` | A run whose `input` is the input            | The run's `output` when it succeeds                   |

When the execution settles, its output is written as an `output` entry. A value equal to the node's current output writes no revision, so nothing reading the node goes `stale`. An execution whose node's inputs changed while it ran settles as `superseded` and writes nothing. A failed executor, a failed decision or orchestration run, or an agent that answers with neither text nor an object fails the execution with its cause in `error`; the node is `failed` and can run again.

Without `wait` the request answers `201` with the execution `running` and it settles in the background; poll [`GET /api/v1/playbook-cases/{case_id}/executions/{execution_id}`](/docs/api/playbooks/get-playbook-case-execution). With `wait: true` it answers once the executor settles, or once it parks: a workflow task still open, or an orchestration run waiting on a person or a timer, settles the node when it closes or ends. See [Sync and Async](../advanced/sync-and-async.md). [`GET /api/v1/playbook-cases/{case_id}/executions`](/docs/api/playbooks/list-playbook-case-executions) lists a case's executions, newest first.

### Who a node runs as

A node's executor runs as the user or API key that wrote the case's playbook version, with that credential's permissions as they stand when it runs; an API key's own policies still bound it. Writing a definition therefore requires the start action of every executor it names — `agents:CreateAgentGeneration`, `tools:CallTool`, `deciders:CreateDecision`, `tasks:CreateTask` or `orchestrations:StartRun` — and is refused with `403 PLAYBOOK_EXECUTOR_FORBIDDEN` otherwise. Each run checks it again, so a permission removed since stops the next run with the same error. A definition with executors written with a trigger or OAuth token, or a version whose author no longer exists, is `409 PLAYBOOK_AUTHOR_UNAVAILABLE`.

### Entries

[`GET /api/v1/playbook-cases/{case_id}/entries`](/docs/api/playbooks/list-playbook-case-entries) lists every value written to a case, newest first, optionally for one `node`. Entries are never rewritten; deleting the case deletes them.

## Examples

### Create a playbook

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-playbook \
  --project-id proj_… \
  --name client-pricing \
  --definition '{
    "nodes": [
      { "key": "revenue", "title": "Annual revenue", "kind": "collect",
        "inputs": [{ "name": "amount", "schema": { "type": "number" },
                     "required": true, "source": "manual" }] },
      { "key": "pricing", "title": "Pricing", "kind": "collect", "final": true,
        "inputs": [
          { "name": "revenue", "schema": { "type": "number" }, "required": true,
            "source": { "node": "revenue", "field": "output.amount" } },
          { "name": "margin", "schema": { "type": "number" }, "required": true,
            "source": "manual" }
        ] }
    ]
  }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.createPlaybook({
  body: {
    project_id: 'proj_…',
    name: 'client-pricing',
    definition: {
      nodes: [
        {
          key: 'revenue',
          title: 'Annual revenue',
          kind: 'collect',
          inputs: [
            {
              name: 'amount',
              schema: { type: 'number' },
              required: true,
              source: 'manual',
            },
          ],
        },
        {
          key: 'pricing',
          title: 'Pricing',
          kind: 'collect',
          final: true,
          inputs: [
            {
              name: 'revenue',
              schema: { type: 'number' },
              required: true,
              source: { node: 'revenue', field: 'output.amount' },
            },
            {
              name: 'margin',
              schema: { type: 'number' },
              required: true,
              source: 'manual',
            },
          ],
        },
      ],
    },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbooks \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "project_id": "proj_…",
    "name": "client-pricing",
    "definition": {
      "nodes": [
        { "key": "revenue", "title": "Annual revenue", "kind": "collect",
          "inputs": [{ "name": "amount", "schema": { "type": "number" },
                       "required": true, "source": "manual" }] },
        { "key": "pricing", "title": "Pricing", "kind": "collect", "final": true,
          "inputs": [
            { "name": "revenue", "schema": { "type": "number" }, "required": true,
              "source": { "node": "revenue", "field": "output.amount" } },
            { "name": "margin", "schema": { "type": "number" }, "required": true,
              "source": "manual" }
          ] }
      ]
    }
  }'
```

</TabItem>
</Tabs>

### Create a case

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-playbook-case --playbook-id pbk_… --subject 'ACME Ltda'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.createPlaybookCase({
  path: { playbook_id: 'pbk_…' },
  body: { subject: 'ACME Ltda' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbooks/pbk_…/cases \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "subject": "ACME Ltda" }'
```

</TabItem>
</Tabs>

### Ask what a node still needs

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-playbook-case-missing --case-id pbk_case_… --node pricing
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.getPlaybookCaseMissing({
  path: { case_id: 'pbk_case_…' },
  query: { node: 'pricing' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/playbook-cases/pbk_case_…/missing?node=pricing" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

```json
{
  "case_id": "pbk_case_…",
  "node": "pricing",
  "waves": [
    [{ "node": "revenue", "input": "amount", "schema": { "type": "number" } }],
    [{ "node": "pricing", "input": "margin", "schema": { "type": "number" } }]
  ]
}
```

### Write inputs

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat write-playbook-case-inputs \
  --case-id pbk_case_… \
  --inputs '[
    { "node": "revenue", "name": "amount", "value": 4000000, "expected_revision": null },
    { "node": "pricing", "name": "margin", "value": 0.3, "expected_revision": null }
  ]'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.writePlaybookCaseInputs({
  path: { case_id: 'pbk_case_…' },
  body: {
    inputs: [
      {
        node: 'revenue',
        name: 'amount',
        value: 4000000,
        expected_revision: null,
      },
      { node: 'pricing', name: 'margin', value: 0.3, expected_revision: null },
    ],
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbook-cases/pbk_case_…/inputs \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "inputs": [
      { "node": "revenue", "name": "amount", "value": 4000000, "expected_revision": null },
      { "node": "pricing", "name": "margin", "value": 0.3, "expected_revision": null }
    ]
  }'
```

</TabItem>
</Tabs>

### Run a node

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat run-playbook-case-node --case-id pbk_case_… --node revenue --wait true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.runPlaybookCaseNode({
  path: { case_id: 'pbk_case_…', node: 'revenue' },
  body: { wait: true },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbook-cases/pbk_case_…/nodes/revenue/run \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "wait": true }'
```

</TabItem>
</Tabs>

```json
{
  "id": "pbk_exe_…",
  "case_id": "pbk_case_…",
  "node": "revenue",
  "executor": null,
  "status": "succeeded",
  "result": "current",
  "output": { "amount": 4000000 },
  "output_revision": 3
}
```

## Errors

| Code                          | Status | When                                                                                                   |
| ----------------------------- | ------ | ------------------------------------------------------------------------------------------------------ |
| `VALIDATION_FAILED`           | 400    | The definition's shape cannot be read, a missing `subject`, or an unknown `node` on `missing` or a run |
| `PLAYBOOK_VALIDATION_FAILED`  | 400    | The definition has graph problems; `meta.problems` lists them                                          |
| `PLAYBOOK_INPUT_INVALID`      | 400    | An input write names an undeclared or non-manual input, or a value its schema refuses                  |
| `NAME_CONFLICT`               | 409    | Another playbook in the project has the name                                                           |
| `VERSION_CONFLICT`            | 409    | `expected_version` is stale                                                                            |
| `PLAYBOOK_HAS_CASES`          | 409    | A delete of a playbook that has cases                                                                  |
| `PLAYBOOK_INPUT_CONFLICT`     | 409    | An input write's `expected_revision` is not the field's current one                                    |
| `PLAYBOOK_EXECUTOR_FORBIDDEN` | 403    | The version's author may not start an executor the definition names                                    |
| `PLAYBOOK_AUTHOR_UNAVAILABLE` | 409    | The version has no author a node can run as                                                            |
| `PLAYBOOK_NODE_NOT_RUNNABLE`  | 409    | The node is a `confirm` node, blocked, `running` or `done`                                             |
