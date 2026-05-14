# PRD: Agent Formation Module

## Implementation Status

| Component                              | Status         | Notes                                                                |
| -------------------------------------- | -------------- | -------------------------------------------------------------------- |
| AgentFormation model                   | ❌ Not started | Stores the deployed formation stack, template, outputs, and status   |
| AgentFormationResource model           | ❌ Not started | Maps logical resources to physical SOAT resource IDs                 |
| AgentFormationOperation model          | ❌ Not started | Tracks create/update/delete/plan operations and event logs           |
| `agentFormations.ts` lib               | ❌ Not started | Template validation, planning, dependency graph, apply/delete logic  |
| REST routes                            | ❌ Not started | `/api/v1/agent-formations` plus validate/plan/events endpoints       |
| OpenAPI spec (`agent-formations.yaml`) | ❌ Not started | Schemas for templates, plans, stacks, resources, operations          |
| Permissions                            | ❌ Not started | `agent-formations.json` with formation lifecycle actions             |
| Module docs page                       | ❌ Not started | `packages/website/docs/modules/agent-formations.md`                  |
| CLI generated commands                 | ❌ Not started | Generated from OpenAPI after spec is added                           |
| SDK generated services                 | ❌ Not started | Generated from OpenAPI after spec is added                           |
| MCP tool surface                       | ❌ Not started | Derived automatically from OpenAPI via `soatTools.ts`                |
| Unit tests                             | ❌ Not started | REST integration tests for validate, plan, create, list, get, delete |
| Smoke test                             | ❌ Not started | End-to-end deploy of a small agent app formation                     |
| Tutorial                               | ❌ Not started | Use Agent Formation to replace multi-step app provisioning           |

## Overview

The Agent Formation module provides a declarative deployment layer for SOAT AI agent applications. Instead of creating projects, AI providers, documents, memories, tools, agents, webhooks, and orchestration links through many ordered API calls, users submit one **formation template** and SOAT deploys it as a managed **formation stack**.

The module is inspired by AWS CloudFormation, but scoped to AI agent application resources. It turns SOAT from a collection of low-level resource APIs into a platform where an agent app can be described, planned, deployed, updated, deleted, and inspected as one unit.

Agent Formation does not replace the existing modules. It orchestrates them. Each deployed stack is backed by normal SOAT resources, so existing APIs, permissions, traces, knowledge retrieval, tools, and generated SDK/CLI surfaces continue to work.

## Goals

- Reduce multi-step AI app setup into one declarative deployment operation.
- Make agent app deployments repeatable across local, staging, and production environments.
- Track which SOAT resources belong to one deployed app.
- Support safe previews through a plan operation before mutating resources.
- Preserve existing module boundaries by calling existing business logic rather than duplicating resource creation paths.
- Provide outputs so scripts and applications can retrieve important deployed IDs, such as `agent_id` or `memory_id`.
- Make the module usable through REST, SDK, CLI, and MCP via the existing OpenAPI-driven generation flow.

## Non-Goals

- Replacing project, agent, memory, document, tool, webhook, or provider APIs.
- Creating a general-purpose infrastructure-as-code engine for arbitrary cloud resources.
- Managing secrets by storing plaintext values in persisted formation templates.
- Implementing full drift detection in the MVP.
- Implementing cross-project deployments in the MVP.
- Implementing rollback for every possible partial failure in the MVP.

## Key Concepts

### Agent Formation

An Agent Formation is the top-level module and product concept. It describes, deploys, and manages an AI agent app made of existing SOAT resources.

In API responses, an Agent Formation represents the deployed stack record: template, status, outputs, managed resources, and lifecycle metadata.

### Formation Template

A formation template is the declarative JSON object submitted by the user. It contains logical resources and outputs.

Example:

```json
{
  "resources": {
    "provider": {
      "type": "ai_provider",
      "properties": {
        "name": "Local Ollama",
        "provider": "ollama",
        "default_model": "qwen2.5:0.5b"
      }
    },
    "profileMemory": {
      "type": "memory",
      "properties": {
        "name": "Customer Profile",
        "tags": ["customer", "support"]
      }
    },
    "agent": {
      "type": "agent",
      "properties": {
        "name": "Support Assistant",
        "ai_provider_id": { "ref": "provider" },
        "instructions": "Answer from knowledge first.",
        "knowledge_config": {
          "memory_ids": [{ "ref": "profileMemory" }],
          "write_memory_id": { "ref": "profileMemory" }
        }
      }
    }
  },
  "outputs": {
    "agent_id": { "ref": "agent" },
    "memory_id": { "ref": "profileMemory" }
  }
}
```

