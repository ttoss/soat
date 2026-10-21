---
description: 'Playbooks: versioned templates of nodes whose inputs a person fills or an earlier node produces, and the cases that fill one version for one subject.'
---

import Tabs from '@theme/Tabs';
import TabItem from '@theme/TabItem';

# Playbooks

A **playbook** is a versioned template of nodes; a **case** fills one version of it for one subject.

## Overview

A playbook declares what has to be known before a goal can be reached: each node holds inputs, and each input is either written by a person or an integration (`manual`) or read from a field of an earlier node. Those sources are the graph's edges. A case is one subject — a client, an application, a claim — filled against the version the playbook was at when the case was created. Every write to a case is an append-only entry, and each node's state is computed from the entries and executions on every read. A node runs its executor — an [agent](./agents.md), [tool](./tools.md), [decider](./deciders.md), [workflow](./workflows.md) or [orchestration](./orchestrations.md) — as the author of the case's version, on its own once its inputs are set, and again whenever one of them changes.

An [orchestration](./orchestrations.md) is a pipeline that runs once and ends, and a [workflow](./workflows.md) task holds one state; a case keeps a value per field and answers what is still missing before a node can be reached.

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

## Data Model

### Playbook

| Field         | Type           | Description                                                                          |
| ------------- | -------------- | ------------------------------------------------------------------------------------ |
| `id`          | string         | Public identifier (`pbk_…`)                                                          |
| `project_id`  | string         | Owning project                                                                       |
| `name`        | string         | Human-readable name, unique per project                                              |
| `description` | string \| null | Optional                                                                             |
| `version`     | integer        | The definition's version; see [Versions](#versions)                                  |
| `definition`  | object         | `{ upstreams?, nodes }`: up to 20 [upstreams](#upstream) and 1 to 200 [nodes](#node) |
| `created_at`  | string         | ISO 8601 creation timestamp                                                          |
| `updated_at`  | string         | ISO 8601 last-update timestamp                                                       |

### Node

| Field             | Type    | Description                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`              | string  | Stable across versions. Letters, digits and underscores, starting with a letter or underscore                                                                                                                                                                                                                                                                                |
| `title`           | string  | Human-readable label                                                                                                                                                                                                                                                                                                                                                         |
| `description`     | string  | Optional                                                                                                                                                                                                                                                                                                                                                                     |
| `kind`            | string  | `collect` (its output is its inputs), `execute` (its executor produces the output), `confirm` (a person confirms its inputs), `upstream` (its output is a node of a bound [upstream case](#upstream-cases))                                                                                                                                                                  |
| `final`           | boolean | A goal of the playbook. Default `false`                                                                                                                                                                                                                                                                                                                                      |
| `inputs`          | array   | Up to 50 [inputs](#input)                                                                                                                                                                                                                                                                                                                                                    |
| `executor`        | object  | Required on an `execute` node, refused on any other: `{ type, id, operation_id?, input? }`, `type` one of `agent`, `tool`, `decider`, `workflow`, `orchestration`; `operation_id`, only on a `tool` executor, names the action of a multi-action tool and is required by an `mcp` tool; `input` maps each field of the executor's input to JSON Logic over the node's inputs |
| `upstream`        | object  | Required on an `upstream` node, refused on any other: `{ name, node_id }`, the declared upstream and the node of its playbook it pulls. An `upstream` node has no inputs and no executor                                                                                                                                                                                     |
| `transformations` | array   | Final nodes only: `{ name, format, tool }`, a tool that renders the node's output as a file of `format`; see [Exports](#exports)                                                                                                                                                                                                                                             |

### Input

| Field         | Type             | Description                                                                                                |
| ------------- | ---------------- | ---------------------------------------------------------------------------------------------------------- |
| `name`        | string           | Unique in its node; same character rules as `id`                                                           |
| `schema`      | object           | The JSON Schema a value must satisfy                                                                       |
| `required`    | boolean          | The node cannot be reached while a required input is unset                                                 |
| `description` | string           | What to ask for; returned with the input when it is [missing](#what-a-node-still-needs)                    |
| `source`      | string \| object | `manual`, or `{ node_id, field }` with `field` `output[.path]` or `input.<name>[.path]` of an earlier node |

### Upstream

| Field         | Type   | Description                                                                                                |
| ------------- | ------ | ---------------------------------------------------------------------------------------------------------- |
| `name`        | string | Unique in the definition; same character rules as a node `id`                                              |
| `playbook_id` | string | A playbook of the same project; in a [formation](./formations.md), a `{ "ref": … }` to one in the template |

### Case

| Field                | Type           | Description                                                                                                                                                                                                                                                      |
| -------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                 | string         | Public identifier (`pbk_case_…`)                                                                                                                                                                                                                                 |
| `project_id`         | string         | Owning project                                                                                                                                                                                                                                                   |
| `playbook_id`        | string         | The playbook                                                                                                                                                                                                                                                     |
| `playbook_version`   | integer        | The version the case was created on and is evaluated against                                                                                                                                                                                                     |
| `subject`            | string         | Who or what the case is about                                                                                                                                                                                                                                    |
| `actor_id`           | string \| null | The [actor](./actors.md) the case belongs to; see [Cases of an end user](#cases-of-an-end-user)                                                                                                                                                                  |
| `upstreams`          | object         | The case bound to each declared upstream, by name; `{}` for a playbook that declares none. See [Upstream cases](#upstream-cases)                                                                                                                                 |
| `revision`           | integer        | The case's counter; every entry takes the next value                                                                                                                                                                                                             |
| `automation_status`  | string         | `paused` while a [pause](#pausing-a-case) of the case or of its [project](./projects.md) stands, else `running` while an execution is queued or runs its executor, else `waiting` while every execution in flight waits on a task or run it started, else `idle` |
| `pause_requested_at` | string \| null | When the case was paused                                                                                                                                                                                                                                         |
| `nodes`              | array          | On a single-case read: every node's `id`, `state`, `missing`, `blocked_by`, `run`, `inputs` and `output`                                                                                                                                                         |

### Entry

| Field                                                   | Type           | Description                                                                                    |
| ------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `id`                                                    | string         | Public identifier (`pbk_ent_…`)                                                                |
| `revision`                                              | integer        | The case revision it took                                                                      |
| `node_id`                                               | string         | The node's ID                                                                                  |
| `kind`                                                  | string         | `input`, `output`, `confirmation` or `rejection`                                               |
| `input`                                                 | string \| null | The input written, on an `input` entry                                                         |
| `value`                                                 | any            | The value written                                                                              |
| `basis`                                                 | object \| null | The revision of each input an output, confirmation or rejection was decided on                 |
| `playbook_version`                                      | integer        | The version the case was on when it was written                                                |
| `created_by_principal_type` / `created_by_principal_id` | string \| null | Who wrote it: `user` or `api_key` and its id; null for an output the case wrote                |
| `on_behalf_of`                                          | object \| null | The tool call it was written for ([On-behalf-of](./tools.md#writing-on-behalf-of-a-tool-call)) |

### Execution

| Field                                                   | Type            | Description                                                                                    |
| ------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------- |
| `id`                                                    | string          | Public identifier (`pbk_exe_…`)                                                                |
| `case_id`                                               | string          | The case                                                                                       |
| `node_id`                                               | string          | The node that ran                                                                              |
| `playbook_version`                                      | integer         | The version the case runs on                                                                   |
| `executor`                                              | object \| null  | `{ type, id }`; null for a `collect` node                                                      |
| `status`                                                | string          | `queued` until a worker claims it, `running`, then `completed` or `failed`                     |
| `result`                                                | string \| null  | Once settled: `current`, or `superseded` when the node's inputs changed while it ran           |
| `run_id`                                                | string \| null  | The generation, decision, task or orchestration run it started                                 |
| `input`                                                 | any             | What the executor was given                                                                    |
| `output`                                                | any             | What the executor answered; null until it succeeds                                             |
| `output_revision`                                       | integer \| null | The revision of the output entry it wrote; null when it wrote none                             |
| `error`                                                 | object \| null  | Why it failed                                                                                  |
| `created_by_principal_type` / `created_by_principal_id` | string \| null  | Who asked for the run; null when the case started it                                           |
| `on_behalf_of`                                          | object \| null  | The tool call it was written for ([On-behalf-of](./tools.md#writing-on-behalf-of-a-tool-call)) |
| `finished_at`                                           | string \| null  | ISO 8601 settle timestamp                                                                      |

### Export

| Field                                                   | Type           | Description                                                                                    |
| ------------------------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------- |
| `id`                                                    | string         | Public identifier (`pbk_exp_…`)                                                                |
| `case_id`                                               | string         | The case                                                                                       |
| `node_id`                                               | string         | The final node rendered                                                                        |
| `revision`                                              | integer        | The output or confirmation entry rendered                                                      |
| `playbook_version`                                      | integer        | The version whose transformation rendered it                                                   |
| `transformation`                                        | string         | The transformation's `name`                                                                    |
| `format`                                                | string         | The transformation's `format`                                                                  |
| `tool_id`                                               | string         | The tool called                                                                                |
| `status`                                                | string         | `running`, then `completed` or `failed`                                                        |
| `stale`                                                 | boolean        | `revision` is no longer the node's current output, or the node is no longer `done`             |
| `file_id`                                               | string \| null | The [file](./files.md); null until it succeeds, and once the file is deleted                   |
| `error`                                                 | object \| null | Why it failed                                                                                  |
| `created_by_principal_type` / `created_by_principal_id` | string \| null | Who asked for the export                                                                       |
| `on_behalf_of`                                          | object \| null | The tool call it was written for ([On-behalf-of](./tools.md#writing-on-behalf-of-a-tool-call)) |
| `finished_at`                                           | string \| null | ISO 8601 settle timestamp                                                                      |

### Upgrade

| Field                                                   | Type           | Description                                                                                                                                                                                                    |
| ------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                    | string         | Public identifier (`pbk_upg_…`)                                                                                                                                                                                |
| `case_id`                                               | string         | The case                                                                                                                                                                                                       |
| `from_version`                                          | integer        | The version the case was on                                                                                                                                                                                    |
| `to_version`                                            | integer        | The version it moved to                                                                                                                                                                                        |
| `diff`                                                  | object         | `{ added, removed, changed }`: node IDs added and removed, and each node, by `node_id`, whose `executor` or inputs changed, every input with its `change` (`added`, `removed`, `source`, `schema`, `required`) |
| `created_by_principal_type` / `created_by_principal_id` | string \| null | Who upgraded the case                                                                                                                                                                                          |
| `on_behalf_of`                                          | object \| null | The tool call it was written for ([On-behalf-of](./tools.md#writing-on-behalf-of-a-tool-call))                                                                                                                 |

## Key Concepts

### Definition checks

A create or update is refused with `400 PLAYBOOK_VALIDATION_FAILED` when the definition holds a duplicate node or input, an input reading a missing node or a field that node does not declare, an `execute` node without an executor or another kind with one, transformations on a non-final node, two transformations of one name on a node, or a cycle. `meta.problems` lists every one as a [validation problem](/docs/api#validation-problems) `{ code, path, message }`: `DUPLICATE_NODE`, `DUPLICATE_INPUT`, `MISSING_NODE`, `UNKNOWN_FIELD`, `EXECUTOR_REQUIRED`, `EXECUTOR_FORBIDDEN`, `TRANSFORMATIONS_NOT_FINAL`, `DUPLICATE_TRANSFORMATION`, `CYCLE`, `DUPLICATE_UPSTREAM`, `UNKNOWN_UPSTREAM` (an upstream naming no playbook of the project, or an `upstream` node naming an undeclared upstream) `UPSTREAM_CYCLE` (an upstream that reads the playbook back through its own upstreams) or `EXECUTOR_NOT_FOUND` (an executor or transformation tool that does not exist, checked with the author's permissions below), with `path` naming the node, input or transformation (`definition.nodes[0].inputs[1].source.node_id`). A transformation `format` outside the [export formats](#exports) is `400 VALIDATION_FAILED`. An `upstream` node's `node_id`, and every field read from that node, are checked against the upstream playbook's current version (`MISSING_NODE`, `UNKNOWN_FIELD`). [`POST /api/v1/playbooks/validate`](/docs/api/playbooks/validate-playbook) answers the same check without writing. The checks against the project — its other playbooks, and the executors below (`EXECUTOR_NOT_FOUND`) — run only when it names a `project_id`, which needs both `playbooks:ValidatePlaybook` and `playbooks:ListPlaybooks` on the project; `UPSTREAM_CYCLE` also needs the `playbook_id` an update would rewrite. A `playbook_id` without `project_id` is `400 VALIDATION_FAILED`, and one the project does not hold is `404 RESOURCE_NOT_FOUND`.

### Versions

`version` starts at 1 and increments on every write that changes `definition`; each version's definition is archived. A rename, a new description or a rewrite of the definition the playbook already holds leaves it alone. A case runs on the version it was created on, so editing a playbook never reshapes a case in flight until it is [upgraded](#upgrading-a-case).

[`PATCH /api/v1/playbooks/{playbook_id}`](/docs/api/playbooks/update-playbook) takes `expected_version` (or `If-Match`) and answers `409 VERSION_CONFLICT` on a stale one. [`POST /api/v1/playbooks/{playbook_id}/versions/{version}/restore`](/docs/api/playbooks/restore-playbook-version) writes an archived definition back as a new version. A playbook with cases cannot be deleted (`409 PLAYBOOK_HAS_CASES`), nor one another playbook's current definition declares as an upstream (`409 PLAYBOOK_HAS_DEPENDENTS`, `meta.playbooks` naming them).

### Node states

Computed from the case's entries and executions on each read, never stored:

| State      | When                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `blocked`  | A required input is unset or refused by its schema, or reads a node that is not `done`; an `upstream` node whose pulled node is not `done`, or missing from the bound case's version |
| `ready`    | Every required input is set and current, and there is no output yet                                                                                                                  |
| `running`  | An execution is queued or runs its executor                                                                                                                                          |
| `waiting`  | Its execution waits on the workflow task or orchestration run it started                                                                                                             |
| `done`     | The output exists and every input still has the revision it was produced from                                                                                                        |
| `stale`    | The output exists and an input changed since                                                                                                                                         |
| `failed`   | The last execution failed on the current inputs                                                                                                                                      |
| `rejected` | A `confirm` node's inputs were rejected and have not changed since                                                                                                                   |

`missing` names the required inputs a node lacks; `blocked_by` names the nodes it reads that are not `done`, and on an `upstream` node the `<upstream>.<node_id>` it pulls.

A `waiting` node names what it waits on in `run`, read live on every case read and null in every other state: `{ "type": "task", "id", "state", "automation_status" }` for a workflow task, `{ "type": "orchestration_run", "id", "status" }` for a run. A task whose state's dispatch failed with no `on_failure` reads `automation_status: "failed"`: it waits on a person to move it, and the node settles when it closes.

### Writing inputs

[`POST /api/v1/playbook-cases/{case_id}/inputs`](/docs/api/playbooks/write-playbook-case-inputs) writes a batch of manual inputs, all or none. Each write names the revision of the field it read in `expected_revision`, `null` for a field read as unset:

- a field written since is refused with `409 PLAYBOOK_INPUT_CONFLICT`, `meta.conflicts` naming each field with both revisions, and nothing in the batch is written;
- an input the case's version does not declare, one that reads another node, or a value its schema refuses is `400 PLAYBOOK_INPUT_INVALID`;
- a value equal to the field's current one writes no revision;
- a write made with a credential the case's own work runs as is `403 PLAYBOOK_SELF_WRITE` ([own work](#writes-from-a-cases-own-work)).

### What a node still needs

[`GET /api/v1/playbook-cases/{case_id}/missing`](/docs/api/playbooks/get-playbook-case-missing) takes a `node_id` and returns the manual inputs still unset or refused upstream of it, grouped in waves: nothing in a later wave can be reached before an earlier one's required inputs are filled. Each carries its `schema` and `description`, which is what an agent asks for, and `required`: an optional input is listed so the agent asks for it too, but it never blocks a node. Every item names the `case_id` to write it to: an `upstream` node before `node_id` adds the missing inputs of its bound case, so one read lists everything to ask.

### The cascade

Every write that can make a node runnable — a case created, inputs written, an execution settled, a pause lifted — queues an [execution](#execution) for each node that is now `ready` or `stale` with every required input set. A `confirm` node never runs. Queued executions are run by the server's worker; a node reading another runs once that one is `done`, so a node reading two changed nodes runs once.

A `collect` node's output is its input values. Any other node starts its executor with the node's input values, mapped through the executor's `input` when it declares one:

| Executor        | Started as                                  | Output                                                |
| --------------- | ------------------------------------------- | ----------------------------------------------------- |
| `agent`         | A generation with the input as JSON         | The object its output schema asked for, else its text |
| `tool`          | A call, under the project's tool guardrails | The tool's result                                     |
| `decider`       | A decision                                  | `answers_by_name`                                     |
| `workflow`      | A task whose `payload` is the input         | The task's `payload` when it closes                   |
| `orchestration` | A run whose `input` is the input            | The run's `output` when it succeeds                   |

When an execution settles, its output is written as an `output` entry and the nodes reading it run next:

- a value equal to the node's current output writes no revision, so nothing reading it goes `stale` and the cascade stops there;
- an execution whose node's inputs changed while it was queued or running settles as `superseded`, writes nothing, and the node runs again on the new inputs;
- a failed executor, a failed decision or orchestration run, or an agent that answers with neither text nor an object fails the execution with its cause in `error`. The node is `failed` and is not run again until [run by hand](#running-a-node);
- an agent, tool or decider whose server stopped while running it fails as `PLAYBOOK_EXECUTION_INTERRUPTED` and is never re-run on its own, so a call with side effects runs at most once.

A workflow task or an orchestration run settles its node when the task closes or the run ends. One that ends without an event — a run `cancelled` or `expired` — is read again every few minutes and settles the node then.

### Running a node

[`POST /api/v1/playbook-cases/{case_id}/nodes/{node}/run`](/docs/api/playbooks/run-playbook-case-node) runs one node now; it is how a `failed` node is retried, and how a `done` node is recomputed. Only a `ready`, `stale`, `failed` or `done` node with every required input set runs; a `confirm` node, a blocked one, a `running` one and a `waiting` one answer `409 PLAYBOOK_NODE_NOT_RUNNABLE`, `meta` carrying its `state`, `missing` and `blocked_by`. A paused case answers `409 PLAYBOOK_CASE_PAUSED`.

Without `wait` the request answers `201` with the execution `running` and it settles in the background; poll [`GET /api/v1/playbook-cases/{case_id}/executions/{execution_id}`](/docs/api/playbooks/get-playbook-case-execution). With `wait: true` it answers once the executor settles, or once it parks: a workflow task still open, or an orchestration run waiting on a person or a timer, settles the node when it closes or ends. See [Sync and Async](../advanced/sync-and-async.md). [`GET /api/v1/playbook-cases/{case_id}/executions`](/docs/api/playbooks/list-playbook-case-executions) lists a case's executions, newest first.

### Waiting on the cascade

[`POST /api/v1/playbook-cases/{case_id}/inputs`](/docs/api/playbooks/write-playbook-case-inputs), [`POST /api/v1/playbook-cases/{case_id}/nodes/{node}/confirmation`](/docs/api/playbooks/confirm-playbook-case-node) and [`POST /api/v1/playbook-cases/{case_id}/upgrade`](/docs/api/playbooks/upgrade-playbook-case) answer once the write is done; the executions it queues run in the background, and the case reads `automation_status: running` until they settle. With `wait: true` the answer waits until every execution the write queued, and every one those queue in turn, has settled or parked on a task or run, and returns the case as it then stands. A paused case answers at once. The wait is bounded by the execution lease (15 minutes); a case still running then answers as it stands. See [Sync and Async](../advanced/sync-and-async.md).

### Pausing a case

[`POST /api/v1/playbook-cases/{case_id}/pause`](/docs/api/playbooks/pause-playbook-case) stops a case starting anything: nothing is queued, and nothing already queued starts. Executions already running settle, and input writes are still accepted. [`POST /api/v1/playbook-cases/{case_id}/resume`](/docs/api/playbooks/resume-playbook-case) lifts the pause and runs what became runnable meanwhile; a case that is not paused answers `409 PLAYBOOK_CASE_NOT_PAUSED`. A paused [project](./projects.md) holds its cases' queued executions the same way: each case reads `automation_status: paused` with its own `pause_requested_at` unchanged, and running a node, exporting one or resuming a case answers `409 PROJECT_PAUSED` until the project resumes. [`GET /api/v1/playbook-cases`](/docs/api/playbooks/list-playbook-cases) takes `automation_status` to list the cases `running`, `waiting`, `paused` or `idle`; repeat it to OR values. A case `waiting` spends nothing of its own: what runs is the task or run it started, which may wait on a person indefinitely.

### Cases of an end user

A case created with `actor_id` belongs to that [actor](./actors.md), one of the playbook's project (`400 ACTOR_NOT_FOUND` otherwise); an actor may hold many cases. [`GET /api/v1/playbook-cases`](/docs/api/playbooks/list-playbook-cases) takes `actor_id` and `subject` (exact match) to find them.

Every operation on one case also takes `actor_id` as a query parameter: given, the call reaches only a case that belongs to that actor, and any other case, one with no actor included, is `404` as if it did not exist. A repeated `actor_id` is `400`. So an agent serving an end user is confined to that user's cases by a [builtin tool](./tools.md#builtin) whose [`preset_parameters`](./tools.md#pinning-to-a-per-run-value-context) pin it to the run's actor:

```json
{
  "type": "builtin",
  "actions": [
    "list-playbook-cases",
    "get-playbook-case",
    "get-playbook-case-missing",
    "write-playbook-case-inputs"
  ],
  "preset_parameters": { "actor_id": "{{context:actor_id}}" }
}
```

The pin reaches the create, the listing and every case operation alike, and the model cannot override it. `actor_id` in `tool_context` is server-set from the [session](./sessions.md)'s actor, so a turn with no actor fails the call with `400 MISSING_TOOL_CONTEXT_KEY` rather than reaching every case. Deleting an actor leaves its cases with `actor_id: null`.

### Upstream cases

A playbook declares `upstreams`, other playbooks of its project, and reads one of their nodes through an `upstream` node; later nodes read its output with an ordinary `{ node_id, field }` source. One `company` case (CNPJ, regime) can feed one DRE case per month this way, without copying a value.

- **Binding.** A case of such a playbook is created with `upstreams: { <name>: <case_id> }`, every declared name and no other, each a case of the declared playbook in the same project, of the same `actor_id`, that the caller may read (`playbooks:GetPlaybookCase`). Anything else is `400 PLAYBOOK_CASE_UPSTREAM_INVALID`, with a case the caller cannot read refused as one that does not exist. A binding is never replaced; an [upgrade](#upgrading-a-case) keeps it, drops it, or binds a newly declared name. Many cases may share one upstream case.
- **Pull.** The `upstream` node's first pull is automatic: at create, or when the pulled node first reaches `done`. It runs as an execution with no executor, and its output is the pulled node's output.
- **Refresh.** After that, a change upstream makes the node `stale` and the [cascade](#the-cascade) never runs it, so a closed month is never rewritten by a later profile change. [Running the node](#running-a-node) pulls the current value; the dependent case's own cascade then proceeds.
- **Versions.** A case reads its bound case's own version, and follows it when that case is [upgraded](#upgrading-a-case); a pulled node the new version lacks reads `blocked`. An upgrade of the dependent case fits its bindings to the target version (see [Upgrading a case](#upgrading-a-case)).
- **Deleting.** A case other cases are bound to is `409 PLAYBOOK_CASE_HAS_DEPENDENTS`, `meta.cases` naming them; delete those first.

### Confirming a node

A `confirm` node never runs: a person approves or rejects its inputs with [`POST /api/v1/playbook-cases/{case_id}/nodes/{node}/confirmation`](/docs/api/playbooks/confirm-playbook-case-node). `expected_revisions` maps each of the node's inputs to the revision read (`nodes[].inputs[].revision` on the case); an input that moved since is `409 PLAYBOOK_INPUT_CONFLICT` and nothing is written.

| `decision` | Writes                                          | Then                                                                                       |
| ---------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `approve`  | A `confirmation` entry: the node's input values | The node is `done` with them as its output, and the nodes reading it run                   |
| `reject`   | A `rejection` entry with the `reason`           | The node is `rejected`, and its readers blocked, until its inputs change or it is approved |

A confirmed node whose inputs change is `stale`, and holds everything reading it until it is confirmed again. Another node, or a `confirm` node with a required input unset or reading a node that is not `done`, is `409 PLAYBOOK_NODE_NOT_CONFIRMABLE`.

### Writes from a case's own work

A case refuses input writes, confirmations and upgrades made with the run-as credential of its own work — the case, one of its executions in flight, or the task or orchestration run one started — with `403 PLAYBOOK_SELF_WRITE`. So does a write on a project key carrying the [`On-Behalf-Of`](./tools.md#writing-on-behalf-of-a-tool-call) of a tool call an `agent` executor's generation made while its execution runs. An executor's result reaches its case only as the node's output.

The same holds for the work of every case that reads it as an [upstream](#upstream-cases), at any depth: a monthly DRE case's executor cannot write the `company` case it reads. A sibling bound to the same upstream case is not upstream of it and takes the write.

### Who a node runs as

A node's executor, and the tool of each of its [transformations](#exports), runs as the user or API key that wrote the case's playbook version, with that credential's permissions as they stand when it runs; an API key's own policies still bound it. Writing a definition therefore requires the start action of every executor it names — `agents:CreateAgentGeneration`, `tools:CallTool`, `deciders:CreateDecision`, `tasks:CreateTask` or `orchestrations:StartRun` — and `tools:CallTool` on every transformation's tool, and is refused with `403 PLAYBOOK_EXECUTOR_FORBIDDEN` otherwise. Each executor and transformation tool the writer may start must also exist: in the project, or, for an agent or tool, shared with it. One that does not is refused at the write with `400 PLAYBOOK_VALIDATION_FAILED`, an `EXECUTOR_NOT_FOUND` problem whose `path` names the field (`definition.nodes[2].executor.id`, `definition.nodes[3].transformations[0].tool`), so a mistyped id surfaces when the playbook is authored, not when a case runs. Each run and each export checks it again, so a permission removed since stops the next one with the same error. A definition with executors or transformations written with a trigger or OAuth token, or a version whose author no longer exists, is `409 PLAYBOOK_AUTHOR_UNAVAILABLE`.

A playbook declared in a [formation](./formations.md) (`type: playbook`, [properties](/docs/formations-types/playbook)) is written the same way: the version a deploy writes runs as the user or API key that deployed it, and the deploy needs these start actions too. An executor's `id` and a transformation's `tool` may be a `ref` to an agent, tool, decider, workflow or orchestration declared beside it. Cases are never declared: a formation holding a playbook with cases cannot be deleted.

### Exports

[`POST /api/v1/playbook-cases/{case_id}/nodes/{node}/exports`](/docs/api/playbooks/export-playbook-case-node) renders one revision of a final node as files, one [export](#export) per transformation it names in `transformations` (every one when omitted). Each transformation's tool is called with `case_id`, `subject`, `node_id`, `revision` and that revision's `output`, and must answer a file — an http tool with `execute.response_mode: base64` (see [Tools](./tools.md)) — whose content type is its `format`'s:

| `format` | Content type                                                                |
| -------- | --------------------------------------------------------------------------- |
| `csv`    | `text/csv`                                                                  |
| `docx`   | `application/vnd.openxmlformats-officedocument.wordprocessingml.document`   |
| `html`   | `text/html`                                                                 |
| `jpg`    | `image/jpeg`                                                                |
| `json`   | `application/json`                                                          |
| `md`     | `text/markdown`                                                             |
| `pdf`    | `application/pdf`                                                           |
| `png`    | `image/png`                                                                 |
| `pptx`   | `application/vnd.openxmlformats-officedocument.presentationml.presentation` |
| `txt`    | `text/plain`                                                                |
| `xlsx`   | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`         |

The file is kept in the project's [files](./files.md) under `/.system/playbooks/` and is never deleted by the case. An export never feeds a node: whatever a file shows is in the node's output, so every format of one revision agrees.

- Without `revision`, the node's current output is exported, which needs the node `done`: otherwise `409 PLAYBOOK_NODE_NOT_EXPORTABLE`, `meta` carrying its `state`. A `revision` names any earlier output or confirmation of the node (an [entry](#entries)); another is `400 VALIDATION_FAILED`.
- An export is `stale` once its revision is not the node's current output, or the node is not `done`.
- A node without transformations, or a name it does not declare, is `400 VALIDATION_FAILED`. A paused case is `409 PLAYBOOK_CASE_PAUSED`.
- A tool that fails or answers no file fails the export with `PLAYBOOK_EXPORT_FAILED`; a file of another content type with `PLAYBOOK_EXPORT_FORMAT_MISMATCH`. An export whose server stopped while rendering it fails as `PLAYBOOK_EXPORT_INTERRUPTED` and is not rendered again on its own.

Without `wait` the request answers `201` with every export `running`; poll [`GET /api/v1/playbook-cases/{case_id}/exports/{export_id}`](/docs/api/playbooks/get-playbook-case-export). With `wait: true` it answers once each has its `file_id` or its `error`; a tool call always waits. See [Sync and Async](../advanced/sync-and-async.md). [`GET /api/v1/playbook-cases/{case_id}/exports`](/docs/api/playbooks/list-playbook-case-exports) lists a case's exports, newest first, optionally for one `node_id` or `transformation`.

### Upgrading a case

[`POST /api/v1/playbook-cases/{case_id}/upgrade`](/docs/api/playbooks/upgrade-playbook-case) moves a case to the playbook's current version, or to the `version` named, an earlier one included. Values carry over by node ID, and every node is read against the new version:

| Change in the new version        | Effect on the case                                    |
| -------------------------------- | ----------------------------------------------------- |
| Node added                       | Open                                                  |
| Node removed                     | Leaves the structure; its [entries](#entries) stay    |
| An input now reads another field | The node is `stale`, and the cascade runs it again    |
| Input schema changed             | A value it refuses is `missing` again                 |
| Executor, title or description   | None; [run the node](#running-a-node) to recompute it |

The cascade then runs what became runnable, unless the case is [paused](#pausing-a-case). An execution running answers `409 PLAYBOOK_CASE_BUSY`, `meta.executions` naming each; one queued but not started settles `superseded`. Each upgrade is recorded as an [upgrade](#upgrade), listed by [`GET /api/v1/playbook-cases/{case_id}/upgrades`](/docs/api/playbooks/list-playbook-case-upgrades), newest first; the version the case is already on records nothing. A version the playbook does not have is `400 VALIDATION_FAILED`, and an upgrade from the case's own work is `403 PLAYBOOK_SELF_WRITE`.

The case's [upstream](#upstream-cases) bindings follow the target version:

| Binding                                                        | At upgrade                                                          |
| -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Name the target declares on the same playbook                  | Kept; naming it in `upstreams` is refused                           |
| Name the target no longer declares, or declares on another one | Dropped                                                             |
| Name the target declares that the case does not bind           | Bound from `upstreams: { <name>: <case_id> }`, checked as at create |

A declared name left unbound, or any other `upstreams` the create rules refuse, is `400 PLAYBOOK_CASE_UPSTREAM_INVALID` and moves nothing.

### Entries

[`GET /api/v1/playbook-cases/{case_id}/entries`](/docs/api/playbooks/list-playbook-case-entries) lists every value written to a case, newest first, optionally for one `node_id`. Entries are never rewritten; deleting the case deletes them.

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
      { "id": "revenue", "title": "Annual revenue", "kind": "collect",
        "inputs": [{ "name": "amount", "schema": { "type": "number" },
                     "required": true, "source": "manual" }] },
      { "id": "pricing", "title": "Pricing", "kind": "collect", "final": true,
        "inputs": [
          { "name": "revenue", "schema": { "type": "number" }, "required": true,
            "source": { "node_id": "revenue", "field": "output.amount" } },
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
          id: 'revenue',
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
          id: 'pricing',
          title: 'Pricing',
          kind: 'collect',
          final: true,
          inputs: [
            {
              name: 'revenue',
              schema: { type: 'number' },
              required: true,
              source: { node_id: 'revenue', field: 'output.amount' },
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
        { "id": "revenue", "title": "Annual revenue", "kind": "collect",
          "inputs": [{ "name": "amount", "schema": { "type": "number" },
                       "required": true, "source": "manual" }] },
        { "id": "pricing", "title": "Pricing", "kind": "collect", "final": true,
          "inputs": [
            { "name": "revenue", "schema": { "type": "number" }, "required": true,
              "source": { "node_id": "revenue", "field": "output.amount" } },
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

### Bind an upstream case

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat create-playbook-case --playbook-id pbk_… --subject 'ACME Ltda · 2026-08' \
  --upstreams '{ "company": "pbk_case_…" }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.createPlaybookCase({
  path: { playbook_id: 'pbk_…' },
  body: {
    subject: 'ACME Ltda · 2026-08',
    upstreams: { company: 'pbk_case_…' },
  },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbooks/pbk_…/cases \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "subject": "ACME Ltda · 2026-08", "upstreams": { "company": "pbk_case_…" } }'
```

</TabItem>
</Tabs>

### Ask what a node still needs

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat get-playbook-case-missing --case-id pbk_case_… --node-id pricing
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.getPlaybookCaseMissing({
  path: { case_id: 'pbk_case_…' },
  query: { node_id: 'pricing' },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl "https://api.example.com/api/v1/playbook-cases/pbk_case_…/missing?node_id=pricing" \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

```json
{
  "case_id": "pbk_case_…",
  "node_id": "pricing",
  "waves": [
    [
      {
        "node_id": "revenue",
        "input": "amount",
        "schema": { "type": "number" }
      }
    ],
    [
      {
        "node_id": "pricing",
        "input": "margin",
        "schema": { "type": "number" }
      }
    ]
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
    { "node_id": "revenue", "name": "amount", "value": 4000000, "expected_revision": null },
    { "node_id": "pricing", "name": "margin", "value": 0.3, "expected_revision": null }
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
        node_id: 'revenue',
        name: 'amount',
        value: 4000000,
        expected_revision: null,
      },
      {
        node_id: 'pricing',
        name: 'margin',
        value: 0.3,
        expected_revision: null,
      },
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
      { "node_id": "revenue", "name": "amount", "value": 4000000, "expected_revision": null },
      { "node_id": "pricing", "name": "margin", "value": 0.3, "expected_revision": null }
    ]
  }'
```

</TabItem>
</Tabs>

### Confirm a node

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat confirm-playbook-case-node \
  --case-id pbk_case_… \
  --node approve \
  --decision approve \
  --expected-revisions '{ "amount": 3 }'
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.confirmPlaybookCaseNode({
  path: { case_id: 'pbk_case_…', node: 'approve' },
  body: { decision: 'approve', expected_revisions: { amount: 3 } },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbook-cases/pbk_case_…/nodes/approve/confirmation \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "decision": "approve", "expected_revisions": { "amount": 3 } }'
```

</TabItem>
</Tabs>

### Retry a failed node

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat run-playbook-case-node --case-id pbk_case_… --node pricing --wait true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.runPlaybookCaseNode({
  path: { case_id: 'pbk_case_…', node: 'pricing' },
  body: { wait: true },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbook-cases/pbk_case_…/nodes/pricing/run \
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
  "node_id": "pricing",
  "executor": { "type": "tool", "id": "tool_…" },
  "status": "completed",
  "result": "current",
  "output": { "price": 12000 },
  "output_revision": 5
}
```

### Export a final node

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat export-playbook-case-node \
  --case-id pbk_case_… \
  --node pricing \
  --transformations '["proposal"]' \
  --wait true
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.exportPlaybookCaseNode({
  path: { case_id: 'pbk_case_…', node: 'pricing' },
  body: { transformations: ['proposal'], wait: true },
});
if (error) throw new Error(JSON.stringify(error));
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbook-cases/pbk_case_…/nodes/pricing/exports \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{ "transformations": ["proposal"], "wait": true }'
```

</TabItem>
</Tabs>

```json
{
  "data": [
    {
      "id": "pbk_exp_…",
      "case_id": "pbk_case_…",
      "node_id": "pricing",
      "revision": 5,
      "transformation": "proposal",
      "format": "pdf",
      "status": "completed",
      "stale": false,
      "file_id": "file_…"
    }
  ]
}
```

### Upgrade a case

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat upgrade-playbook-case --case-id pbk_case_…
soat list-playbook-case-upgrades --case-id pbk_case_…
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
const { data, error } = await soat.playbooks.upgradePlaybookCase({
  path: { case_id: 'pbk_case_…' },
  body: {},
});
if (error) throw new Error(JSON.stringify(error));
const upgrades = await soat.playbooks.listPlaybookCaseUpgrades({
  path: { case_id: 'pbk_case_…' },
});
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbook-cases/pbk_case_…/upgrade \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{}'
curl https://api.example.com/api/v1/playbook-cases/pbk_case_…/upgrades \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

### Pause a case

<Tabs groupId="client">
<TabItem value="cli" label="CLI" default>

```bash
soat pause-playbook-case --case-id pbk_case_…
soat resume-playbook-case --case-id pbk_case_…
```

</TabItem>
<TabItem value="sdk" label="SDK">

```ts
await soat.playbooks.pausePlaybookCase({ path: { case_id: 'pbk_case_…' } });
await soat.playbooks.resumePlaybookCase({ path: { case_id: 'pbk_case_…' } });
```

</TabItem>
<TabItem value="curl" label="curl">

```bash
curl -X POST https://api.example.com/api/v1/playbook-cases/pbk_case_…/pause \
  -H "Authorization: Bearer <token>"
curl -X POST https://api.example.com/api/v1/playbook-cases/pbk_case_…/resume \
  -H "Authorization: Bearer <token>"
```

</TabItem>
</Tabs>

## Errors

| Code                              | Status | When                                                                                                                                                                                                                                        |
| --------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `VALIDATION_FAILED`               | 400    | The definition's shape cannot be read, a missing `subject`, or an unknown `node_id` on `missing` or `node` on a run; on an export, a node without transformations, an undeclared transformation or a revision that is no output of the node |
| `ACTOR_NOT_FOUND`                 | 400    | An `actor_id` on a case create that names no actor of the playbook's project                                                                                                                                                                |
| `PLAYBOOK_VALIDATION_FAILED`      | 400    | The definition has graph problems; `meta.problems` lists them                                                                                                                                                                               |
| `PLAYBOOK_INPUT_INVALID`          | 400    | An input write names an undeclared or non-manual input, or a value its schema refuses                                                                                                                                                       |
| `NAME_CONFLICT`                   | 409    | Another playbook in the project has the name                                                                                                                                                                                                |
| `VERSION_CONFLICT`                | 409    | `expected_version` is stale                                                                                                                                                                                                                 |
| `PLAYBOOK_HAS_CASES`              | 409    | A delete of a playbook that has cases                                                                                                                                                                                                       |
| `PLAYBOOK_HAS_DEPENDENTS`         | 409    | A delete of a playbook another playbook declares as an upstream                                                                                                                                                                             |
| `PLAYBOOK_CASE_UPSTREAM_INVALID`  | 400    | A case create or upgrade whose `upstreams` leaves a declared upstream unbound, names an undeclared or already bound one, or binds a case of another playbook, project or actor, or one the caller may not read                              |
| `PLAYBOOK_CASE_HAS_DEPENDENTS`    | 409    | A delete of a case other cases are bound to as their upstream                                                                                                                                                                               |
| `PLAYBOOK_INPUT_CONFLICT`         | 409    | An input write's `expected_revision` is not the field's current one                                                                                                                                                                         |
| `PLAYBOOK_EXECUTOR_FORBIDDEN`     | 403    | The version's author may not start an executor the definition names                                                                                                                                                                         |
| `PLAYBOOK_AUTHOR_UNAVAILABLE`     | 409    | The version has no author a node can run as                                                                                                                                                                                                 |
| `PLAYBOOK_NODE_NOT_RUNNABLE`      | 409    | The node is a `confirm` node, blocked, `running` or `waiting`                                                                                                                                                                               |
| `PLAYBOOK_CASE_PAUSED`            | 409    | A run of a node in a paused case                                                                                                                                                                                                            |
| `PLAYBOOK_CASE_NOT_PAUSED`        | 409    | A resume of a case that is not paused                                                                                                                                                                                                       |
| `PROJECT_PAUSED`                  | 409    | A run, an export or a case resume while the case's [project](./projects.md) is paused                                                                                                                                                       |
| `PLAYBOOK_NODE_NOT_CONFIRMABLE`   | 409    | A confirmation of a node that is not a `confirm` node, or is blocked                                                                                                                                                                        |
| `PLAYBOOK_SELF_WRITE`             | 403    | An input write, confirmation or upgrade from the case's own work, or from that of a case reading it as an upstream                                                                                                                          |
| `PLAYBOOK_NODE_NOT_EXPORTABLE`    | 409    | An export of the latest revision of a node that is not `done`                                                                                                                                                                               |
| `PLAYBOOK_EXPORT_FAILED`          | 422    | On an export's `error`: its tool failed or answered no file                                                                                                                                                                                 |
| `PLAYBOOK_EXPORT_FORMAT_MISMATCH` | 422    | On an export's `error`: its file is not of the transformation's `format`                                                                                                                                                                    |
| `PLAYBOOK_EXPORT_INTERRUPTED`     | 500    | On an export's `error`: the server stopped while rendering it                                                                                                                                                                               |
| `PLAYBOOK_CASE_BUSY`              | 409    | An upgrade while one of the case's executions is running                                                                                                                                                                                    |
