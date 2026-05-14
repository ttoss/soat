# PRD: Entities Module

## Implementation Status

| Component                      | Status         | Notes                                                         |
| ------------------------------ | -------------- | ------------------------------------------------------------- |
| `Entity` model                 | ❌ Not started | DB table for typed domain objects                             |
| `Relationship` model           | ❌ Not started | Directed edges connecting entities with verbs (entity↔entity) |
| `entities.ts` lib              | ❌ Not started | CRUD + traversal logic                                        |
| REST routes                    | ❌ Not started | `/api/v1/entities`, `/api/v1/relationships`                   |
| OpenAPI spec (`entities.yaml`) | ❌ Not started | Entity and Relationship schemas, CRUD + traverse operations   |
| Permissions                    | ❌ Not started | `entities.json` with entity/relationship actions              |
| Knowledge module integration   | ❌ Not started | `traverseEntities()` as third search source in `knowledge.ts` |
| Module docs page               | ❌ Not started | `packages/website/docs/modules/entities.md`                   |
| Tests                          | ❌ Not started | `entities.test.ts`                                            |
| `searchKnowledge` graph source | ❌ Not started | `source_type: "entity"` in knowledge results                  |

## Overview

The Entities module manages **structured domain objects** and the **relationships between them**. While documents store unstructured text and memories store atomic facts, entities model the real-world objects in a project's domain — companies, products, metrics, people, etc.

Entities form a **knowledge graph** — a directed graph where **all nodes are entities** and edges are relationships with semantic verbs. Actors participate in the graph as entities with `type: "actor"` and an `actorId` FK back to the Actor table. This unified design eliminates polymorphism — relationships are always entity↔entity, enabling simple FK constraints, single-table graph queries, and uniform embedding search.

Example traversal: "What does Pedro own?" → find Entity(`type: "actor"`, `actorId → act_01`) → traverse `is_owner_of` edges → find Entity(`type: "company"`, `name: "Company X"`) → traverse `has_mrr` edges → find Entity(`type: "metric"`, `name: "10k MRR 2025"`).

The entities module owns the data (Entity and Relationship tables). The **knowledge module** queries this data via graph traversal as a third search source alongside documents and memories.

## Key Concepts

### Entities

An entity is a typed domain object within a project. It represents something concrete in the user's domain — a company, a product, a metric value, a location, or even an actor.

```
Entity: company_x
  type: "company"
  name: "Company X"
  properties: { "industry": "saas", "founded": "2020" }

Entity: pedro (actor node)
  type: "actor"
  name: "Pedro"
  actorId: → Actor(act_01)
```

**Actors as entities.** The Actor table remains the source of truth for authentication, sessions, and conversation participation. When an actor needs to participate in the knowledge graph, a corresponding Entity with `type: "actor"` is created with an `actorId` FK pointing back to the Actor row. This is a lightweight bridge — the Entity is the actor's graph representation, not a replacement for the Actor model.

An actor entity can be created automatically (e.g., when the first relationship involving that actor is created) or explicitly via the REST API.

### Relationships

A relationship is a directed edge connecting two entities with a semantic verb:

```
ent_pedro(actor) --[is_owner_of]--> ent_company_x(company)
ent_company_x(company) --[has_mrr]--> ent_mrr_10k(metric)
ent_mrr_10k(metric) --[measured_in]--> ent_2025(period)
```

Each relationship has:

- **Subject** — the source entity (FK → Entity)
- **Verb** — the predicate describing the relationship (e.g., `is_owner_of`, `has_mrr`, `works_at`)
- **Object** — the target entity (FK → Entity)
- **Properties** — optional JSONB metadata on the edge (e.g., temporal bounds, confidence score)

### Unified Node Model

All nodes in the graph are entities. Actors participate as entities with `type: "actor"`.

| Entity type | Example                              | Notes                             |
| ----------- | ------------------------------------ | --------------------------------- |
| `actor`     | Pedro (with `actorId` → Actor table) | Bridge to auth/session system     |
| `company`   | Company X                            | Domain object                     |
| `product`   | Product Y                            | Domain object                     |
| `metric`    | 10k MRR 2025                         | Temporal fact                     |
| _(any)_     | User-defined types per project       | Extensible without schema changes |