### Formation Stack

A formation stack is the deployed, stateful instance of a formation template. It stores:

- Current template
- Deployment status
- Output values
- Logical-to-physical resource mappings
- Operation history

The term "stack" is useful for explaining behavior, but the public module name remains **Agent Formation**.

### Stack Resource

A stack resource is a single SOAT resource managed by a formation stack. It maps a logical resource name from the template, such as `agent`, to a physical SOAT public ID, such as `agt_abc123`.

Each stack resource stores status and metadata so updates can be idempotent.

### Formation Operation

A formation operation is one lifecycle action against a stack: validate, plan, create, update, or delete. Mutating operations should write operation events so users can inspect what happened when a deployment fails.

## MVP Scope

The MVP should support the resource types that appear repeatedly in current tutorials and unlock the highest-value app deployments:

| Template type  | SOAT resource | MVP support | Notes                                           |
| -------------- | ------------- | ----------- | ----------------------------------------------- |
| `ai_provider`  | AI Provider   | ✅ Yes      | May reference an existing secret by ID          |
| `agent_tool`   | Agent Tool    | ✅ Yes      | Supports `http`, `client`, `mcp`, and `soat`    |
| `agent`        | Agent         | ✅ Yes      | Supports refs for provider and tool IDs         |
| `document`     | Document      | ✅ Yes      | Supports inline text document creation          |
| `memory`       | Memory        | ✅ Yes      | Supports tags                                   |
| `memory_entry` | Memory Entry  | ✅ Yes      | Useful for seed facts                           |
| `webhook`      | Webhook       | ✅ Yes      | Useful for async generation lifecycle flows     |
| `secret`       | Secret        | ⚠️ Later    | Avoid plaintext secret persistence in the MVP   |
| `policy`       | Policy        | ⚠️ Later    | Adds IAM complexity; defer until core is stable |
| `api_key`      | API Key       | ❌ No       | Raw key values are shown once and hard to model |
| `project`      | Project       | ❌ No       | MVP formations deploy within one project        |

## Template Model

### Top-Level Fields

| Field       | Type   | Required | Description                                   |
| ----------- | ------ | -------- | --------------------------------------------- |
| `resources` | object | yes      | Map of logical IDs to resource declarations   |
| `outputs`   | object | no       | Map of output names to resolvable expressions |
| `metadata`  | object | no       | User-defined metadata for the template        |

### Resource Declaration

| Field        | Type   | Required | Description                                                    |
| ------------ | ------ | -------- | -------------------------------------------------------------- |
| `type`       | string | yes      | Resource type, e.g. `agent`, `memory`, `agent_tool`            |
| `properties` | object | yes      | Resource-specific fields using REST API snake_case conventions |
| `depends_on` | array  | no       | Explicit logical IDs that must be deployed first               |
| `metadata`   | object | no       | User-defined metadata for this logical resource                |

Implicit dependencies are derived from `ref` expressions inside `properties` and `outputs`.

### References

References resolve a logical resource to its physical public ID:

```json
{ "ref": "profileMemory" }
```

References may appear anywhere inside `properties` or `outputs`, including nested objects and arrays.

### External IDs

Some resources should reference an existing SOAT resource rather than creating a new one. The MVP supports literal IDs for those fields:

```json
{
  "type": "ai_provider",
  "properties": {
    "name": "OpenAI",
    "provider": "openai",
    "default_model": "gpt-4.1-mini",
    "secret_id": "sec_existing123"
  }
}
```

The MVP should not support dynamic secret value injection in templates.

## Data Model

### AgentFormation Table

| Column      | Type       | Notes                                                        |
| ----------- | ---------- | ------------------------------------------------------------ |
| `id`        | INTEGER    | Internal PK, never exposed                                   |
| `publicId`  | STRING(32) | Prefix `agt_form_`, unique, NOT NULL                         |
| `projectId` | INTEGER    | FK -> Project, NOT NULL                                      |
| `name`      | STRING     | Human-readable stack name, NOT NULL                          |
| `template`  | JSONB      | Current formation template                                   |
| `outputs`   | JSONB      | Resolved output values                                       |
| `status`    | STRING     | `creating`, `active`, `updating`, `failed`, `deleting`, etc. |
| `metadata`  | JSONB      | Optional user-defined metadata                               |
| `createdAt` | DATE       |                                                              |
| `updatedAt` | DATE       |                                                              |

