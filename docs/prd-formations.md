# PRD: Formations (Final Version)

## Summary

Rename "Agent Formations" to **"Formations"** and consolidate duplicated code between REST handlers and formation modules into a shared layer. The goal is to make formations a first-class, resource-agnostic orchestration system where the same validation, normalization, and ID resolution logic is reused by both the REST API and the formation engine.

---

## Motivation

The current "Agent Formations" system has three main problems:

1. **Naming**: The "Agent" prefix is misleading — formations orchestrate many resource types (agents, actors, AI providers, memories, documents, webhooks, agent tools), not just agents.

2. **Code duplication**: The REST handlers and formation modules independently implement:
   - Input type normalization (string → `string | undefined`, null handling)
   - Field validation (required fields, type checks, mutual exclusivity)
   - Public ID → internal DB ID resolution
   - Error mapping (not_found, exclusivity conflicts)

3. **Inconsistent validation**: REST handlers do inline checks; formation modules use OpenAPI-schema-driven validation. Neither can reuse the other's logic.

---

## Rename: `agentFormations` → `formations`

### What Changes

| Current                               | New                                             |
| ------------------------------------- | ----------------------------------------------- |
| `agent-formations` (folder, files)    | `formations`                                    |
| `AgentFormation` (DB model)           | `Formation` (or keep model, rename API surface) |
| `AgentFormationModule` (type)         | `FormationModule`                               |
| `agentFormations.ts` (lib)            | `formations.ts`                                 |
| `agentFormationsTypes.ts`             | `formationsTypes.ts`                            |
| `agentFormationsHelpers.ts`           | `formationsHelpers.ts`                          |
| `agentFormationsValidation.ts`        | `formationsValidation.ts`                       |
| `agentFormationsApply.ts`             | `formationsApply.ts`                            |
| `agentFormationsRegistry.ts`          | `formationsRegistry.ts`                         |
| `agentFormationsResourceHandlers.ts`  | `formationsResourceHandlers.ts`                 |
| `agent-formation-modules/` (folder)   | `formation-modules/`                            |
| `actorsAgentFormationModule`          | `actorsFormationModule`                         |
| `agentsAgentFormationModule`          | `agentsFormationModule`                         |
| `AgentFormation` (DB model)           | `Formation`                                     |
| `AgentFormationResource` (DB model)   | `FormationResource`                             |
| `AgentFormationOperation` (DB model)  | `FormationOperation`                            |
| REST path: `/api/v1/agent-formations` | `/api/v1/formations`                            |
| OpenAPI: `agent-formations.yaml`      | `formations.yaml`                               |

### DB Model Strategy

Formations is in alpha and not used by anyone. We do a full migration:

- Rename Sequelize models: `AgentFormation` → `Formation`, `AgentFormationResource` → `FormationResource`, `AgentFormationOperation` → `FormationOperation`
- Rename DB tables accordingly (via Sequelize sync or migration)
- Remove all old `/api/v1/agent-formations` paths entirely (no deprecation layer)
- Clean break — no backward compatibility needed

---

## Shared Layer: Reusable Functions

### Problem: Current Duplication Map

#### 1. Type Normalization

**REST (agents.ts)**:

```ts
const buildCreateAgentArgs = (projectId, body) => ({
  name: typeof body.name === 'string' ? body.name : undefined,
  maxSteps: typeof body.maxSteps === 'number' ? body.maxSteps : undefined,
  toolIds: Array.isArray(body.toolIds) ? body.toolIds : undefined,
  // ...
});
```

**Formation (agentsAgentFormation.ts)**:

```ts
const toOptionalString = (value: unknown): string | undefined => { ... };
const toNullableString = (value: unknown): string | null | undefined => { ... };
const toNullableNumber = (value: unknown): number | null | undefined => { ... };
const toNullableArray = <T>(value: unknown): T[] | null | undefined => { ... };
const toNullableObject = (value: unknown): object | null | undefined => { ... };
```

Both do the same thing: safely coerce `unknown` input to typed values.

#### 2. ID Resolution (publicId → internal DB ID)

**REST (actors.ts route handler)**:

```ts
const resolveActorAgentDbId = async (agentId, projectDbId) => {
  if (agentId === undefined) return undefined;
  const agent = await db.Agent.findOne({
    where: { publicId: agentId, projectId: projectDbId },
  });
  if (!agent) return null; // signals 400
  return agent.id;
};
```

**Formation (agentFormationsHelpers.ts)**:

```ts
export const lookupAgentInternalId = async (
  publicId: string
): Promise<number> => {
  const agent = await db.Agent.findOne({ where: { publicId } });
  if (!agent) throw new Error(`Agent not found: ${publicId}`);
  return agent.id;
};
```

**Lib (actors.ts)**:

```ts
const updateAgentIdField = async (agentId, updates) => {
  if (agentId === undefined) return;
  if (agentId === null) {
    updates.agentId = null;
    return;
  }
  const agent = await db.Agent.findOne({ where: { publicId: agentId } });
  if (!agent) return 'agent_not_found';
  updates.agentId = agent.id;
};
```

Three different implementations of "resolve publicId to DB id" with different error-handling strategies.

#### 3. Validation

**REST (actors.ts)**:

```ts
const validateCreateActorBody = (body) => {
  if (!body.name) return 'name is required';
  if (body.agentId && body.chatId) return 'mutually exclusive';
  return null;
};
```

**Formation (actorsAgentFormation.ts)**:

```ts
const pushBusinessRuleErrors = (args) => {
  if (args.properties.agent_id && args.properties.chat_id) {
    args.errors.push({ path: ..., message: 'mutually exclusive' });
  }
};
```

Same business rules, different shapes.

---

### Solution: Shared Resource Input Layer

Create a new shared module per resource that both REST and formations import:

```
packages/server/src/lib/
├── resource-inputs/
│   ├── normalizers.ts         # Generic type coercion utilities
│   ├── agentInput.ts          # Agent-specific input parsing & validation
│   ├── actorInput.ts          # Actor-specific input parsing & validation
│   └── idResolver.ts          # Unified publicId → internalId resolution
├── formations/                # Renamed from agent-formations
│   ├── formationsTypes.ts
│   ├── formations.ts
│   ├── ...
│   └── modules/
│       ├── agentsFormationModule.ts
│       └── actorsFormationModule.ts
```

#### `normalizers.ts` — Generic Type Coercion

```ts
export const toOptionalString = (value: unknown): string | undefined => {
  return typeof value === 'string' ? value : undefined;
};

export const toNullableString = (value: unknown): string | null | undefined => {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
};

export const toNullableNumber = (value: unknown): number | null | undefined => {
  if (value === null) return null;
  return typeof value === 'number' ? value : undefined;
};

export const toNullableArray = <T>(value: unknown): T[] | null | undefined => {
  if (value === null) return null;
  return Array.isArray(value) ? (value as T[]) : undefined;
};

export const toNullableObject = (value: unknown): object | null | undefined => {
  if (value === null) return null;
  return typeof value === 'object' && !Array.isArray(value) ? value : undefined;
};

export const toOptionalNumber = (value: unknown): number | undefined => {
  return typeof value === 'number' ? value : undefined;
};

export const toOptionalArray = <T>(value: unknown): T[] | undefined => {
  return Array.isArray(value) ? (value as T[]) : undefined;
};

export const toOptionalObject = (value: unknown): object | undefined => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value
    : undefined;
};
```

#### `idResolver.ts` — Unified ID Resolution

```ts
export type ResolveResult =
  | { status: 'resolved'; internalId: number }
  | { status: 'null' }
  | { status: 'not_found'; publicId: string }
  | { status: 'skipped' };

/**
 * Resolve a nullable/optional publicId to its internal DB ID.
 * Supports three calling patterns:
 * - undefined → skipped (field not provided)
 * - null → null (explicit unset)
 * - string → resolved or not_found
 */
export const resolvePublicId = async (args: {
  value: string | null | undefined;
  model: typeof db.Agent | typeof db.Chat | typeof db.Memory | typeof db.Secret;
  projectId?: number; // optional project scoping
}): Promise<ResolveResult> => {
  if (args.value === undefined) return { status: 'skipped' };
  if (args.value === null) return { status: 'null' };

  const where: Record<string, unknown> = { publicId: args.value };
  if (args.projectId) where.projectId = args.projectId;

  const row = await args.model.findOne({ where });
  if (!row) return { status: 'not_found', publicId: args.value };
  return { status: 'resolved', internalId: row.id as number };
};
```

