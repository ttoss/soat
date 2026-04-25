# PRD: Policy-Aware Queries (SRN → SQL Push-Down)

## Overview

This PRD proposes replacing **post-query permission filtering** with **pre-query SQL WHERE injection** — transforming SRN policy patterns into database-level filters so that unauthorized rows are never fetched.

The core idea: every SRN resource pattern can be decomposed into a deterministic SQL WHERE clause. Instead of fetching N rows and filtering out M, the database returns only the rows the caller is allowed to see.

## Problem

### Current Architecture (and PR #42's Approach)

Today, list and search endpoints work in two phases:

```
Phase 1: SELECT * FROM documents WHERE projectId IN (:projectIds) LIMIT 20
Phase 2: for each row → buildSrn → evaluatePolicies → keep or discard
```

PR #42 implements Phase 2 by adding `filterDocsByPermission` / per-item `isAllowed` calls after every list query. This has several problems:

| Problem                                  | Impact                                                                                                                                                   |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pagination is broken**                 | `LIMIT 20` fetches 20 rows, but after filtering you might return 3. The client asks for page 2 and gets different/overlapping results. `total` is wrong. |
| **O(N) policy evaluations**              | Each row triggers a full policy tree walk. For 1000 docs, that's 1000 evaluations.                                                                       |
| **Semantic search ranking is corrupted** | Vector similarity returns top-K by score, then filtering removes some. The remaining results are no longer the actual top-K accessible to the caller.    |
| **Duplicated pattern across modules**    | The same filter-after-fetch pattern is copy-pasted into documents, files, actors, conversations.                                                         |
| **No SQL-level optimization**            | The database does a full scan/sort, then the app throws away rows. Indexes can't help.                                                                   |

### The Insight

Every SRN pattern used in a policy's `resource` field maps to a finite set of SQL filter types:

| SRN pattern                                   | SQL equivalent                                         |
| --------------------------------------------- | ------------------------------------------------------ |
| `*`                                           | no filter                                              |
| `soat:proj_ABC:document:doc_123`              | `publicId = 'doc_123'`                                 |
| `soat:proj_ABC:document:doc_*`                | `publicId LIKE 'doc_%'`                                |
| `soat:proj_ABC:document:/reports/*`           | `path LIKE '/reports/%'` (after path PRD)              |
| `soat:proj_ABC:document:/reports/2024/q1.txt` | `path = '/reports/2024/q1.txt'`                        |
| `soat:*:document:*`                           | no filter on publicId (project filter handles scoping) |

Conditions (tags) also map to SQL:

| Condition                                            | SQL equivalent                                    |
| ---------------------------------------------------- | ------------------------------------------------- |
| `StringEquals: { "soat:ResourceTag/env": "prod" }`   | `tags->>'env' = 'prod'`                           |
| `StringNotEquals: { "soat:ResourceTag/env": "dev" }` | `(tags->>'env' IS NULL OR tags->>'env' != 'dev')` |
| `StringLike: { "soat:ResourceTag/team": "eng-*" }`   | `tags->>'team' LIKE 'eng-%'`                      |

If we can compile a policy document into a SQL WHERE clause, we solve all five problems above.

## Key Concepts

### Policy Compiler

A **policy compiler** is a function that takes a `PolicyDocument` (array of Allow/Deny statements), an action, and a resource type, and produces a Sequelize `WhereOptions` object that can be injected into any `findAll`/`findAndCountAll` call.

```ts
type CompiledPolicy = {
  where: WhereOptions;       // SQL WHERE clause
  hasAccess: boolean;        // false = deny all (skip query entirely)
  unrestricted: boolean;     // true = no resource filter needed (Allow *)
};

const compilePolicy = (args: {
  policies: PolicyDocument[];
  action: string;
  resourceType: string;
  projectPublicId: string;
}): CompiledPolicy;
```

### Compilation Rules

The compiler walks all statements and collects:

1. **Allow list** — resource patterns and conditions from Allow statements that match the action
2. **Deny list** — resource patterns and conditions from Deny statements that match the action

Then it produces SQL:

```sql
WHERE
  -- Allow: at least one Allow pattern must match
  (publicId = 'doc_123' OR publicId LIKE 'doc_%' OR path LIKE '/reports/%')
  -- Deny: none of the Deny patterns may match
  AND NOT (path LIKE '/secret/%')
  -- Conditions from Allow statements
  AND (tags->>'env' = 'prod')
```

### Statement → SQL Mapping

Each statement with matching action produces a set of SQL fragments:

**Resource patterns** → OR group:

| SRN resource segment | SQL fragment (documents)             | SQL fragment (files)                | SQL fragment (actors) |
| -------------------- | ------------------------------------ | ----------------------------------- | --------------------- |
| `*`                  | `TRUE` (unrestricted)                | `TRUE`                              | `TRUE`                |
| `doc_123`            | `"Document"."publicId" = 'doc_123'`  | —                                   | —                     |
| `doc_*`              | `"Document"."publicId" LIKE 'doc_%'` | —                                   | —                     |
| `/reports/*`         | `"File"."path" LIKE '/reports/%'`    | `"File"."path" LIKE '/reports/%'`   | N/A                   |
| `/reports/q1.txt`    | `"File"."path" = '/reports/q1.txt'`  | `"File"."path" = '/reports/q1.txt'` | N/A                   |

**Condition operators** → AND group per statement:

| Condition                                        | SQL fragment                                |
| ------------------------------------------------ | ------------------------------------------- |
| `StringEquals: { "soat:ResourceTag/k": "v" }`    | `tags->>'k' = 'v'`                          |
| `StringNotEquals: { "soat:ResourceTag/k": "v" }` | `(tags->>'k' IS NULL OR tags->>'k' != 'v')` |
| `StringLike: { "soat:ResourceTag/k": "v*" }`     | `tags->>'k' LIKE 'v%'`                      |

### Module Resource Map (Engine + Registry Pattern)

The system is split into two parts:

1. **Shared engine** (`compilePolicy`) — generic, module-agnostic, lives in `lib/policyCompiler.ts`. It receives a `ResourceFieldMap` and produces Sequelize WHERE. No module-specific logic.
2. **Per-module mapping** — a small declarative config object (3-5 lines) that tells the engine which DB columns correspond to SRN segments. Each module defines its map and exports it.

This means adding SRN support to a new module is **just a config registration** — no new compiler logic, no code duplication.

#### Type Definition

```ts
// lib/policyCompiler.ts — shared engine

import { ModelStatic, Model, WhereOptions } from 'sequelize';

type ResourceFieldMap = {
  resourceType: string;
  /** Column that holds the resource's publicId (e.g., Document.publicId) */
  publicIdColumn: { model: ModelStatic<Model>; column: string };
  /** Optional. Column for path-based SRN matching (e.g., File.path) */
  pathColumn?: { model: ModelStatic<Model>; column: string };
  /** Optional. JSONB column for tag-based conditions (e.g., Document.tags) */
  tagsColumn?: { model: ModelStatic<Model>; column: string };
};

/** Central registry — all modules register here */
const resourceFieldMaps = new Map<string, ResourceFieldMap>();

export const registerResourceFieldMap = (map: ResourceFieldMap) => {
  resourceFieldMaps.set(map.resourceType, map);
};

export const compilePolicy = (args: {
  policies: PolicyDocument[];
  action: string;
  resourceType: string; // ← looks up the map from registry
  projectPublicId: string;
}): CompiledPolicy => {
  const fieldMap = resourceFieldMaps.get(args.resourceType);
  if (!fieldMap)
    throw new Error(`No ResourceFieldMap for ${args.resourceType}`);
  // ... generic compilation using fieldMap columns
};
```

#### Per-Module Registration (3 lines each)

Each module registers its map at startup. This is all the module-specific code needed:

```ts
// lib/documents.ts
import { registerResourceFieldMap } from './policyCompiler';
registerResourceFieldMap({
  resourceType: 'document',
  publicIdColumn: { model: Document, column: 'publicId' },
  pathColumn: { model: File, column: 'path' },
  tagsColumn: { model: Document, column: 'tags' },
});

// lib/files.ts
registerResourceFieldMap({
  resourceType: 'file',
  publicIdColumn: { model: File, column: 'publicId' },
  pathColumn: { model: File, column: 'path' },
  tagsColumn: { model: File, column: 'tags' },
});

// lib/actors.ts
registerResourceFieldMap({
  resourceType: 'actor',
  publicIdColumn: { model: Actor, column: 'publicId' },
  tagsColumn: { model: Actor, column: 'tags' },
});

// lib/conversations.ts
registerResourceFieldMap({
  resourceType: 'conversation',
  publicIdColumn: { model: Conversation, column: 'publicId' },
  tagsColumn: { model: Conversation, column: 'tags' },
});
```

#### Adding a New Module

When a future module (e.g., `memory`) needs SRN support, it's a single registration:

```ts
// lib/memories.ts — this is ALL the SRN plumbing needed
registerResourceFieldMap({
  resourceType: 'memory',
  publicIdColumn: { model: Memory, column: 'publicId' },
  tagsColumn: { model: Memory, column: 'tags' },
});
```

No engine changes, no new compiler logic, no copy-paste. The existing `compilePolicy` engine handles everything.

#### Registry Table

All four current SRN-enabled modules:

| Module        | resourceType   | publicIdColumn          | pathColumn  | tagsColumn          |
| ------------- | -------------- | ----------------------- | ----------- | ------------------- |
| documents     | `document`     | `Document.publicId`     | `File.path` | `Document.tags`     |
| files         | `file`         | `File.publicId`         | `File.path` | `File.tags`         |
| actors        | `actor`        | `Actor.publicId`        | —           | `Actor.tags`        |
| conversations | `conversation` | `Conversation.publicId` | —           | `Conversation.tags` |

Modules without SRN support (agents, secrets, webhooks, etc.) don't register a map — they continue using action-only checks via `resolveProjectIds`.

#### How the Engine Uses the Map

The engine never contains module-specific branching. It uses the map generically:

```ts
// Inside compilePolicy — simplified
const compileResourcePattern = (
  srnResourceSegment: string,
  fieldMap: ResourceFieldMap
): WhereOptions => {
  // Is it a path-based pattern? (starts with /)
  if (srnResourceSegment.startsWith('/') && fieldMap.pathColumn) {
    return isGlob(srnResourceSegment)
      ? {
          [`$${fieldMap.pathColumn.model.name}.${fieldMap.pathColumn.column}$`]:
            { [Op.like]: globToLike(srnResourceSegment) },
        }
      : {
          [`$${fieldMap.pathColumn.model.name}.${fieldMap.pathColumn.column}$`]:
            srnResourceSegment,
        };
  }
  // Otherwise it's an id-based pattern
  return isGlob(srnResourceSegment)
    ? {
        [`$${fieldMap.publicIdColumn.model.name}.${fieldMap.publicIdColumn.column}$`]:
          { [Op.like]: globToLike(srnResourceSegment) },
      }
    : {
        [`$${fieldMap.publicIdColumn.model.name}.${fieldMap.publicIdColumn.column}$`]:
          srnResourceSegment,
      };
};

const compileCondition = (
  condition: Condition,
  fieldMap: ResourceFieldMap
): WhereOptions => {
  // All tag conditions use fieldMap.tagsColumn generically
  // No module-specific logic
};
```

This is the core scalability guarantee: the engine is O(fields) not O(modules). New modules just declare their fields.

### Glob → SQL LIKE Translation

The `matchesPattern` glob engine uses `*` (any chars) and `?` (single char). SQL `LIKE` uses `%` (any chars) and `_` (single char). The translation is:

```ts
const globToLike = (pattern: string): string => {
  // Escape SQL LIKE special chars that are literal in the glob
  let sql = pattern.replace(/%/g, '\\%').replace(/_/g, '\\_');
  // Convert glob wildcards to SQL LIKE
  sql = sql.replace(/\*/g, '%').replace(/\?/g, '_');
  return sql;
};
```

Special case: if the pattern is just `*`, it maps to `TRUE` (no filter), not `LIKE '%'`.

### Deny Compilation

Deny statements compile into `NOT (...)` clauses. The deny WHERE is built the same way as Allow (resource patterns → OR, conditions → AND), then negated:

```sql
AND NOT (
  -- Deny statement 1: deny /secret/*
  ("File"."path" LIKE '/secret/%')
  OR
  -- Deny statement 2: deny docs tagged env=dev
  (tags->>'env' = 'dev')
)
```

A deny with `resource: ["*"]` and no conditions means **deny everything** → `hasAccess = false`, skip the query.

### Multiple Policies

A user may have multiple policies attached (through project membership). Policies are evaluated as a union:

1. Collect all Allow fragments → OR
2. Collect all Deny fragments → OR (then negate the whole group)
3. Final: `(allow_1 OR allow_2 OR ...) AND NOT (deny_1 OR deny_2 OR ...)`

This matches the existing `evaluatePolicies` semantics: any Allow grants access, any Deny revokes it.

## Architecture

### Before (PR #42 pattern)

```
Request → resolveProjectIds → SQL query → fetch N rows → filter by policy → return M ≤ N rows
                                                              ↑
                                                    O(N) × evaluatePolicies
```

### After (this PRD)

```
Request → resolveProjectIds → compilePolicy → inject WHERE → SQL query → return N rows (all authorized)
                                    ↓
                          O(S) compile step (S = number of statements, typically < 10)
```

The policy is compiled **once per request**. The SQL query returns only authorized rows. Pagination, sorting, and vector search all work correctly on the filtered set.

### Integration Point

The compiled WHERE is injected at the **lib layer**, not the route handler. This means:

```ts
// lib/documents.ts
export const listDocuments = async (args: {
  projectIds?: number[];
  policyWhere?: WhereOptions;  // ← new parameter
  limit: number;
  offset: number;
}) => {
  const where = {
    [Op.and]: [
      /* existing project filter */,
      args.policyWhere,  // ← injected policy filter
    ].filter(Boolean),
  };
  return db.Document.findAndCountAll({ where, limit, offset, ... });
};
```

The route handler calls the compiler and passes the result:

```ts
// rest/v1/documents.ts
documentsRouter.get('/documents', async (ctx) => {
  const projectIds = await resolveProjectIds(...);
  const compiled = compilePolicy({
    policies: await getUserPolicies(ctx.authUser),
    action: 'documents:ListDocuments',
    resourceType: 'document',
    projectPublicId: ...,
  });

  if (!compiled.hasAccess) { ctx.status = 403; return; }

  ctx.body = await listDocuments({
    projectIds,
    policyWhere: compiled.unrestricted ? undefined : compiled.where,
    limit, offset,
  });
});
```

### Document Search Integration

`resolveDocumentQuery` in `documentQuery.ts` gets the same treatment. The `applyBoundaryFilter` post-query step is replaced with a pre-query WHERE from the compiled boundary policy:

```ts
export const resolveDocumentQuery = async (args: {
  projectIds?: number[];
  config: DocumentQueryConfig;
  boundaryPolicy?: PolicyDocument;  // typed now, not unknown
  callerPolicyWhere?: WhereOptions; // ← compiled caller policy
}) => {
  // Compile boundary policy → WHERE
  const boundaryWhere = args.boundaryPolicy
    ? compilePolicy({
        policies: [args.boundaryPolicy],
        action: 'documents:SearchDocuments',
        resourceType: 'document',
        ...
      }).where
    : undefined;

  // Merge into findAll WHERE
  const docWhere = {
    [Op.and]: [
      buildDocWhere(config.documentIds),
      args.callerPolicyWhere,
      boundaryWhere,
    ].filter(Boolean),
  };

  // ... vector search or regular query with docWhere
};
```

This means:

- **Pagination works** — `LIMIT`/`OFFSET` apply to the authorized set
- **`total` is correct** — `findAndCountAll` counts only authorized rows
- **Semantic search ranking is preserved** — top-K by similarity within authorized rows
- **No post-query filtering** — `applyBoundaryFilter` is removed

## Condition Context Keys → SQL

Currently, context keys follow the pattern `soat:ResourceType` and `soat:ResourceTag/{key}`. The compiler handles these:

| Context key pattern      | SQL mapping      | Notes                                                                                                 |
| ------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------- |
| `soat:ResourceType`      | No SQL needed    | The resource type is already fixed by the query (we're querying documents, so it's always 'document') |
| `soat:ResourceTag/{key}` | `tags->>'{key}'` | JSONB field extraction                                                                                |