Since all nodes live in one table, relationships are always entity↔entity:

- `ent_pedro(actor) --[is_owner_of]--> ent_company_x(company)`
- `ent_company_x(company) --[has_mrr]--> ent_mrr_10k(metric)`
- `ent_company_x(company) --[employs]--> ent_alice(actor)`
- `ent_pedro(actor) --[reports_to]--> ent_alice(actor)`

No polymorphic columns, no UNION queries, real FK constraints on both sides.

### Properties vs Entities

A key design question: when should a fact be a **property** on an entity vs a **separate entity** connected by a relationship?

- **Property**: static, scalar, unlikely to have its own relationships. E.g., `{ "industry": "saas" }` on a company entity.
- **Separate entity + relationship**: when the fact is temporal, has its own properties, or might connect to other nodes. E.g., MRR of 10k in 2025 — the MRR value could connect to a time period, a data source, etc.

Rule of thumb: if you might want to ask questions _about_ the fact itself (when was it measured? who reported it? how confident is it?), make it an entity.

### Embedding on Entities

Each entity has an optional embedding vector generated from its name, type, and properties. This enables the knowledge module to perform **hybrid retrieval**: cosine similarity search on entity embeddings (like documents/memories) combined with graph traversal.

## Data Model

### Entity Table

| Column       | Type          | Notes                                                       |
| ------------ | ------------- | ----------------------------------------------------------- |
| `id`         | `INTEGER`     | Internal PK, never exposed                                  |
| `publicId`   | `STRING(32)`  | Prefix `ent_`, unique, NOT NULL                             |
| `projectId`  | `INTEGER`     | FK → Project, NOT NULL                                      |
| `type`       | `STRING`      | Domain type (e.g., `actor`, `company`, `product`), NOT NULL |
| `name`       | `STRING`      | Human-readable name, NOT NULL                               |
| `actorId`    | `INTEGER`     | FK → Actor, nullable. Set only when `type = "actor"`        |
| `properties` | `JSONB`       | Arbitrary key-value metadata, nullable                      |
| `embedding`  | `VECTOR(dim)` | From name + type + properties, nullable                     |
| `tags`       | `JSONB`       | Key-value string pairs for ABAC, nullable                   |
| `createdAt`  | `DATE`        |                                                             |
| `updatedAt`  | `DATE`        |                                                             |

Unique constraint: `(projectId, type, name)` — no duplicate entities of the same type and name within a project.

Additional constraint: `actorId` is unique (one entity per actor). A `CHECK` constraint ensures `actorId IS NOT NULL` only when `type = 'actor'`.

### Relationship Table

| Column       | Type         | Notes                                                       |
| ------------ | ------------ | ----------------------------------------------------------- |
| `id`         | `INTEGER`    | Internal PK, never exposed                                  |
| `publicId`   | `STRING(32)` | Prefix `rel_`, unique, NOT NULL                             |
| `projectId`  | `INTEGER`    | FK → Project, NOT NULL                                      |
| `subjectId`  | `INTEGER`    | FK → Entity, NOT NULL                                       |
| `verb`       | `STRING`     | Semantic predicate (e.g., `is_owner_of`), NOT NULL          |
| `objectId`   | `INTEGER`    | FK → Entity, NOT NULL                                       |
| `properties` | `JSONB`      | Edge metadata (temporal bounds, confidence, etc.), nullable |
| `createdAt`  | `DATE`       |                                                             |
| `updatedAt`  | `DATE`       |                                                             |

Unique constraint: `(projectId, subjectId, verb, objectId)` — no duplicate edges.

Both `subjectId` and `objectId` are real FK constraints to the Entity table — no polymorphism.

## REST API

All body fields use `snake_case` per project convention.

### Entities

#### Create Entity

```
POST /api/v1/entities
{
  "project_id": "prj_01",
  "type": "company",
  "name": "Company X",
  "properties": { "industry": "saas", "founded": "2020" },
  "tags": { "department": "sales" }
}
```

Response (`201`):

```json
{
  "id": "ent_abc123",
  "type": "company",
  "name": "Company X",
  "properties": { "industry": "saas", "founded": "2020" },
  "tags": { "department": "sales" },
  "created_at": "2026-05-12T00:00:00Z",
  "updated_at": "2026-05-12T00:00:00Z"
}
```