Both REST and formations call `resolvePublicId` and translate the result to their own error format (HTTP 400 vs thrown Error).

#### `agentInput.ts` — Agent-Specific Input Parsing

```ts
import { toOptionalString, toNullableString, toNullableNumber, ... } from './normalizers';

export type ParsedAgentInput = {
  aiProviderId: string;
  name?: string;
  instructions?: string;
  model?: string;
  toolIds?: string[];
  maxSteps?: number;
  toolChoice?: object;
  stopConditions?: object[];
  activeToolIds?: string[];
  stepRules?: object[];
  boundaryPolicy?: object;
  temperature?: number;
  knowledgeConfig?: object;
};

export type ParsedAgentUpdateInput = {
  aiProviderId?: string;
  name?: string | null;
  instructions?: string | null;
  model?: string | null;
  toolIds?: string[] | null;
  maxSteps?: number | null;
  toolChoice?: object | null;
  stopConditions?: object[] | null;
  activeToolIds?: string[] | null;
  stepRules?: object[] | null;
  boundaryPolicy?: object | null;
  temperature?: number | null;
  knowledgeConfig?: object | null;
};

/** Validate + normalize raw input for agent creation. */
export const parseCreateAgentInput = (args: {
  raw: Record<string, unknown>;
}): { data: ParsedAgentInput } | { errors: string[] } => {
  const errors: string[] = [];
  const { raw } = args;

  if (!raw.ai_provider_id && !raw.aiProviderId) {
    errors.push('ai_provider_id is required');
  }

  if (errors.length > 0) return { errors };

  return {
    data: {
      aiProviderId: (raw.ai_provider_id ?? raw.aiProviderId) as string,
      name: toOptionalString(raw.name),
      instructions: toOptionalString(raw.instructions),
      model: toOptionalString(raw.model),
      toolIds: toOptionalArray<string>(raw.tool_ids ?? raw.toolIds),
      maxSteps: toOptionalNumber(raw.max_steps ?? raw.maxSteps),
      toolChoice: toOptionalObject(raw.tool_choice ?? raw.toolChoice),
      stopConditions: toOptionalArray<object>(raw.stop_conditions ?? raw.stopConditions),
      activeToolIds: toOptionalArray<string>(raw.active_tool_ids ?? raw.activeToolIds),
      stepRules: toOptionalArray<object>(raw.step_rules ?? raw.stepRules),
      boundaryPolicy: toOptionalObject(raw.boundary_policy ?? raw.boundaryPolicy),
      temperature: toOptionalNumber(raw.temperature),
      knowledgeConfig: toOptionalObject(raw.knowledge_config ?? raw.knowledgeConfig),
    },
  };
};

/** Validate + normalize raw input for agent update. */
export const parseUpdateAgentInput = (args: {
  raw: Record<string, unknown>;
}): { data: ParsedAgentUpdateInput } => {
  const { raw } = args;
  return {
    data: {
      aiProviderId: toOptionalString(raw.ai_provider_id ?? raw.aiProviderId),
      name: toNullableString(raw.name),
      instructions: toNullableString(raw.instructions),
      model: toNullableString(raw.model),
      toolIds: toNullableArray<string>(raw.tool_ids ?? raw.toolIds),
      maxSteps: toNullableNumber(raw.max_steps ?? raw.maxSteps),
      toolChoice: toNullableObject(raw.tool_choice ?? raw.toolChoice),
      stopConditions: toNullableArray<object>(raw.stop_conditions ?? raw.stopConditions),
      activeToolIds: toNullableArray<string>(raw.active_tool_ids ?? raw.activeToolIds),
      stepRules: toNullableArray<object>(raw.step_rules ?? raw.stepRules),
      boundaryPolicy: toNullableObject(raw.boundary_policy ?? raw.boundaryPolicy),
      temperature: toNullableNumber(raw.temperature),
      knowledgeConfig: toNullableObject(raw.knowledge_config ?? raw.knowledgeConfig),
    },
  };
};
```