Unique constraint: `(projectId, name)`.

### AgentFormationResource Table

| Column                  | Type       | Notes                                                |
| ----------------------- | ---------- | ---------------------------------------------------- |
| `id`                    | INTEGER    | Internal PK, never exposed                           |
| `publicId`              | STRING(32) | Prefix `afr_`, unique, NOT NULL                      |
| `agentFormationId`      | INTEGER    | FK -> AgentFormation, NOT NULL                       |
| `logicalId`             | STRING     | Logical resource ID from the template                |
| `resourceType`          | STRING     | Template resource type                               |
| `physicalResourceId`    | STRING     | Public ID of the SOAT resource                       |
| `status`                | STRING     | `pending`, `created`, `updated`, `deleted`, `failed` |
| `lastAppliedProperties` | JSONB      | Resolved properties from the last successful apply   |
| `createdAt`             | DATE       |                                                      |
| `updatedAt`             | DATE       |                                                      |

Unique constraint: `(agentFormationId, logicalId)`.

### AgentFormationOperation Table

| Column             | Type       | Notes                                                       |
| ------------------ | ---------- | ----------------------------------------------------------- |
| `id`               | INTEGER    | Internal PK, never exposed                                  |
| `publicId`         | STRING(32) | Prefix `afo_`, unique, NOT NULL                             |
| `agentFormationId` | INTEGER    | FK -> AgentFormation, nullable for standalone validate/plan |
| `operationType`    | STRING     | `validate`, `plan`, `create`, `update`, `delete`            |
| `status`           | STRING     | `pending`, `running`, `succeeded`, `failed`                 |
| `events`           | JSONB      | Ordered operation events                                    |
| `plan`             | JSONB      | Planned changes, when applicable                            |
| `error`            | JSONB      | Structured error, when failed                               |
| `createdAt`        | DATE       |                                                             |
| `updatedAt`        | DATE       |                                                             |

## Status Values

### Agent Formation Status

| Status          | Meaning                                      |
| --------------- | -------------------------------------------- |
| `creating`      | Initial deployment is running                |
| `active`        | Last deployment succeeded                    |
| `updating`      | Update deployment is running                 |
| `delete_failed` | Delete operation failed                      |
| `failed`        | Last create/update operation failed          |
| `deleting`      | Delete operation is running                  |
| `deleted`       | Stack record retained after resources delete |

### Resource Change Actions

| Action    | Meaning                                     |
| --------- | ------------------------------------------- |
| `create`  | Resource does not exist and will be created |
| `update`  | Resource exists and properties changed      |
| `delete`  | Resource exists but is absent from template |
| `no_op`   | Resource exists and matches desired state   |
| `replace` | Resource must be deleted and recreated      |

The MVP can avoid replacement by returning a validation error for immutable changes that cannot be safely updated.

## Planning Algorithm

```
Input: project_id, optional formation_id, template

STEP 1 - VALIDATE TEMPLATE
  Validate top-level shape, logical IDs, supported resource types, and required properties.

STEP 2 - BUILD DEPENDENCY GRAPH
  Traverse refs and depends_on fields.
  Reject missing references and cycles.

STEP 3 - RESOLVE CURRENT STATE
  If updating an existing formation, load existing stack resources.

STEP 4 - COMPUTE CHANGES
  For each desired logical resource:
    - create if no existing physical ID
    - update if properties differ from lastAppliedProperties
    - no_op otherwise
  For each existing stack resource missing from template:
    - delete

STEP 5 - SORT CHANGES
  Creates and updates follow dependency order.
  Deletes run in reverse dependency order.

STEP 6 - RETURN PLAN
  Return changes, outputs preview where resolvable, and validation warnings.
```

## Apply Algorithm

```
Input: project_id, formation name or ID, template

STEP 1 - PLAN
  Run the planning algorithm and fail fast on validation errors.

STEP 2 - CREATE OPERATION RECORD
  Store operation type and initial event.

STEP 3 - APPLY CHANGES
  For each change in sorted order:
    - resolve refs against already-created resources
    - call the corresponding module lib function
    - store or update AgentFormationResource mapping
    - append an operation event

STEP 4 - RESOLVE OUTPUTS
  Evaluate output refs and store values on AgentFormation.outputs.

STEP 5 - UPDATE STATUS
  Mark formation active on success or failed on error.
```