#### Get Entity

```
GET /api/v1/entities/:entity_id
```

#### List Entities

```
GET /api/v1/entities?project_id=prj_01&type=company
```

Query parameters:

- `project_id` (required)
- `type` (optional) — filter by entity type
- `name` (optional) — filter by name (partial match)

#### Update Entity

```
PATCH /api/v1/entities/:entity_id
{
  "name": "Company X Inc.",
  "properties": { "industry": "saas", "founded": "2020", "headquarters": "NYC" }
}
```

#### Delete Entity

```
DELETE /api/v1/entities/:entity_id
```

Deleting an entity also deletes all relationships where it is the subject or object.

### Relationships

#### Create Relationship

```
POST /api/v1/relationships
{
  "project_id": "prj_01",
  "subject_id": "ent_pedro",
  "verb": "is_owner_of",
  "object_id": "ent_abc123",
  "properties": { "since": "2020-01-01" }
}
```

Both `subject_id` and `object_id` are entity IDs (`ent_` prefix). To connect an actor, first ensure the actor has a corresponding entity (created automatically or via `POST /api/v1/entities` with `type: "actor"` and `actor_id`).

Response (`201`):

```json
{
  "id": "rel_xyz789",
  "subject_id": "ent_pedro",
  "verb": "is_owner_of",
  "object_id": "ent_abc123",
  "properties": { "since": "2020-01-01" },
  "created_at": "2026-05-12T00:00:00Z",
  "updated_at": "2026-05-12T00:00:00Z"
}
```

#### List Relationships

```
GET /api/v1/relationships?project_id=prj_01&subject_id=ent_pedro
```

Query parameters:

- `project_id` (required)
- `subject_id` (optional) — filter by subject entity ID
- `object_id` (optional) — filter by object entity ID
- `verb` (optional) — filter by verb

#### Delete Relationship

```
DELETE /api/v1/relationships/:relationship_id
```

### Traverse

#### Traverse Graph

```
POST /api/v1/entities/traverse
{
  "project_id": "prj_01",
  "start_entity_id": "ent_pedro",
  "verbs": ["is_owner_of", "has_mrr"],
  "max_depth": 3,
  "direction": "outgoing"
}
```

Response:

```json
{
  "paths": [
    {
      "nodes": [
        { "id": "ent_pedro", "type": "actor", "name": "Pedro" },
        { "id": "ent_abc", "type": "company", "name": "Company X" },
        { "id": "ent_def", "type": "metric", "name": "10k MRR 2025" }
      ],
      "edges": [
        { "id": "rel_01", "verb": "is_owner_of" },
        { "id": "rel_02", "verb": "has_mrr" }
      ]
    }
  ]
}
```

Parameters:

- `start_entity_id` — entity ID to start traversal from (can be any type including `actor`)
- `verbs` (optional) — only follow edges with these verbs; if omitted, follow all
- `max_depth` — maximum hops (default: 2, max: 5)
- `direction` — `outgoing`, `incoming`, or `both` (default: `outgoing`)

### Endpoints Summary

| Method | Path                                     | Description                     |
| ------ | ---------------------------------------- | ------------------------------- |
| POST   | `/api/v1/entities`                       | Create an entity                |
| GET    | `/api/v1/entities`                       | List entities in a project      |
| GET    | `/api/v1/entities/:entity_id`            | Get a single entity             |
| PATCH  | `/api/v1/entities/:entity_id`            | Update an entity                |
| DELETE | `/api/v1/entities/:entity_id`            | Delete an entity and its edges  |
| POST   | `/api/v1/relationships`                  | Create a relationship           |
| GET    | `/api/v1/relationships`                  | List relationships with filters |
| DELETE | `/api/v1/relationships/:relationship_id` | Delete a relationship           |
| POST   | `/api/v1/entities/traverse`              | Traverse the entity graph       |

## Knowledge Module Integration

The entities module is a **data source** for the knowledge module, same as documents and memories. The knowledge module queries entities via graph traversal and merges results into unified search output.

### How It Fits