If future context keys are added that don't map to DB columns (e.g., `soat:RequestIP`), those conditions **cannot be compiled** and must remain as post-query checks. The compiler detects these and marks the result as requiring a hybrid approach.

### Hybrid Evaluation

When a policy contains conditions that can't be compiled to SQL:

```ts
type CompiledPolicy = {
  where: WhereOptions;
  hasAccess: boolean;
  unrestricted: boolean;
  requiresPostFilter: boolean; // ← new flag
  postFilterStatements: Statement[]; // ← statements that need runtime eval
};
```

In practice, all current condition keys (`soat:ResourceType`, `soat:ResourceTag/*`) are SQL-compilable, so `requiresPostFilter` will be `false` for the foreseeable future. This is a safety valve for future extensibility.

## Comparison with Existing Approaches

### vs. PR #42 (post-query filtering)

| Aspect            | PR #42                              | This PRD                                         |
| ----------------- | ----------------------------------- | ------------------------------------------------ |
| Pagination        | Broken (returns fewer than `limit`) | Correct                                          |
| Total count       | Wrong (count of filtered page)      | Correct                                          |
| Vector search     | Ranking corrupted                   | Ranking preserved                                |
| Performance       | O(N) per-item evaluations           | O(1) SQL compile per request                     |
| Deny support      | Works (eval per item)               | Works (NOT clause in SQL)                        |
| Condition support | Works (eval per item)               | Works for tag conditions; hybrid for future keys |
| Code duplication  | High (filter in every route)        | Low (one `compilePolicy` call)                   |

### vs. Row-Level Security (RLS)

PostgreSQL RLS could do this at the DB layer. However:

- RLS requires per-session `SET` commands to inject the caller's identity
- Doesn't work well with connection pooling
- Policy language is SQL, not our JSON policy format
- Would tightly couple the IAM model to Postgres

SQL WHERE injection achieves the same result at the application layer with full portability.

## Impact on Memories Module

When a memory is queried through an agent:

1. **Caller policy** → compiled to WHERE by `compilePolicy`
2. **Agent boundary policy** → compiled to WHERE by `compilePolicy`
3. **Memory config** → `paths`, `documentIds`, `search` → existing WHERE construction

All three are merged with `Op.and` in `resolveDocumentQuery`. The database returns only documents that satisfy all three layers. No post-query filtering needed.

## Edge Cases

### Empty Allow Set

If no Allow statement matches the action, `hasAccess = false`. The query is never executed.

### Global Deny

A Deny with `resource: ["*"]` and no conditions → `hasAccess = false`. This matches current behavior (explicit deny short-circuits).

### Deny with Conditions

```json
{
  "effect": "Deny",
  "action": ["documents:*"],
  "resource": ["*"],
  "condition": { "StringEquals": { "soat:ResourceTag/classified": "true" } }
}
```

Compiles to: `AND NOT (tags->>'classified' = 'true')`. Only docs tagged `classified=true` are denied.

### Multiple Projects

When a user has access to multiple projects with different policies per project, the compiler runs per-project and ORs the results:

```sql
WHERE (
  (projectId = 1 AND <policy_for_project_1>)
  OR
  (projectId = 2 AND <policy_for_project_2>)
)
```

This is already naturally handled by `resolveProjectIds` returning `number[]` — the compiler adds resource-level filters scoped to each project.

### Wildcard in Middle of SRN

`soat:proj_ABC:document:/reports/*/summary.txt` → `File.path LIKE '/reports/%/summary.txt'`

The glob `*` in the middle becomes `%` in SQL. This works correctly for hierarchical paths.

## Implementation Checklist

### Phase 1: Core Compiler

- [ ] **`compilePolicy` function** in `packages/server/src/lib/iam.ts` (or new `policyCompiler.ts`)
- [ ] **`globToLike` helper** — glob pattern → SQL LIKE pattern
- [ ] **`ResourceFieldMap` type** and registry
- [ ] **Unit tests** for compiler: Allow-only, Deny-only, mixed, conditions, paths, globs, empty sets
- [ ] **Keep `evaluatePolicies` unchanged** — still used for single-resource checks (GET/:id, DELETE/:id)