#### `actorInput.ts` — Actor-Specific Input Parsing

```ts
export type ParsedActorCreateInput = {
  name: string;
  externalId?: string;
  instructions?: string | null;
  agentId?: string;
  chatId?: string;
  memoryId?: string;
  autoCreateMemory?: boolean;
};

export const parseCreateActorInput = (args: {
  raw: Record<string, unknown>;
}): { data: ParsedActorCreateInput } | { errors: string[] } => {
  const errors: string[] = [];
  const { raw } = args;

  const name = raw.name;
  if (!name || typeof name !== 'string') {
    errors.push('name is required');
  }

  const agentId = toOptionalString(raw.agent_id ?? raw.agentId);
  const chatId = toOptionalString(raw.chat_id ?? raw.chatId);
  if (agentId && chatId) {
    errors.push('agent_id and chat_id are mutually exclusive');
  }

  if (errors.length > 0) return { errors };

  return {
    data: {
      name: name as string,
      externalId: toOptionalString(raw.external_id ?? raw.externalId),
      instructions: toNullableString(raw.instructions),
      agentId,
      chatId,
      memoryId: toOptionalString(raw.memory_id ?? raw.memoryId),
      autoCreateMemory:
        typeof (raw.auto_create_memory ?? raw.autoCreateMemory) === 'boolean'
          ? ((raw.auto_create_memory ?? raw.autoCreateMemory) as boolean)
          : undefined,
    },
  };
};
```

---

## Revised Architecture

### Before (current)

```
REST handler (actors.ts)
  ├─ inline validation
  ├─ inline ID resolution (resolveActorAgentDbId, etc.)
  └─ calls lib/actors.ts createActor()

Formation module (actorsAgentFormation.ts)
  ├─ schema-driven validation (formationSpecLoader)
  ├─ inline ID resolution (lookupAgentInternalId, etc.)
  └─ calls lib/actors.ts createActor()
```

### After (proposed)

```
Shared layer (resource-inputs/)
  ├─ normalizers.ts          — type coercion utilities
  ├─ idResolver.ts           — unified publicId → internalId
  ├─ agentInput.ts           — parse + validate agent inputs
  └─ actorInput.ts           — parse + validate actor inputs

REST handler (actors.ts)
  ├─ calls actorInput.parseCreateActorInput()
  ├─ calls idResolver.resolvePublicId() → maps to HTTP 400
  └─ calls lib/actors.ts createActor()

Formation module (actorsFormationModule.ts)
  ├─ calls actorInput.parseCreateActorInput()
  ├─ calls idResolver.resolvePublicId() → maps to thrown Error
  └─ calls lib/actors.ts createActor()
```

---

## Formation Module Interface (Revised)

```ts
export type FormationModule = {
  resourceType: string;

  /** Validate formation template properties for this resource type. */
  validateProperties?: (args: {
    properties: unknown;
    basePath: string;
  }) => ValidationError[];

  /** Create a resource. Returns the publicId of the created resource. */
  create: (args: {
    properties: Record<string, unknown>;
    projectId: number;
  }) => Promise<string>;

  /** Update an existing resource by its publicId. */
  update: (args: {
    properties: Record<string, unknown>;
    physicalResourceId: string;
  }) => Promise<void>;

  /** Delete a resource by its publicId. */
  delete: (args: { physicalResourceId: string }) => Promise<void>;

  /** Optional: Read current state (for drift detection, plan diffing). */
  read?: (args: {
    physicalResourceId: string;
  }) => Promise<Record<string, unknown> | null>;
};
```

The `read` method is new — it enables:

- Formation plan diffs (show what _would_ change)
- Drift detection (compare live state vs template)
- Import existing resources into a formation

---

## API Changes

### New REST Endpoints