```
searchKnowledge()
├── resolveDocumentSearch()     → source_type: "document"   ✅ done
├── resolveMemorySearch()       → source_type: "memory"     ✅ done
└── traverseEntities()          → source_type: "entity"     ❌ not started (this PRD)
```

### Entity Results in Knowledge Search

When the knowledge module includes entity traversal, results look like:

```json
{
  "source_type": "entity",
  "entity_id": "ent_abc",
  "entity_type": "company",
  "name": "Company X",
  "content": "Company X (company) — industry: saas, founded: 2020. Relationships: owned by Pedro (actor), has MRR 10k in 2025.",
  "score": 0.85
}
```

The `content` field is synthesized from the entity's properties and its immediate relationships, then scored by embedding similarity to the query.

### Knowledge Config Extension

The `knowledge_config` on agents gains an optional `entity_filters` field:

```json
{
  "knowledge_config": {
    "memory_ids": ["mem_abc"],
    "document_paths": ["/sales/"],
    "entity_filters": {
      "entity_ids": ["ent_abc"],
      "entity_types": ["company", "product"],
      "start_entity_ids": ["ent_pedro"],
      "verbs": ["is_owner_of", "has_mrr"],
      "max_depth": 2
    }
  }
}
```

Since actors are entities, `start_entity_ids` can include actor entities (e.g., `ent_pedro` with `type: "actor"`). No separate `start_nodes` with type discrimination needed.

If `entity_filters` is provided, the knowledge module traverses the graph starting from the specified entities and includes reachable entities in the results. If no entity filters are specified but entities exist in the project, they are searched by embedding similarity only (no traversal).

## Agent Integration

### soat-tools

The entities module exposes CRUD tools auto-generated from the OpenAPI spec:

| Tool                 | Description                                         |
| -------------------- | --------------------------------------------------- |
| `createEntity`       | Create a new entity in the project                  |
| `listEntities`       | List entities with optional type/name filters       |
| `getEntity`          | Get a single entity by ID                           |
| `updateEntity`       | Update entity name, properties, or tags             |
| `deleteEntity`       | Delete an entity and all its relationships          |
| `createRelationship` | Create a directed relationship between nodes        |
| `listRelationships`  | List relationships with subject/object/verb filters |
| `deleteRelationship` | Delete a relationship                               |
| `traverseEntities`   | Traverse the entity graph from a starting node      |

These tools enable agents to **build knowledge graphs dynamically** during conversations — an agent can create entities, link them with relationships, and later query the graph for context.

### Example Agent Workflow

1. Agent processes a conversation: "Pedro owns Company X, which has 10k MRR in 2025"
2. Agent calls `createEntity({ type: "actor", name: "Pedro", actorId: "act_01" })` → returns `ent_pedro`
3. Agent calls `createEntity({ type: "company", name: "Company X", properties: { industry: "saas" } })` → returns `ent_abc`
4. Agent calls `createEntity({ type: "metric", name: "10k MRR 2025", properties: { value: 10000, currency: "USD", period: "2025" } })` → returns `ent_def`
5. Agent calls `createRelationship({ subjectId: "ent_pedro", verb: "is_owner_of", objectId: "ent_abc" })`
6. Agent calls `createRelationship({ subjectId: "ent_abc", verb: "has_mrr", objectId: "ent_def" })`
7. Later, `searchKnowledge` traverses: `ent_pedro(actor) → ent_abc(company) → ent_def(metric)`

Step 2 can be skipped if the actor entity already exists (e.g., auto-created on first relationship).

## Permissions

| Permission                    | Endpoint                                        |
| ----------------------------- | ----------------------------------------------- |
| `entities:CreateEntity`       | `POST /api/v1/entities`                         |
| `entities:ListEntities`       | `GET /api/v1/entities`                          |
| `entities:GetEntity`          | `GET /api/v1/entities/:entity_id`               |
| `entities:UpdateEntity`       | `PATCH /api/v1/entities/:entity_id`             |
| `entities:DeleteEntity`       | `DELETE /api/v1/entities/:entity_id`            |
| `entities:CreateRelationship` | `POST /api/v1/relationships`                    |
| `entities:ListRelationships`  | `GET /api/v1/relationships`                     |
| `entities:DeleteRelationship` | `DELETE /api/v1/relationships/:relationship_id` |
| `entities:TraverseEntities`   | `POST /api/v1/entities/traverse`                |

