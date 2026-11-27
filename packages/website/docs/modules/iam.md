---
description: "SOAT's AWS-inspired IAM engine for authentication and fine-grained authorization with Effect, Action, Resource, and Condition policy statements."
---

# IAM

Authentication, identity, and fine-grained authorization: an AWS IAM-inspired policy engine with `Effect`, `Action`, `Resource`, and `Condition` statements.

## Overview

Every request is authenticated via JWT (users) or an API key, and authorized entirely through attached **policy documents**; there is no separate project membership gate.

- **Users** — identity, roles, JWT ([Users](#users))
- **Policy Documents** — permission rules attached to users and API keys ([Policies](./policies.md))
- **Policy Engine** — allow/deny resolution at request time
- **Authorization Model** — policy resolution per caller type ([Authorization Model](#authorization-model))

> See the [Permissions Reference](../permissions.md) for the IAM action strings for this module.

How authority is formed, stored and narrowed: [The Permission Model](../advanced/permission-model.md).

## Related Tutorials

- [Permissions in Practice - Step 4 (Create policies)](/docs/tutorials/permissions#step-4--create-policies)
- [Permissions in Practice - Step 6 (Create API keys)](/docs/tutorials/permissions#step-6--create-api-keys)
- [Permissions in Practice - Step 7 (Verify permissions)](/docs/tutorials/permissions#step-7--verify-permissions)

## Authentication

Three methods, all via `Authorization: Bearer <token>`.

Every token the server signs states its kind, and each endpoint accepts only its own kinds: a bearer on the REST API and on `/mcp` is a login, OAuth or [IAM token](#iam-tokens); a file download token and an ingestion-callback token are accepted only by the one route they were issued for. Any other token is `401`.

### JWT (Users)

[`POST /api/v1/users/login`](/docs/api/users/login-user) with username and password returns a signed JWT carrying the user's public ID and role. An admin holds the unrestricted grant; a regular user holds its attached [policies](./policies.md) (see [Grant and caps](#grant-and-caps)).

### API Keys

Keys are prefixed `sk_` with a `key_` public ID, always scoped to a single project via `project_id`, optionally with their own policies. With key policies, **intersection semantics** apply: the owning user's policies _and_ the key's must both allow the action, so a key never exceeds its owner. See [API Keys](./api-keys.md) and [Permissions in Practice - Step 7 (Verify permissions)](/docs/tutorials/permissions#step-7--verify-permissions).

### IAM Tokens

An API key scoped to a project issues a short-lived token that acts as the key held to a narrower policy, for a caller the key serves on behalf of someone with less reach. [`POST /api/v1/iam/tokens`](/docs/api/iam/create-iam-token) needs `iam:CreateToken`:

```json
{
  "policy": {
    "statement": [
      { "effect": "Allow", "action": ["agents:CreateAgentGeneration"] }
    ]
  },
  "principal": { "type": "service", "id": "billing-sync" },
  "ttl_seconds": 300
}
```

It answers `201 { "token", "jti", "expires_at" }`; `jti` is the id the audit log records. A denial by the bound names `principal` in `meta.denied_by` and the message (`denied_by: { "type": "service", "id": "billing-sync" }`), or the token, `iam_token` with its `jti`, when it was minted with none.

- The bound is `policy`, an inline document, or `policy_ids`, policies of the key's project or global ones; exactly one. An invalid document or an unknown id is `400 IAM_TOKEN_POLICY_INVALID`.
- `ttl_seconds` runs from 30 to 900 (default 300). An expired token is `401`.
- Every request is checked against the key's grant **as it stands at that request** ∩ the bound: an `Allow` beyond the key grants nothing, and a permission removed from the key, or the key deleted, leaves every live token too.
- Work the token starts keeps the bound after the token expires: a generation (its tool calls, approvals and `tool-outputs` continuations), a session turn, a task dispatch, an orchestration run, a playbook version and a manual trigger fire. `policy_ids` are re-read by id; an inline `policy` is kept as a snapshot.
- Only an API key scoped to a project issues one, or a [group key](./groups.md#group-keys) naming `project_id`, a project of its group: the token acts in that one project. A user login, an unscoped key, a project-scoped token (OAuth or IAM) and a request carrying `On-Behalf-Of` get `403 IAM_TOKEN_ISSUER_NOT_ALLOWED`. A token never creates an API key (`403 CREDENTIAL_NARROWED`).
- Records name the issuing key as the principal; `principal` is opaque, grants nothing, and is recorded with the token's `jti` under `detail.iam_token` on every [audit log](./audit-log.md) entry the token makes, and as [`acts_for`](./audit-log.md#acting-for-a-principal) on every record naming who acted that the token writes.
- An `mcp` tool called on the token, or by work it starts, carries the bound and `principal` encrypted in its [assertion](./tools.md#tool-assertions), and, when the tool sets [`mcp.forward_principal`](./tools.md#tool-assertions), `principal` signed in the clear as its `acts_for` claim; a tool server calling back with that assertion in [`On-Behalf-Of`](./tools.md#writing-on-behalf-of-a-tool-call) is capped by them, and the records it writes serve `principal` as [`acts_for`](./audit-log.md#acting-for-a-principal).
- A request on the token may itself carry [`On-Behalf-Of`](./tools.md#writing-on-behalf-of-a-tool-call) of a call made in the token's project: it is held to the token's bound ∩ the assertion's authority, and so is work it starts.

### Pinning a `tool_context` layer

A token may carry `tool_context`, a layer of keys its issuer pins for everything the token does:

```json
{
  "policy": {
    "statement": [
      { "effect": "Allow", "action": ["agents:*", "tools:CallTool"] }
    ]
  },
  "tool_context": { "tenant_id": "acct_42" }
}
```

- On every tool call the token makes, and every call its work starts (a generation's tool calls, nested `builtin` calls, a `call-tool` relay, a manual trigger fire), a caller key the layer names is dropped in any casing and the layer's value is sent instead. A model or caller writing `tenant_id` gets the layer's value.
- A tool server calling back with the [assertion](./tools.md#tool-assertions) of a call the token or its work made, in [`On-Behalf-Of`](./tools.md#writing-on-behalf-of-a-tool-call), carries the layer too, stamped over its own credential's: its tool calls and the work it starts send the layer's value. A scheduled trigger firing carries no layer.
- The stamp happens where the call enters the tool, after [admission](#admission): admission sees the caller's own `tool_context`.
- Keys follow the [`tool_context` key grammar](./tools.md); a server identity key (`session_id`, `actor_id`, `actor_external_id`, `calling_project_id`) is `400 INVALID_TOOL_CONTEXT_KEY`.
- A deployment may reserve a key prefix to token layers (`SOAT_RESERVED_TOOL_CONTEXT_PREFIX`, see [Configuration](#configuration)). A key under it, in any casing, is `400 INVALID_TOOL_CONTEXT_KEY` on every request that carries a `tool_context` (a generation, a session message, an approval, a trigger firing, a write that stores one, and the same requests made by a `builtin` tool), and in a formation template at validate, plan and deploy, at any depth (a loop node's `item_tool_context`). A direct tool call's `tool_context` is the exception: the key is dropped there, and the token's layer stamped over it. A token layer may carry one only when the issuing key's grant allows `iam:PinReservedToolContext` on `srn:<project_id>:iam_token:*`, else `400 INVALID_TOOL_CONTEXT_KEY`.

### Revoking a principal

Work stores the `principal` it acts for. When the caller's own principal goes away (its user deleted, its key revoked), [`POST /api/v1/iam/principal-revocations`](/docs/api/iam/revoke-iam-principal) revokes it in the project, for good; it needs `iam:RevokePrincipal` on `srn:<project_id>:iam_principal:*`:

```json
{ "principal": { "type": "service", "id": "billing-sync" } }
```

It answers `204`, also for a principal already revoked. `project_id` defaults to the credential's project. From then on every work acting for that principal in the project (a generation and its `tool-outputs` resumes, a session turn, a task dispatch, an orchestration run, a trigger firing) resolves no caller: its next step fails `WORK_AUTHORITY_MISSING`, whoever resumes it. Work for another principal on the same key runs.

## Policy Documents

A policy document is a JSON object of statements:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:GetDocument", "documents:ListDocuments"],
      "resource": ["srn:proj_ABC:document:doc_XYZ"]
    },
    {
      "effect": "Deny",
      "action": ["secrets:*"],
      "resource": ["srn:proj_ABC:secret:sec_PROD_KEY"]
    }
  ]
}
```

### Statement

| Field       | Type       | Required | Description                                                                                    |
| ----------- | ---------- | -------- | ---------------------------------------------------------------------------------------------- |
| `effect`    | `string`   | Yes      | `"Allow"` or `"Deny"`                                                                          |
| `action`    | `string[]` | Yes      | Actions this statement applies to (supports wildcards)                                         |
| `resource`  | `string[]` | No       | SRNs this statement applies to (default: `["*"]`)                                              |
| `condition` | `object`   | No       | Conditions that must be true for the statement to apply                                        |
| `denial`    | `object`   | No       | On a `Deny`: the code and message a refusal it decides answers ([Denial codes](#denial-codes)) |

Documents are managed globally via [Policies](./policies.md) and attached to users or API keys. Worked example: [Permissions in Practice - Step 4 (Create policies)](/docs/tutorials/permissions#step-4--create-policies).

## SOAT Resource Names (SRNs)

Every addressable entity has an SRN:

```
srn:<project_id>:<resource_type>:<resource_id>
```

Examples:

| SRN                             | Description                |
| ------------------------------- | -------------------------- |
| `srn:proj_ABC:document:doc_XYZ` | A specific document        |
| `srn:proj_ABC:document:*`       | All documents in a project |
| `srn:proj_ABC:file:*`           | All files in a project     |
| `srn:proj_ABC:actor:actor_123`  | A specific actor           |
| `srn:*:*:*`                     | Everything (admin-level)   |

### Project Segment and Policy Scoping

The `<project_id>` segment is the primary project restriction. A [project policy](./policies.md#project-and-global-policies) may name only its own project, and an `Allow` there without `resource` grants every resource of that project; a global policy may name any:

- `resource: ["*"]` — all resources in **all projects**
- `resource: ["srn:proj_ABC:*:*"]` — `proj_ABC` only
- `resource: ["srn:*:document:*"]` — all documents across all projects
- `resource: ["srn:proj_AB*:document:*"]` — documents in every project whose id matches the glob (`*`, `?`), in a list without `project_id` too

:::tip
Grant a **user** (JWT) a project with `resource: ["srn:proj_ABC:*:*"]`. API keys are scoped via `project_id` (see [API Keys](./api-keys.md#project-scoping)).
:::

### Resource Types

| Resource Type   | Public ID Prefix | Module          |
| --------------- | ---------------- | --------------- |
| `document`      | `doc_`           | Documents       |
| `file`          | `file_`          | Files           |
| `actor`         | `actor_`         | Actors          |
| `conversation`  | `conv_`          | Conversations   |
| `project`       | `proj_`          | Projects        |
| `policy`        | `pol_`           | Policies        |
| `api-key`       | `key_`           | API Keys        |
| `agent`         | `agent_`         | Agents          |
| `session`       | `sess_`          | Sessions        |
| `memory_store`  | `mstore_`        | Memories        |
| `tool`          | `tool_`          | Tools           |
| `guardrail`     | `guard_`         | Guardrails      |
| `orchestration` | `orch_`          | Orchestrations  |
| `dataset`       | `dset_`          | Evaluations     |
| `eval`          | `eval_`          | Evaluations     |
| `decider`       | `dcd_`           | Deciders        |
| `decision`      | `dec_`           | Deciders        |
| `generation`    | `gen_`           | Generations     |
| `trace`         | `trace_`         | Traces          |
| `chain`         | `chain_`         | Chains          |
| `quota`         | `quota_`         | Quotas          |
| `model_route`   | `route_`         | Model Routes    |
| `ingestionRule` | `igr_`           | Ingestion Rules |
| `audit`         | `audit_`         | Audit Log       |
| `usage`         | `uthr_`          | Usage           |
| `share`         | `shr_`           | Shares          |

A child resource has no type of its own: it is named through the parent its
routes authorize against. A **memory** and a **memory rule** are named by their
`memory_store`; an orchestration **run** by its `orchestration`; a dataset
**item** by its `dataset`; an eval **run** by its `eval`.

Three types are spelled camelCase — `aiProvider`, `ingestionRule` and `apiKey` —
where every other type is snake_case. `srn:<project_id>:ingestion_rule:…` matches
nothing; the spelling in this table is the one that works.

## Actions

Actions follow `module:Operation`. Full list: [Permissions Reference](../permissions.md).

### Action Surface Mapping

Every action maps to one operation reachable through every client surface, e.g. `actors:CreateActor`:

| Surface           | Convention                    | Example                                                |
| ----------------- | ----------------------------- | ------------------------------------------------------ |
| **Permission**    | `module:OperationName`        | `actors:CreateActor`                                   |
| **REST endpoint** | `METHOD /api/v1/...`          | [`POST /api/v1/actors`](/docs/api/actors/create-actor) |
| **MCP tool**      | kebab-case operation name     | `create-actor`                                         |
| **CLI command**   | `soat <kebab-case>`           | `soat create-actor`                                    |
| **SDK method**    | `soat.<module>.<camelCase>()` | `soat.actors.createActor()`                            |

A caller may invoke an operation iff the resolved policy grants the action, on any surface.

### Wildcards

- `*` — matches all actions across all modules
- `module:*` — matches all actions in a specific module (e.g., `documents:*`)

### Deployment-registered Actions

A deployment fronting SOAT with routes of its own registers their actions and resource types in the file `IAM_REGISTRATIONS_CONFIG` names (see [Configuration](#configuration)). Policies may then name them like built-in ones (`channels:GetChannel`, `channels:*`, `srn:<project_id>:channel:<id>`), and the deployment asks the engine before serving its own route with [`POST /api/v1/iam/check`](/docs/api/iam/check-iam-permission):

```json
{
  "action": "channels:GetChannel",
  "resource": "srn:proj_V1StGXR8Z5jdHi6B:channel:ch_1",
  "context": { "tags": { "team": "red" } }
}
```

- The answer is `200 { "allowed": true | false }`, never `403`: the caller's own policies (owner, key or OAuth boundary, project scope), evaluated as for a built-in route.
- `action` must be a registered `module:Operation` or a built-in action (`agents:DeleteAgent`); an unknown action or a wildcard is `400 VALIDATION_FAILED`.
- The SRN's type must be one the action's module registered, or for a built-in action one its module's routes check it on (`agent` or `session` for `agents:*`); any other type is `400 VALIDATION_FAILED`. Each operation's spec names the type its route checks its action on in `x-iam-resource-type` (`agents:SendSessionMessage` → `session`), beside `x-iam-action`. A route that also checks the action on other types, each needed for the whole answer, lists them in `x-iam-also-checked-on`, each with the parameter that names the resources it is checked on (`pinned_by`; absent is any): `knowledge:SearchKnowledge` on `document`, then `memory_store` (pinned by `memory_store_ids`) and `memory`, whose denial leaves the memory half out. `projects:*` is checked on the whole project, `srn:<project_id>:*:*`, as the project's own routes check it, and that SRN takes no `context.tags`; `users:*` is an admin gate, not a policy, so it is always `400`. `<id>` may be `*` for a create or a list. The project and resource are not looked up.
- `context.tags` feeds `iam:ResourceTag/<key>` conditions, and `iam:ResourceType` is the SRN's type.
- A [group action](./groups.md#group-actions) is checked on its group's SRN, `srn:group:<group_id>:<type>/<id|*>` or `srn:group:<group_id>:*`, and nowhere else; it takes no `context.tags`. A credential pinned to a project is never allowed one.
- A check is not an action, so it writes no [audit log](./audit-log.md) entry.

### The writer rule

A resource that acts after the write that made it does no more than whoever writes it. Every create and every edit of an agent, trigger, webhook, user, [group](./groups.md), API key, orchestration, share, decider, eval, guardrail, ingestion rule, memory rule, playbook version, tool or [registered formation resource](./formations.md#what-a-write-performs) is checked against the resource as the write leaves it, whichever fields the request names:

| The resource           | The writer must hold                                                                                                                                                                              | Refusal                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| carries `policy_ids`   | every grant of each policy, where the resource acts (an API key is instead capped by its owner, see [API keys](./api-keys.md))                                                                    | `403 POLICY_GRANT_NOT_HELD` |
| starts a target        | the target's start action: `agents:CreateAgentGeneration`, `tools:CallTool`, `deciders:CreateDecision`, `tasks:CreateTask`, `orchestrations:StartRun`, `evaluations:RunEval`                      | `403 ACTION_NOT_HELD`       |
| grants a shared action | that action on the shared resource                                                                                                                                                                | `403 ACTION_NOT_HELD`       |
| calls actions          | each action calling it performs: a [`builtin` tool](./tools.md#who-may-write-a-tool)'s, or what a [registered MCP server](#registered-mcp-servers) declares for each of an `mcp` tool's `actions` | `403 ACTION_NOT_HELD`       |
| sends a secret         | `secrets:UseSecret` on it                                                                                                                                                                         | `403 FORBIDDEN`             |

An `ACTION_NOT_HELD` refused by a `Deny` carrying a [`denial`](#denial-codes) answers that denial instead. A version restore or a release is an edit. A deployment's own resource deployed through a formation is checked by the runtime from its registration (`writer`, see [Formations](./formations.md#what-a-write-performs)); written through the deployment's own routes, the deployment asks the same of its writer with [`POST /api/v1/iam/check`](/docs/api/iam/check-iam-permission), from the same declaration.

### Registered MCP servers

A deployment serving an MCP server of its own declares, beside its modules, what each of its tools performs (`mcp_tools`, see [Configuration](#configuration)). An `mcp` tool whose `mcp.url` is such a server (compared without a trailing slash) must list its `actions`, each a tool the server declares, else `400 VALIDATION_FAILED`; its writer must hold every action they declare, on the declared type, else `403 ACTION_NOT_HELD`. Each declared action must be one `iam/check` answers on that type, or the boot fails.

### The builtin catalog

A deployment declares which actions a [`builtin` tool](./tools.md#builtin) may name (`builtin_actions`, see [Configuration](#configuration)):

- **`allow`**: the native actions offered. Absent offers every one; a name that is not a native action fails the boot. Naming any other native action in a `builtin` tool's `actions` is `400 VALIDATION_FAILED`, over REST, inline on an agent and in a formation.
- **`add`**: actions the deployment serves itself, on one MCP server: `url` and `tools`, shaped like an `mcp_tools` entry (each name → the actions calling it performs). A name that is also a native action fails the boot, and so does `add` without [`TOOL_ASSERTION_PRIVATE_KEY`](./tools.md#tool-assertions): an added action reaches its server only with the signed assertion.

An added action is named in `actions` like a native one; its writer must hold every action it declares, else `403 ACTION_NOT_HELD`.

### Admission

A deployment that gates runtime writes for its own reasons (a plan limit, a cap) registers an admission service (`admission`, see [Configuration](#configuration)) and the runtime writes it is asked about. Before a declared write executes, after its authorization allowed it, the runtime `POST`s the service a signed question (`X-Soat-Signature`, the [webhook scheme](./webhooks.md)):

```json
{
  "action": "triggers:CreateTrigger",
  "project_id": "proj_...",
  "resource_type": "trigger",
  "resource_id": null,
  "body": { "name": "nightly", "type": "schedule", "cron": "0 3 * * *" },
  "principal": { "type": "user", "id": "user_..." }
}
```

`project_id` is the project the write lands in: the one the request names, else a project-scoped credential's own. `resource_id` names the resource an edit targets (`null` on a create); `body` is the write as it will be applied: the request body, or a formation resource's properties once resolved.

`principal.type` is one of `user`, `api_key`, `trigger`, `eval`, `decider`, `ingestion_rule`, `memory_rule`, `playbook_version` (`ActingPrincipalType`). The question is the `AdmissionRequest` schema and a refusal's body the `AdmissionRefusal` schema, both in the spec `GET /api/v1/openapi.json` serves (source: `admission.yaml`).

- A `2xx` admits the write.
- A `4xx` with `{ "error": { "code", "message", "hint"?, "meta"? } }` refuses it: the caller receives that status, `code`, `message`, `hint` and `meta` as sent (without a `hint`, the `ADMISSION_REFUSED` one), on every write the service can be asked about (each documents it as its `4XX` response). `code` is any identifier matching `^[A-Za-z_][A-Za-z0-9_]{0,63}$`, so a service's own lowercase codes pass unchanged.
- Anything else (unreachable, timed out, `5xx`, a refusal outside that shape) refuses it with `502 ADMISSION_UNAVAILABLE`. An unanswered question is never a pass.

It is asked where the write is decided, so every way in is covered: a REST call, a `builtin` tool call (which runs through the same stack, see [Tools](./tools.md#builtin)) and a formation's create or update ([Formations](./formations.md#admission)). A start is a declared action like any other (`agents:CreateAgentGeneration`, `orchestrations:StartRun`, `triggers:FireTrigger`, `tools:CallTool`): asked before a streamed answer opens. A read and an undeclared action never call it. Admission only refuses: it cannot allow what authorization refused.

#### Steps of internal work

Each step work takes on its own is asked too, after the check that authorizes it: a generation (`agents:CreateAgentGeneration`, or `agents:SendSessionMessage` in a session), a tool call (`tools:CallTool`) and a start (`orchestrations:StartRun`, `evaluations:RunEval`, `deciders:CreateDecision`, `tasks:CreateTask`), whether a trigger firing, an orchestration node, a task's automation, a playbook node, an eval item or a generation's own tool call takes it. The question carries `body: null` and names the principal the work acts as. A step the request itself was asked about ([`POST /api/v1/agents/{agent_id}/generate`](/docs/api/agents/create-agent-generation) and the turn it starts) is not asked again.

A refused step stops what took it:

| Work | On a refusal |
| --- | --- |
| Trigger firing | Recorded `failed` with the refusal as `error`; nothing generates |
| Orchestration run | Parks on the operator pause (`awaiting_input`, `required_action.type: paused`), `pause_reason` naming the refusal |
| Task automation | The task pauses, `pause_reason` naming the refusal; `automation_status: paused` |
| Playbook case | The case pauses; the node's execution stays `queued` with the refusal as `error` |
| Eval run | Fails with the refusal as `error`; its other items do not run |
| Generation's tool call | The call's result carries the refusal, as for any failed call |

Resuming is the caller's, through the work's own resume route ([`POST /api/v1/orchestration-runs/{orchestration_run_id}/resume`](/docs/api/orchestrations/resume-orchestration-run), [`POST /api/v1/tasks/{task_id}/resume`](/docs/api/tasks/resume-task), [`POST /api/v1/playbook-cases/{case_id}/resume`](/docs/api/playbooks/resume-playbook-case)): the step is asked again when it runs.

A step's ask left unanswered is refused with `ADMISSION_UNAVAILABLE`, unless the registration sets `on_unavailable: "allow"`, which passes it. REST calls, `builtin` calls and formations are refused whatever `on_unavailable` says.

## Conditions

Conditions add attribute-based constraints: an operator mapped to key-value pairs that must all hold.

```json
{
  "condition": {
    "StringEquals": {
      "iam:ResourceTag/environment": "production"
    },
    "StringLike": {
      "iam:ResourceTag/team": "engineering-*"
    }
  }
}
```

### Condition Operators

| Operator          | Description                   |
| ----------------- | ----------------------------- |
| `StringEquals`    | Exact string match            |
| `StringNotEquals` | Negated exact match           |
| `StringLike`      | Glob pattern match (`*`, `?`) |

An **absent** key satisfies `StringNotEquals` and fails `StringEquals`: a resource carrying no `team` tag is not `team: finance`, so a `StringNotEquals` rule on that tag leaves it visible. The same holds whether the condition decides one resource or is compiled into a listing.

### Condition Keys

| Key                     | Source        | Description                             |
| ----------------------- | ------------- | --------------------------------------- |
| `iam:ResourceTag/<key>` | Resource tags | Tag value on the target resource        |
| `iam:RequestTag/<key>`  | Request tags  | Tag value the request writes            |
| `iam:ResourceType`      | Request       | The type of the resource being accessed |

These are the only keys a `condition` may name. Any other key — a typo like `iam:ResourceTags/env`, a different case like `iam:resourcetype`, or a key for a source the platform does not supply — is rejected with `400 VALIDATION_FAILED` when the policy is written, and the error names the key.

The check exists because an unknown key is never present in the evaluation context, so the statement carrying it can never match: an `Allow` silently stops granting, and a `Deny` **silently stops denying**. The second is a fail-open, which is why a typo is refused at authoring time rather than discovered in production. The same rule already applies to [action strings](#actions).

`<key>` after `iam:ResourceTag/` or `iam:RequestTag/` is an opaque tag name and is not checked beyond being non-empty — a condition may name a tag no resource carries yet.

### Request tags

`iam:RequestTag/<key>` holds the value a request writes for `<key>`: a create or update body carrying `tags`, a `PUT` or `PATCH` on a resource's `/tags`, a resource a [formation](./formations.md) template declares. It is absent from a request that writes no such tag, reads included, so a condition on it never matches a read and a `Deny` on it reserves one key without touching other tag writes:

```json
{
  "effect": "Deny",
  "action": ["*"],
  "condition": { "StringEquals": { "iam:RequestTag/screened": "clean" } }
}
```

Attached to every principal but a screener, it keeps any other principal from writing `screened: clean`, whichever route or resource the write goes through. A `StringLike` pattern `*` also matches an absent key; use `StringEquals` on the value, or `?*` for any non-empty one.

A formation evaluates the literal tag values of each declared resource before applying anything. A value computed from an intrinsic (`param`, `sub`, `ref`) is known only after that check, so a template computing the value of a key that a `iam:RequestTag/<key>` condition in the caller's policies names is refused with `403 FORBIDDEN` whatever the value resolves to, in an `Allow` or a `Deny` statement.

Operators and keys match **by exact string**; no case conversion applies to a `condition` block or to `tags` (see [Tag keys are stored verbatim](#tag-keys-are-stored-verbatim)).

### Policy Variables

A condition value may name `${iam:ActorId}`, replaced at evaluation time:

| Variable         | Bound to                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `${iam:ActorId}` | The [actor](./actors.md) a generation runs for, in its [agent's `policy_ids`](./agents.md#execution-identity) |

Anywhere else, or in a generation with no actor, the variable is **unbound**, and a condition naming an unbound variable matches nothing under every operator, `StringNotEquals` included. Any other `${...}` is rejected with `400 VALIDATION_FAILED` when the policy is written.

## Authorization Model

Authorization is **policy-only**: every decision is evaluated against the requested action and target SRN.

### Grant and caps

A request's authority is its **grant** ∩ every **cap**, inside the project its credential is pinned to:

| Term                                                                                         | Absent                                                              | Held                                |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ----------------------------------- |
| Grant: the user's policies (a trigger's `policy_ids` for its firing)                         | Allows nothing: a user with no policy reads and lists nothing       | `admin` holds an unrestricted grant |
| Cap: a key's `policy_ids`, an OAuth scope, an IAM token's bound, an `On-Behalf-Of` assertion | Narrows nothing: a key with no `policy_ids` holds its owner's grant | Each must also allow the request    |

An **unrestricted** credential holds the unrestricted grant with no cap and no pin: a login token, or an `admin`'s key with no `project_id` and no `policy_ids`. Only it lists every project unfiltered, passes the instance-wide admin gates and manages other users' keys.

A request narrowed beyond its key's own `policy_ids` (any token, or `On-Behalf-Of`) creates no API key, and only a credential no cap narrows consents to an OAuth client: `403 CREDENTIAL_NARROWED`. A credential never outlives the narrowing it was made under.

### Policy Resolution by Caller Type

| Caller type                 | Policies used                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| **Admin (JWT)**             | The unrestricted grant: every action on every resource                                    |
| **Regular user (JWT)**      | All policies attached to the user (via `User.policyIds`)                                  |
| **API key (no policies)**   | Inherits the owning user's policies, hard-locked to the key's project                     |
| **API key (with policies)** | Intersection of user policies and key policies — both must allow the action               |
| **OAuth token**             | Intersection of user policies and the consented scope, hard-locked to the token's project |
| **IAM token**               | Its issuing key's policies ∩ the token's bound, hard-locked to the key's project          |

Every API key is hard-locked to its `project_id`, every OAuth token to its `prj`; any other project is denied regardless of policy or role. An `admin` owner cannot cross a scoped credential's project boundary: admin is the grant, which a credential's pin and caps narrow, and passes the instance-wide admin gates (users, policies, project creation, the price book) only through a credential with no project and no policies, so a resource write naming another project returns `403 API_KEY_PROJECT_SCOPE`, and a resource there addressed by id is `404`. See [Project scope is a hard boundary, even for admins](./api-keys.md#project-scope-is-a-hard-boundary-even-for-admins).

### Why Intersection Semantics Matter

A key with policies, or an OAuth token with a consented scope, **never exceeds its owning user's permissions**: the user's policies are the ceiling. This is what makes [API keys](./api-keys.md) and [OAuth tokens](./oauth.md#permission-enforcement) safe to delegate; one evaluator enforces every credential type.

### Authorization by Caller Type

| Scenario                                                            | Result  | Reason                                   |
| ------------------------------------------------------------------- | ------- | ---------------------------------------- |
| Admin accessing any resource                                        | Allowed | The unrestricted grant allows it         |
| User with `resource: ["srn:proj_A:*:*"]` accessing proj_A           | Allowed | Policy covers the SRN                    |
| User with `resource: ["srn:proj_A:*:*"]` accessing proj_B           | Denied  | Policy does not cover proj_B SRN         |
| API key scoped to proj_A, accessing proj_B                          | Denied  | Key is hard-locked to proj_A             |
| API key with key policy allowed, but user policy denied             | Denied  | Intersection semantics — both must allow |
| API key without policies, accessing resource allowed by user policy | Allowed | Key inherits user permissions            |

### What a Denial Looks Like

A denial's status code depends on what the route does, not on which policy failed:

| Route shape                                                                                                                                                                                       | Denied response                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **List** ([`GET /agents`](/docs/api/agents/list-agents))                                                                                                                                          | `200` with an empty list — the caller may read zero projects, so nothing matches       |
| **Read one** ([`GET /agents/{id}`](/docs/api/agents/get-agent))                                                                                                                                   | `404 RESOURCE_NOT_FOUND` — existence is not leaked for a resource the caller can't see |
| **Read one the caller already sees through another read** (a `Get<Resource>…` or `List<Resources>…` they hold on it, such as `tools:ListTools` for [`GET /tools/{id}`](/docs/api/tools/get-tool)) | `403 FORBIDDEN` — a `404` would contradict that read                                   |
| **Write / act on one** ([`PATCH /agents/{id}`](/docs/api/agents/patch-agent), `POST .../release/promote`)                                                                                         | `403 FORBIDDEN`                                                                        |
| **Write / act on one, in a project none of the caller's policies name**                                                                                                                           | `404 RESOURCE_NOT_FOUND` — as above, a refusal must not confirm existence either       |
| **Create** ([`POST /agents`](/docs/api/agents/create-agent))                                                                                                                                      | `403 FORBIDDEN`                                                                        |
| Scoped credential naming another project (`project_id`)                                                                                                                                           | `403 API_KEY_PROJECT_SCOPE`, naming both projects                                      |
| Scoped credential addressing, by id, a resource in another project                                                                                                                                | `404` — the module's not-found, as for an id that names nothing                        |

A list without `project_id` spans every project the caller may read, which for an unrestricted admin is every project; `project_id` narrows it to one. An export reads one project, so without `project_id` it is `400 VALIDATION_FAILED`.

A write is refused **before** body validation, so an unauthorized caller gets `403` whether the body is well-formed or not.

Every `403 FORBIDDEN` has one shape, whoever was refused: the caller's credential, an [agent's `policy_ids`](./agents.md#execution-identity), a [trigger's](./triggers.md), or a [formation's](./formations.md) deployer. `meta` names the action, the resource and whose policies denied it, and the message says the same:

```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Forbidden: API key key_01HXYZ's policies deny tools:DeleteTool on srn:proj_01HXYZ:tool:tool_01HXYZ",
    "meta": {
      "action": "tools:DeleteTool",
      "resource": "srn:proj_01HXYZ:tool:tool_01HXYZ",
      "denied_by": { "type": "api_key", "id": "key_01HXYZ" }
    }
  }
}
```

- `denied_by.type` is `user`, `api_key`, `agent`, `trigger`, `project` (`id` the project, for its [`agent_policy_ids`](./projects.md#project-agent-cap) capping an agent), `group` (`id` the group, for its [attached policies](./groups.md#who-holds-what) capping every check in it), or `caller` where the check holds the caller's policies but not its id. A request narrowed beyond its credential names the set that refused: the `principal` an [IAM token](#iam-tokens) was minted for, for its bound, else `iam_token` (`id` its `jti`, `null` for work a token started), `on_behalf_of` for the credential that made the call an `On-Behalf-Of` assertion was sent for (the calling agent's `policy_ids` and its project's `agent_policy_ids` keep their own `agent` and `project` names through it), `generation` (`id` the generation) for that assertion's execution identity. The credential is named first when it refuses too. `denied_by.id` is `null` when it is unknown.
- `resource` is `null` for a check that names none (an admin-only route, a resource-less boundary check). A refusal of several actions (a formation template, several secrets) names the first in `action`/`resource` and every one in the message.
- The same body reaches an agent as a refused tool's result, the [MCP endpoint](../mcp/introduction.md) as an `isError` result whose text is `FORBIDDEN: <message>` and whose `structuredContent` is `{ status: 403, error }` with this body's `error`, and an `mcp` or `http` tool's caller when the server it calls answers this body: that denial is relayed with the same code, action and message.

The `403`/`404` split on a write is about **which project**, not which resource. Being told plainly that one agent in a project you work in is off limits tells you nothing you could not already work out, so that stays `403`. A resource in a project none of your policies name is `404`: a `403` there would confirm it exists to someone with no business knowing it does — including to a caller whose policies name no project at all, for whom every project is someone else's. A denied write never says more than a denied read of the same resource would.

### Denial codes

A `Deny` statement may carry a `denial`, `{ code, message, meta? }`. When that statement decides a refusal, the `403` answers its `code` and `message` instead of `FORBIDDEN`, keeps `action`, `resource` and `denied_by`, and adds `meta`:

```json
{
  "statement": [
    { "effect": "Allow", "action": ["*"] },
    {
      "effect": "Deny",
      "action": ["guardrails:*"],
      "denial": {
        "code": "PLAN_FEATURE_NOT_INCLUDED",
        "message": "Guardrails are not included in this plan.",
        "meta": { "feature": "guardrails" }
      }
    }
  ]
}
```

```json
{
  "error": {
    "code": "PLAN_FEATURE_NOT_INCLUDED",
    "message": "Guardrails are not included in this plan.",
    "hint": "Upgrade the plan to one that includes the feature.",
    "meta": {
      "feature": "guardrails",
      "action": "guardrails:ListGuardrails",
      "resource": null,
      "denied_by": { "type": "api_key", "id": "key_01HXYZ" }
    }
  }
}
```

- The code must be one the deployment declares in `denial_codes` ([Configuration](#configuration)), which supplies its `hint`; any other is `400 VALIDATION_FAILED` at policy write. `meta` keys are snake_case and never `action`, `resource` or `denied_by`.
- Only an unrestricted admin writes a policy carrying a `denial`, over REST or a [formation](./formations.md); anyone else gets `403 POLICY_DENIAL_RESERVED`. An [IAM token](#iam-tokens)'s inline policy carries none (`400 IAM_TOKEN_POLICY_INVALID`).
- The first matching `Deny` in the refusing set decides; a `Deny` without a `denial`, or a refusal no `Deny` matched, answers `FORBIDDEN`. An agent's own `policy_ids` answer `FORBIDDEN`.
- It holds on every path the check runs: REST reads and writes, a read of one resource within the caller's projects (`403`, not `404`), the MCP endpoint, a `builtin` tool's result, a formation's apply, the [writer rule](#the-writer-rule) and a resource's grant refusing the target it starts.

A credential scoped to one project reaches nothing outside it, so every resource elsewhere is beyond it in exactly that sense: addressed by id, it answers the `404` a made-up id gets, and nothing in the response names its project. `403 API_KEY_PROJECT_SCOPE` is kept for a request that names another project itself, which leaks nothing the caller did not send, and for a tool or agent an accepted [share](./shares.md) lets the credential's project read.

## Cross-project shares

A policy grants actions inside the projects it names; it never lets one project act on another's resources. A [share](./shares.md) is the resource-side counterpart: the publishing project records that another project may invoke one of its tools or agents with a fixed set of actions, and the grantee accepts it.

The two sides authorize in their own projects. The publisher's `shares:*` actions are evaluated against `srn:<publisher>:share:<id>`, the grantee's `shares:AcceptShare`, `shares:GetShare` and `shares:RevokeShare` against `srn:<grantee>:share:<id>`. A scoped key or OAuth token acts for its own project on either side, so it creates shares only for that project and accepts them only into it.

A share grants only what its [type allows](./shares.md#shareable-types) — never a write action — and grants nothing while it is unaccepted, suspended or revoked.

## Policy Evaluation

Policy evaluation (Layer 2) follows AWS IAM semantics:

1. **Default deny** — if no statement matches, access is denied.
2. **Explicit deny wins** — if any statement explicitly denies, access is denied regardless of allows.
3. **Allow** — if at least one statement allows and no statement denies, access is granted.

### Statement Matching

A statement matches a request when **all** of the following are true:

1. At least one pattern in `action` matches the requested action.
2. At least one pattern in `resource` matches the target SRN (or `resource` is omitted / `["*"]`). An `Allow` without `resource` in a project policy matches its project only, as `srn:<project_id>:*:*`.
3. All `condition` blocks evaluate to true (or `condition` is omitted).

### Pattern Matching

- `*` matches everything.
- `module:*` matches all actions in a module.
- `srn:proj_ABC:document:*` matches all documents in a project.
- `*` and `?` glob within any segment, partial ones included: `srn:proj_AB*:document:doc_X*`.
- **Path-based patterns**: when a resource has a `path` field, the resource ID segment of the SRN may be a logical path. Both the resource's `id` and its `path` are tested when evaluating a single-resource check. Glob patterns (`/reports/*`) are expanded to SQL `LIKE` for list queries.

## Tags

Tags are key-value pairs on resources, enabling ABAC via conditions. One mechanism serves every resource that carries `tags` ([which ones](#which-resources-carry-which-bag)), so a tag is written, filtered and matched the same way everywhere:

| Surface                                               | Rule                                                                                                                                                                                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Write (`tags` on create/update, `PUT`/`PATCH …/tags`) | A flat object of string values; anything else (an array, a nested object, a number) is `400 VALIDATION_FAILED`, never coerced                                                                                                                                      |
| Bounds                                                | At most 50 keys, 128-character keys and 256-character values. A write past a bound is `400 VALIDATION_FAILED` with `meta.limit`, and so is a `PATCH` whose merge would grow the stored bag past the key count. `system.*` keys are the platform's and do not count |
| List filter (`?tags=key:value`, repeatable)           | JSONB containment: every pair present with exactly that value; split on the first colon; a pair without a colon is `400`                                                                                                                                           |
| Knowledge search (`tags` in the body)                 | Same containment rule across documents and memory entries                                                                                                                                                                                                          |
| Policy condition (`iam:ResourceTag/<key>`)            | Same pairs, read from the same column                                                                                                                                                                                                                              |

Every resource that carries `tags` honors `iam:ResourceTag/<key>` in a policy condition.

A memory is the one resource governed by two tag bags — its own, and its memory store's. Both are evaluated, so a memory is never more visible than the store holding it; see [Memories — Tag Conditions](memories.md#tag-conditions).

[Tag-Based Access Control](../tutorials/tag-based-access-control.md) walks the whole mechanism: tag two documents, condition a policy on the tag, and watch the listing and knowledge search narrow.

A condition applies differently to one resource than to a listing:

| Route shape                                                                                  | How the condition applies                                                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One resource ([`GET /sessions/{id}`](/docs/api/sessions/get-session), the tag sub-endpoints) | The resource is loaded before the policy is evaluated, so its tags are the context: an `Allow` or a `Deny` condition decides the request                                                                                                              |
| A listing ([`GET /sessions?project_id=`](/docs/api/sessions/list-sessions))                  | The caller is authorized for the resource type with no tag context, then the conditions compile into the query, where a `Deny` condition removes rows. Without `?project_id=` the policy of every project in scope compiles, and a row must pass each |

```json
{
  "tags": {
    "environment": "production",
    "team": "engineering",
    "sensitivity": "high"
  }
}
```

Managed via each resource's `tags` field or the tag sub-endpoints:

```
PUT    /api/v1/<resource>/:id/tags    Replace all tags
PATCH  /api/v1/<resource>/:id/tags    Merge tags
GET    /api/v1/<resource>/:id/tags    Get tags
```

The response of all three is the tag map itself, not the resource. Every list endpoint of a tagged resource accepts the same filter:

```
GET /api/v1/<resources>?tags=env:prod&tags=team:finance
```

### Tag keys are stored verbatim

A tag key is an opaque label, **never case-converted**: stored, returned, and matched against `iam:ResourceTag/<key>` exactly as written, on REST, in formation templates, and over MCP.

- `cost_center` and `costCenter` are **two different tags**; a policy naming one does not match a resource carrying only the other.
- `GET .../tags` returns the stored key verbatim; copy it into `iam:ResourceTag/<key>`.

## Tags and metadata

A resource carries two annotation bags, and only one of them is an authorization input.

|                      | `tags`                                                                                      | `metadata`                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Shape                | A flat object of string values, bounded (50 keys, 128-character keys, 256-character values) | Any JSON object, nested, with the types it was written with; bounded by the project's storage quota, not by a count      |
| Governed by          | One mechanism for the write, `?tags=`, knowledge search and `iam:ResourceTag/<key>`         | A [metadata schema](metadata-schemas.md) per resource type and selector, which governs the write only                    |
| Read by the platform | Yes: the IAM context of every access check, containment filters, `system.*` provenance      | Never: not in an IAM context, not in a policy condition, not in a prompt                                                 |
| Filtered by          | `?tags=key:value`, by containment                                                           | The [structured filter grammar](documents.md#metadata-filters) — equality, `in`, ordering — through the same containment |
| Reserved keys        | `system.*`, refused on a caller write                                                       | None, and that is the point: nothing in the bag reaches platform state                                                   |

A label is a string, and a record's fields have types. A report's `revision` is an integer, its `published_at` a date, its `reviewers` a list; stored as strings, `3`, `03` and `3.0` are three values to containment and every consumer parses by convention. So `tags` carry the labels the platform matches on, and `metadata` carries the record, typed at rest.

A record whose bag is unset leaves the field out of its response rather than answering `null`, for both bags on every resource; `null` is only something a write sends, to clear a bag.

A `metadata` bag is refused unless it is a JSON object, with `400 VALIDATION_FAILED`, at every endpoint that stores one — the column would keep a bare string as readily as an object, and a stored string then answers no structured filter, so an accepted bad write reads back as a row that simply matches nothing. The two endpoints that take a bag without storing one are not bound by this: knowledge search reads a filter over bags, and the metadata-schema validator answers with a verdict on a bag rather than keeping it.

Which bag a rule may read follows from who writes it. Any caller who may write a resource may put any JSON in its `metadata`, so a policy condition on that bag would let that caller decide what their own rows match — including out of a `Deny`. `tags` are bounded and their `system.*` keys are refused on a caller write, which is what makes them safe to condition on. A policy therefore names `iam:ResourceTag/<key>` and has no spelling for the other bag.

### Choosing a bag

| A field that…                                                  | Goes in    |
| -------------------------------------------------------------- | ---------- |
| a policy scopes rows by, through `iam:ResourceTag/<key>`       | `tags`     |
| identifies the row, matched by `?tags=` or knowledge search    | `tags`     |
| holds a typed value: a number, a date, a list, a nested object | `metadata` |
| is ordered or compared (`gt`, `lte`, `in`)                     | `metadata` |

The table assumes both bags. A resource that carries one takes every field there: a task's identifier lives in its `metadata` and is found with [`?metadata=`](/docs/api/tasks/list-tasks), and no policy can condition on it.

### Which resources carry which bag

| Resource             | `tags` | `metadata` |
| -------------------- | ------ | ---------- |
| Actor                | ✓      |            |
| Collection item      | ✓      |            |
| Conversation         | ✓      |            |
| Conversation message |        | ✓          |
| Dataset item         |        | ✓          |
| Decision             |        | ✓          |
| Document             | ✓      | ✓          |
| Eval run             |        | ✓          |
| File                 | ✓      | ✓          |
| Formation            |        | ✓          |
| Generation           |        | ✓          |
| Ingestion rule       |        | ✓          |
| Memory               | ✓      | ✓          |
| Memory store         | ✓      |            |
| Orchestration run    |        | ✓          |
| Session              | ✓      |            |
| Task                 |        | ✓          |

## Examples

### Full Access Policy

`resource: ["*"]` matches every SRN across all projects.

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["*"],
      "resource": ["*"]
    }
  ]
}
```

### Project-scoped Read-only Policy

Read access to one project's resources; attach to a user or API key.

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": [
        "projects:GetProject",
        "documents:GetDocument",
        "documents:ListDocuments",
        "files:GetFile",
        "files:ListFiles"
      ],
      "resource": ["srn:proj_ABC:*:*"]
    }
  ]
}
```

### Allow All File Operations Except Delete

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["files:*"],
      "resource": ["srn:proj_ABC:file:*"]
    },
    {
      "effect": "Deny",
      "action": ["files:DeleteFile"],
      "resource": ["srn:proj_ABC:file:*"]
    }
  ]
}
```

### Condition-based Access

Allow only actors tagged `"internal"`:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["actors:GetActor"],
      "resource": ["srn:proj_ABC:actor:*"],
      "condition": {
        "StringEquals": {
          "iam:ResourceTag/visibility": "internal"
        }
      }
    }
  ]
}
```

---

## Users

For user identity management, roles, authentication, and bootstrap, see the [Users module](./users.md).

## Configuration

| Environment Variable                | Required | Description                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IAM_REGISTRATIONS_CONFIG`          | No       | Path to a JSON file registering [deployment actions](#deployment-registered-actions) (`modules`), [MCP servers](#registered-mcp-servers) (`mcp_tools`), [the builtin catalog](#the-builtin-catalog) (`builtin_actions`), an [admission service](#admission) (`admission`) and [denial codes](#denial-codes) (`denial_codes`). Unset (the default) registers none and offers every native action. |
| `SOAT_RESERVED_TOOL_CONTEXT_PREFIX` | No       | A `tool_context` key prefix (e.g. `platform_`) only an [IAM token's layer](#pinning-a-tool_context-layer) carries: refused on every other carrier, dropped from a direct tool call's bag. It must fit the `tool_context` key grammar, or the server and the worker stop at startup, and matches in any casing. Unset reserves none.                                                              |

```json
{
  "modules": [
    {
      "module": "channels",
      "resource_types": ["channel"],
      "actions": [
        {
          "action": "channels:CreateChannel",
          "description": "Create a channel"
        },
        { "action": "channels:GetChannel", "description": "Get a channel" }
      ]
    }
  ],
  "mcp_tools": [
    {
      "url": "https://platform.internal/mcp",
      "tools": {
        "create-playbook-case": [
          {
            "action": "playbooks:CreatePlaybookCase",
            "resource_type": "playbook_case"
          }
        ]
      }
    }
  ],
  "builtin_actions": {
    "allow": ["list-agents", "search-knowledge"],
    "add": {
      "url": "https://platform.internal/mcp",
      "tools": {
        "send-note": [
          { "action": "channels:CreateChannel", "resource_type": "channel" }
        ]
      }
    }
  },
  "admission": {
    "handler": {
      "url": "https://platform.internal/admission",
      "secret_env": "ADMISSION_SIGNING_SECRET",
      "timeout_seconds": 5
    },
    "actions": ["triggers:CreateTrigger", "triggers:UpdateTrigger"],
    "on_unavailable": "refuse"
  },
  "denial_codes": [
    {
      "code": "PLAN_FEATURE_NOT_INCLUDED",
      "hint": "Upgrade the plan to one that includes the feature."
    }
  ]
}
```

Read once at boot, by the API and the worker alike; an invalid file fails the boot. A module may not reuse a built-in module's name, each action is `<module>:<Operation>`, and a resource type belongs to one module. Each `mcp_tools` URL appears once, and each tool declares at least one action `iam/check` answers on its `resource_type`. Each `admission.actions` entry is an action a runtime write operation declares; `secret_env` names the variable holding the signing secret, which must be set; `timeout_seconds` defaults to 30; `on_unavailable` is `refuse` (the default) or `allow`, for [steps of internal work](#steps-of-internal-work) only. Each `denial_codes` entry is an UPPER_SNAKE code no built-in error code uses, once, with a non-empty `hint`.