### Phase 2: Module Integration

- [ ] **documents**: Update `listDocuments`, `searchDocuments` (via `resolveDocumentQuery`) to accept `policyWhere`
- [ ] **files**: Update `listFiles` to accept `policyWhere`
- [ ] **actors**: Update `listActors` to accept `policyWhere`
- [ ] **conversations**: Update `listConversations` to accept `policyWhere`
- [ ] **Route handlers**: Call `compilePolicy` and pass result to lib functions
- [ ] **Remove `filterDocsByPermission`** and per-item filtering from list endpoints

### Phase 3: Boundary Policy Push-Down

- [ ] **`documentQuery.ts`**: Replace `applyBoundaryFilter` with compiled boundary WHERE
- [ ] **Agent generation**: Compile boundary policy before document query
- [ ] **Memory query**: Same path — boundary + caller policy both compiled

### Phase 4: Cleanup

- [ ] **Remove PR #42 pattern** — delete `filterDocsByPermission`, per-item `isAllowed` in list routes
- [ ] **Update docs** — document the query-time policy enforcement model
- [ ] **Update tests** — verify pagination, total counts, search ranking are correct

## Security Considerations

- **SQL injection**: All values are passed through Sequelize parameterized queries. The `globToLike` function produces LIKE patterns, not raw SQL.
- **Deny precedence**: The SQL `AND NOT (deny_clauses)` preserves the "explicit Deny wins" semantics.
- **Completeness**: If a policy contains a condition operator or context key that the compiler doesn't recognize, it must fall back to post-query evaluation (hybrid mode) rather than silently granting access.
- **Default deny**: If the compiler produces an empty Allow set, the result is `hasAccess = false` (deny by default). No query is executed.

## Examples

### Example 1: User with Path-Scoped Policy

Policy:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:*"],
      "resource": ["soat:proj_ABC:document:/reports/*"]
    }
  ]
}
```

Compiled WHERE for `GET /documents`:

```sql
WHERE "File"."projectId" IN (1)
  AND "File"."path" LIKE '/reports/%'
```

### Example 2: Allow All, Deny Secret Folder

Policy:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:*"],
      "resource": ["soat:proj_ABC:document:*"]
    },
    {
      "effect": "Deny",
      "action": ["documents:*"],
      "resource": ["soat:proj_ABC:document:/secret/*"]
    }
  ]
}
```

Compiled WHERE:

```sql
WHERE "File"."projectId" IN (1)
  AND NOT ("File"."path" LIKE '/secret/%')
```

(The Allow is `*` = unrestricted, so no positive filter. Only the Deny produces a NOT clause.)

### Example 3: Tag-Based Access Control

Policy:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:ListDocuments"],
      "resource": ["soat:proj_ABC:document:*"],
      "condition": {
        "StringEquals": { "soat:ResourceTag/team": "engineering" }
      }
    }
  ]
}
```

Compiled WHERE:

```sql
WHERE "File"."projectId" IN (1)
  AND "Document"."tags"->>'team' = 'engineering'
```

### Example 4: Memory + Boundary + Caller

Agent boundary:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:SearchDocuments"],
      "resource": ["soat:proj_ABC:document:/knowledge-base/*"]
    }
  ]
}
```

Caller policy:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:*"],
      "resource": ["soat:proj_ABC:document:*"]
    }
  ]
}
```

Memory config: `{ "search": "bitcoin", "paths": ["/knowledge-base/crypto/"], "limit": 5 }`

Final SQL WHERE:

```sql
WHERE "File"."projectId" IN (1)
  -- caller policy: * = no filter
  -- boundary policy:
  AND "File"."path" LIKE '/knowledge-base/%'
  -- memory config paths:
  AND "File"."path" LIKE '/knowledge-base/crypto/%'
  -- memory config search: vector similarity ordering
ORDER BY embedding <=> '[...]'
LIMIT 5
```

All three layers are AND-ed at the SQL level. The database returns at most 5 documents that are in `/knowledge-base/crypto/`, within the boundary of `/knowledge-base/*`, ranked by similarity.