## Implementation Architecture

```
src/lib/entities.ts
├── createEntity()             — create entity, generate embedding
├── getEntity()                — get by publicId with policy check
├── listEntities()             — list with type/name/project filters
├── updateEntity()             — update fields, regenerate embedding
├── deleteEntity()             — delete entity + cascade relationships
├── getOrCreateActorEntity()   — find or create entity with type="actor" for a given actorId
├── createRelationship()       — create edge, validate both entities exist
├── listRelationships()        — list with subject/object/verb filters
├── deleteRelationship()       — delete edge
├── traverseEntities()         — BFS/DFS graph traversal with depth limit (single-table, no polymorphism)
├── searchEntitiesByEmbedding() — cosine similarity on entity embeddings (single query, all types)
└── types                      — Entity, Relationship, TraversalResult
```

### Traversal Algorithm

```
Input: start_entity_id, verbs[]?, max_depth, direction, project_id

STEP 1 — VALIDATE
  Verify start entity exists and caller has read access.

STEP 2 — BFS (single-table, no polymorphism)
  Queue ← [(start_entity, depth=0)]
  Visited ← {start_entity.id}
  Paths ← []

  WHILE Queue is not empty:
    (entity, depth) ← dequeue
    IF depth ≥ max_depth: continue

    edges ← query Relationship where:
      - projectId matches
      - subjectId or objectId matches entity.id (based on direction)
      - verb IN verbs (if specified)
    (Single JOIN on Entity table — no CASE/UNION needed)

    FOR each edge:
      neighbor ← Entity on the other side of the edge
      IF neighbor.id NOT IN Visited:
        Visited.add(neighbor.id)
        Queue.add((neighbor, depth + 1))
        Record path: entity → edge → neighbor

STEP 3 — RETURN
  Return collected paths with entity details (including type for context).
```

Max depth hard cap: 5 (prevents runaway traversals on dense graphs).

## Design Decision: Unified Node Model

The original design used polymorphic relationships (`subjectType`/`objectType` as `actor | entity`). This was replaced with a **unified model** where all graph nodes are entities:

| Concern               | Polymorphic (old)                                 | Unified (current)                               |
| --------------------- | ------------------------------------------------- | ----------------------------------------------- |
| Relationship FKs      | Polymorphic (no real DB constraint)               | Real FK → Entity on both sides                  |
| Graph queries         | CASE/UNION across Actor + Entity tables           | Single JOIN on Entity table                     |
| Embedding search      | UNION across two tables (Actor has no embeddings) | Single query on Entity table                    |
| Adding new node types | Change enum + all queries                         | Add new `type` value, no schema change          |
| Actor auth concerns   | Mixed into graph model                            | Cleanly separated: Actor = auth, Entity = graph |

The `actorId` FK on Entity is the only bridge between the two worlds. Actor-specific behavior (sessions, messages, auth) stays in the Actor table. Graph behavior (relationships, traversal, embeddings) stays in Entity.

## Open Questions

1. **Verb vocabulary** — should verbs be free-form strings or constrained to a predefined set per project? Free-form is more flexible but risks inconsistency (`is_owner_of` vs `owns` vs `owner_of`). A project-level verb registry could help.

2. **Temporal relationships** — the `properties` JSONB on relationships can hold `valid_from` / `valid_to`, but should the module enforce temporal semantics (e.g., filtering by "current" relationships)?

3. **Entity extraction** — should agents automatically extract entities from conversations (like the planned memory extraction), or is entity creation always explicit?

4. **Relationship deduplication** — the unique constraint prevents exact duplicates, but what about semantically equivalent relationships with different verbs (`owns` vs `is_owner_of`)?

5. **Scale** — BFS traversal with max_depth=5 on a dense graph could touch many nodes. Should there be a `max_results` cap on traversal output?

6. **Auto-creation of actor entities** — should the system automatically create an entity with `type: "actor"` when an Actor is created, or only on demand (first relationship, explicit API call)? On-demand keeps the Entity table lean; auto-creation ensures actors are always graph-ready.