| Method | Path                                          | Description                          |
| ------ | --------------------------------------------- | ------------------------------------ |
| POST   | `/api/v1/formations`                          | Create formation                     |
| GET    | `/api/v1/formations`                          | List formations                      |
| GET    | `/api/v1/formations/:formation_id`            | Get formation                        |
| PUT    | `/api/v1/formations/:formation_id`            | Update formation (re-apply template) |
| DELETE | `/api/v1/formations/:formation_id`            | Delete formation + resources         |
| GET    | `/api/v1/formations/:formation_id/operations` | List operations                      |
| POST   | `/api/v1/formations/:formation_id/plan`       | Dry-run plan without applying        |

### Removal of Old Paths

Formations is in alpha with no users. All old paths are removed entirely — no deprecation period:

- `/api/v1/agent-formations` — deleted
- `agent-formations.yaml` OpenAPI spec — deleted
- All SDK/CLI/MCP references to `agent-formations` — removed

---

## Implementation Phases

### Phase 1: Extract Shared Layer

1. Create `src/lib/resource-inputs/normalizers.ts`
2. Create `src/lib/resource-inputs/idResolver.ts`
3. Create `src/lib/resource-inputs/agentInput.ts`
4. Create `src/lib/resource-inputs/actorInput.ts`
5. Refactor REST handlers to use shared parsers
6. Refactor formation modules to use shared parsers
7. Verify all tests pass

### Phase 2: Rename to Formations

1. Rename files: `agentFormations*.ts` → `formations*.ts`
2. Rename folder: `agent-formation-modules/` → `formation-modules/`
3. Rename types: `AgentFormationModule` → `FormationModule`
4. Rename registry functions
5. Rename DB models: `AgentFormation` → `Formation`, `AgentFormationResource` → `FormationResource`, `AgentFormationOperation` → `FormationOperation`
6. Rename DB tables (drop and recreate via sync — no data to preserve)
7. Add new REST routes at `/api/v1/formations`
8. Remove old `/api/v1/agent-formations` routes entirely
9. Update OpenAPI spec: `agent-formations.yaml` → `formations.yaml`
10. Regenerate SDK and CLI
11. Update docs and tests

### Phase 3: Add `read` to Formation Modules

1. Add optional `read` method to `FormationModule` interface
2. Implement `read` for agents and actors
3. Enable plan diff in `POST /formations/:id/plan`
4. Add drift detection endpoint (future)

---

## Code Consolidation Summary

| What                                        | Currently Duplicated In                                                                                                                   | Consolidate To                   |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Type normalizers (`toOptionalString`, etc.) | `agentsAgentFormation.ts`, `agents.ts` REST handler                                                                                       | `resource-inputs/normalizers.ts` |
| Agent input validation                      | `agents.ts` REST (`buildCreateAgentArgs`), formation (`validateAgentProperties`)                                                          | `resource-inputs/agentInput.ts`  |
| Actor input validation                      | `actors.ts` REST (`validateCreateActorBody`), formation (`validateActorProperties`, `pushBusinessRuleErrors`)                             | `resource-inputs/actorInput.ts`  |
| ID resolution (publicId → DB ID)            | `actors.ts` REST (`resolveActorAgentDbId`), `agentFormationsHelpers.ts` (`lookupAgentInternalId`), `actors.ts` lib (`updateAgentIdField`) | `resource-inputs/idResolver.ts`  |
| Mutual exclusivity check (agent+chat)       | REST handler, formation module, lib function                                                                                              | `actorInput.ts` (at parse time)  |

---

## Non-Goals

- **Schema-driven REST validation**: We will not replace the REST handler's simple inline checks with the formation's OpenAPI-schema-driven validation engine. The formation spec loader remains formation-specific (it handles `{ ref }`, `{ param }`, `{ sub }` expressions that don't exist in REST).
- **Breaking non-formation REST contracts**: Existing snake_case field names for other modules (agents, actors, etc.) don't change.

---

## Success Criteria

1. Zero duplicated normalization/validation logic between REST and formations
2. Adding a new field to a resource requires changing only the shared input parser + the lib function (not both REST handler AND formation module separately)
3. All existing tests pass without modification
4. New `/api/v1/formations` endpoints are fully functional
5. SDK and CLI regenerated successfully