The first implementation can be synchronous. A future version may run deployments asynchronously if stacks become large.

## REST API

All REST body fields use `snake_case` per project convention. Internal TypeScript uses camelCase.

### Validate Template

```
POST /api/v1/agent-formations/validate
{
  "project_id": "proj_01",
  "template": { "resources": {} }
}
```

Response (`200`):

```json
{
  "valid": true,
  "errors": [],
  "warnings": []
}
```

### Plan Formation

```
POST /api/v1/agent-formations/plan
{
  "project_id": "proj_01",
  "formation_id": "agt_form_01",
  "template": { "resources": {} }
}
```

`formation_id` is optional. If omitted, the plan is treated as a create plan.

Response (`200`):

```json
{
  "changes": [
    {
      "logical_id": "provider",
      "resource_type": "ai_provider",
      "action": "create"
    },
    {
      "logical_id": "agent",
      "resource_type": "agent",
      "action": "create",
      "depends_on": ["provider"]
    }
  ],
  "errors": [],
  "warnings": []
}
```

### Create Formation

```
POST /api/v1/agent-formations
{
  "project_id": "proj_01",
  "name": "support-agent",
  "template": { "resources": {} },
  "metadata": { "environment": "dev" }
}
```

Response (`201`):

```json
{
  "id": "agt_form_01",
  "project_id": "proj_01",
  "name": "support-agent",
  "status": "active",
  "outputs": {
    "agent_id": "agt_01"
  },
  "created_at": "2026-05-14T00:00:00Z",
  "updated_at": "2026-05-14T00:00:00Z"
}
```

### List Formations

```
GET /api/v1/agent-formations?project_id=proj_01
```

### Get Formation

```
GET /api/v1/agent-formations/:formation_id
```

The response includes stack resources and outputs.

### Update Formation

```
PUT /api/v1/agent-formations/:formation_id
{
  "template": { "resources": {} },
  "metadata": { "environment": "prod" }
}
```

### Delete Formation

```
DELETE /api/v1/agent-formations/:formation_id
```

The MVP should delete managed resources in reverse dependency order and then mark the formation as `deleted` or remove the stack record. Retaining the deleted record is better for auditability.

### List Operation Events

```
GET /api/v1/agent-formations/:formation_id/events
```

Response (`200`):

```json
{
  "data": [
    {
      "operation_id": "afo_01",
      "operation_type": "create",
      "status": "succeeded",
      "events": [
        {
          "timestamp": "2026-05-14T00:00:00Z",
          "logical_id": "provider",
          "resource_type": "ai_provider",
          "action": "create",
          "status": "succeeded",
          "physical_resource_id": "aip_01"
        }
      ]
    }
  ]
}
```

## Permissions

Initial IAM action strings:

| Operation ID               | Action                                      | Description                      |
| -------------------------- | ------------------------------------------- | -------------------------------- |
| `validateAgentFormation`   | `agent-formations:ValidateAgentFormation`   | Validate a formation template    |
| `planAgentFormation`       | `agent-formations:PlanAgentFormation`       | Plan a formation deployment      |
| `createAgentFormation`     | `agent-formations:CreateAgentFormation`     | Create and deploy a formation    |
| `listAgentFormations`      | `agent-formations:ListAgentFormations`      | List formations in a project     |
| `getAgentFormation`        | `agent-formations:GetAgentFormation`        | Get formation details            |
| `updateAgentFormation`     | `agent-formations:UpdateAgentFormation`     | Update and redeploy a formation  |
| `deleteAgentFormation`     | `agent-formations:DeleteAgentFormation`     | Delete a formation and resources |
| `listAgentFormationEvents` | `agent-formations:ListAgentFormationEvents` | List formation operation events  |

Formation deployment should also require permissions for the underlying resource actions being performed, such as `agents:CreateAgent`, `ai-providers:CreateAiProvider`, or `documents:CreateDocument`. This prevents Agent Formation from becoming a privilege escalation path.

## Error Handling

Validation errors should be deterministic and point to template paths:

```json
{
  "valid": false,
  "errors": [
    {
      "path": "resources.agent.properties.ai_provider_id.ref",
      "message": "Referenced resource 'provider' does not exist"
    }
  ],
  "warnings": []
}
```

Apply errors should preserve partial progress in operation events. If a deployment fails after creating some resources, the stack status becomes `failed` and the created resources remain tracked for update/delete retry.

## Agent Integration

Agent Formation composes existing agent capabilities:

- Agents reference AI providers through `ai_provider_id` refs.
- Agents reference tool IDs through `tool_ids` refs.
- Agents can use `knowledge_config` refs for memories and documents.
- Agent tools can use `preset_parameters` refs for documents, memories, or other agents.
- Multi-agent orchestration can be declared by creating worker agents, then soat tools that call those agents, then an orchestrator agent using those tools.

This enables the current multi-agent orchestration tutorial to be represented as one formation template rather than a long sequence of CLI commands.

## Open Questions

- Should stack deletion default to deleting managed resources, retaining managed resources, or require an explicit deletion policy per resource?
- Should Agent Formation support importing existing resources into a stack in the MVP?
- Should templates support parameters in the MVP, or should users render templates before submission?
- Should updates diff against `lastAppliedProperties` only, or fetch live resource state to detect drift?
- Should formation operations emit platform events through the existing event bus?

## Implementation Phases

### Phase 1 - Template Validation and Planning

**Goal:** Let users validate and preview an Agent Formation without mutating resources.

Deliverables:

- Template TypeScript types and runtime validation helpers
- Reference traversal and dependency graph builder
- Cycle detection and missing-reference errors
- Plan output for create operations
- REST endpoints: `validateAgentFormation`, `planAgentFormation`
- OpenAPI spec, permissions, docs, tests

### Phase 2 - Create and Inspect Stacks

**Goal:** Deploy a new formation stack and inspect managed resources and outputs.

Deliverables:

- AgentFormation, AgentFormationResource, AgentFormationOperation models
- Public ID prefixes for formation records
- Create apply path for MVP resource types
- Output resolution
- REST endpoints: create, list, get, events
- Tests for happy path, 401, 403, validation failures, and partial failure tracking

### Phase 3 - Update and Delete Stacks

**Goal:** Make deployments iterative and removable.

Deliverables:

- Update plan diff against existing resources
- Update apply path for supported resources
- Delete in reverse dependency order
- Retained operation history
- REST endpoints: update, delete
- Tests for update, delete, missing resources, and permission failures

### Phase 4 - CLI, SDK, Docs, and Tutorial

**Goal:** Make the feature easy to use as the default way to deploy agent apps.

Deliverables:

- Regenerate SDK and CLI from OpenAPI
- Module documentation page
- Tutorial: deploy a memory-aware support agent with one formation
- Smoke test covering end-to-end formation deploy and generation

### Phase 5 - Advanced Stack Features

**Goal:** Add IaC features after the core model is stable.

Future deliverables:

- Template parameters
- Import existing resources
- Drift detection
- Deletion policies
- Rollback controls
- Async operation execution
- Template versioning

## Test Plan

REST tests should cover:

- Validate succeeds for a minimal provider + agent template.
- Validate fails for missing refs, unsupported resource types, missing required properties, and cycles.
- Plan returns create changes in dependency order.
- Create deploys provider, memory, tool, document, and agent resources.
- Create stores logical-to-physical resource mappings.
- Get returns stack resources and outputs.
- List filters by project authorization.
- Events return operation history.
- Update changes an agent property and preserves physical ID.
- Delete removes managed resources in reverse dependency order.
- `401` unauthenticated requests.
- `403` for users without formation permissions.
- `403` when the caller has formation permission but lacks an underlying resource permission.

## Documentation Plan

- Add `packages/website/docs/modules/agent-formations.md`.
- Add a tutorial that deploys a memory-aware support agent using one formation template.
- Update relevant tutorials to mention Agent Formation as the concise deployment path.
- Regenerate permissions docs after adding `agent-formations.json`.

## Success Metrics

- A memory-aware agent app can be deployed in one API call after login and project creation.
- The multi-agent orchestration tutorial can be expressed as one formation template.
- Users can preview planned resources before deployment.
- A failed deployment leaves enough operation events to diagnose and retry.
- Existing resource APIs remain fully compatible with formation-managed resources.
