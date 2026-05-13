# PRD: Entities Module

## Implementation Status

| Component                      | Status         | Notes                                                         |
| ------------------------------ | -------------- | ------------------------------------------------------------- |
| `Entity` model                 | ❌ Not started | DB table for typed domain objects                             |
| `Relationship` model           | ❌ Not started | Directed edges connecting actors/entities with verbs          |
| `entities.ts` lib              | ❌ Not started | CRUD + traversal logic                                        |
| REST routes                    | ❌ Not started | `/api/v1/entities`, `/api/v1/relationships`                   |
| OpenAPI spec (`entities.yaml`) | ❌ Not started | Entity and Relationship schemas, CRUD + traverse operations   |
| Permissions                    | ❌ Not started | `entities.json` with entity/relationship actions              |
| Knowledge module integration   | ❌ Not started | `traverseEntities()` as third search source in `knowledge.ts` |
| Module docs page               | ❌ Not started | `packages/website/docs/modules/entities.md`                   |
| Tests                          | ❌ Not started | `entities.test.ts`                                            |
| `searchKnowledge` graph source | ❌ Not started | `source_type: "entity"` in knowledge results                  |

## Overview

The Entities module manages **structured domain objects** and the **relationships between them**. While documents store unstructured text and memories store atomic facts, entities model the real-world objects that actors interact with — companies, products, metrics, people, etc.

Entities form a **knowledge graph** — a directed graph where nodes are entities (and actors) and edges are relationships with semantic verbs. This graph enables traversal-based retrieval: "What does actor_1 own?" → traverse `is_owner_of` edges → find `company_x` → traverse `has_mrr` edges → find `10k in 2025`.

The entities module owns the data (Entity and Relationship tables). The **knowledge module** queries this data via graph traversal as a third search source alongside documents and memories.

## Key Concepts

### Entities

An entity is a typed domain object within a project. It represents something concrete in the user's domain — a company, a product, a metric value, a location, etc.

```
Entity: company_x
  type: "company"
  name: "Company X"
  properties: { "industry": "saas", "founded": "2020" }
```

Entities are **not actors**. Actors are authenticated users or API keys that interact with the system. Entities are passive domain objects that actors have relationships with. However, actors can be **nodes** in the relationship graph — an actor can be connected to entities via relationship edges.

### Relationships

A relationship is a directed edge connecting two nodes (actors or entities) with a semantic verb:

```
actor_1 --[is_owner_of]--> company_x
company_x --[has_mrr]--> mrr_10k_2025
mrr_10k_2025 --[measured_in]--> year_2025
```

Each relationship has:

- **Subject** — the source node (actor or entity)
- **Verb** — the predicate describing the relationship (e.g., `is_owner_of`, `has_mrr`, `works_at`)
- **Object** — the target node (actor or entity)
- **Properties** — optional JSONB metadata on the edge (e.g., temporal bounds, confidence score)

### Node Types

Relationships connect two kinds of nodes:

| Node type | Source table | Example                 |
| --------- | ------------ | ----------------------- |
| `actor`   | `Actor`      | A user persona          |
| `entity`  | `Entity`     | A company, product, KPI |

The subject and object of a relationship can each be either an actor or an entity, enabling four edge patterns:

- actor → entity: `actor_1 --[is_owner_of]--> company_x`
- entity → entity: `company_x --[has_mrr]--> mrr_10k`
- entity → actor: `company_x --[employs]--> actor_2`
- actor → actor: `actor_1 --[reports_to]--> actor_2`

### Properties vs Entities

A key design question: when should a fact be a **property** on an entity vs a **separate entity** connected by a relationship?

- **Property**: static, scalar, unlikely to have its own relationships. E.g., `{ "industry": "saas" }` on a company entity.
- **Separate entity + relationship**: when the fact is temporal, has its own properties, or might connect to other nodes. E.g., MRR of 10k in 2025 — the MRR value could connect to a time period, a data source, etc.

Rule of thumb: if you might want to ask questions _about_ the fact itself (when was it measured? who reported it? how confident is it?), make it an entity.

### Embedding on Entities

Each entity has an optional embedding vector generated from its name, type, and properties. This enables the knowledge module to perform **hybrid retrieval**: cosine similarity search on entity embeddings (like documents/memories) combined with graph traversal.

## Data Model

### Entity Table

| Column       | Type          | Notes                                              |
| ------------ | ------------- | -------------------------------------------------- |
| `id`         | `INTEGER`     | Internal PK, never exposed                         |
| `publicId`   | `STRING(32)`  | Prefix `ent_`, unique, NOT NULL                    |
| `projectId`  | `INTEGER`     | FK → Project, NOT NULL                             |
| `type`       | `STRING`      | Domain type (e.g., `company`, `product`), NOT NULL |
| `name`       | `STRING`      | Human-readable name, NOT NULL                      |
| `properties` | `JSONB`       | Arbitrary key-value metadata, nullable             |
| `embedding`  | `VECTOR(dim)` | From name + type + properties, nullable            |
| `tags`       | `JSONB`       | Key-value string pairs for ABAC, nullable          |
| `createdAt`  | `DATE`        |                                                    |
| `updatedAt`  | `DATE`        |                                                    |

Unique constraint: `(projectId, type, name)` — no duplicate entities of the same type and name within a project.

### Relationship Table

| Column        | Type         | Notes                                                       |
| ------------- | ------------ | ----------------------------------------------------------- |
| `id`          | `INTEGER`    | Internal PK, never exposed                                  |
| `publicId`    | `STRING(32)` | Prefix `rel_`, unique, NOT NULL                             |
| `projectId`   | `INTEGER`    | FK → Project, NOT NULL                                      |
| `subjectType` | `ENUM`       | `actor` or `entity`, NOT NULL                               |
| `subjectId`   | `INTEGER`    | FK → Actor or Entity (polymorphic), NOT NULL                |
| `verb`        | `STRING`     | Semantic predicate (e.g., `is_owner_of`), NOT NULL          |
| `objectType`  | `ENUM`       | `actor` or `entity`, NOT NULL                               |
| `objectId`    | `INTEGER`    | FK → Actor or Entity (polymorphic), NOT NULL                |
| `properties`  | `JSONB`      | Edge metadata (temporal bounds, confidence, etc.), nullable |
| `createdAt`   | `DATE`       |                                                             |
| `updatedAt`   | `DATE`       |                                                             |

Unique constraint: `(projectId, subjectType, subjectId, verb, objectType, objectId)` — no duplicate edges.

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
  "subject_type": "actor",
  "subject_id": "act_01",
  "verb": "is_owner_of",
  "object_type": "entity",
  "object_id": "ent_abc123",
  "properties": { "since": "2020-01-01" }
}
```

Response (`201`):

```json
{
  "id": "rel_xyz789",
  "subject_type": "actor",
  "subject_id": "act_01",
  "verb": "is_owner_of",
  "object_type": "entity",
  "object_id": "ent_abc123",
  "properties": { "since": "2020-01-01" },
  "created_at": "2026-05-12T00:00:00Z",
  "updated_at": "2026-05-12T00:00:00Z"
}
```

#### List Relationships

```
GET /api/v1/relationships?project_id=prj_01&subject_id=act_01&subject_type=actor
```

Query parameters:

- `project_id` (required)
- `subject_id` (optional) — filter by subject
- `subject_type` (optional) — `actor` or `entity`
- `object_id` (optional) — filter by object
- `object_type` (optional) — `actor` or `entity`
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
  "start_node_type": "actor",
  "start_node_id": "act_01",
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
        { "node_type": "actor", "node_id": "act_01", "name": "Pedro" },
        {
          "node_type": "entity",
          "node_id": "ent_abc",
          "name": "Company X",
          "type": "company"
        },
        {
          "node_type": "entity",
          "node_id": "ent_def",
          "name": "10k MRR 2025",
          "type": "metric"
        }
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

- `start_node_type` / `start_node_id` — where to start traversal
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
├── searchMemoryEntries()       → source_type: "memory"     ❌ not started
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
      "start_nodes": [{ "node_type": "actor", "node_id": "act_01" }],
      "verbs": ["is_owner_of", "has_mrr"],
      "max_depth": 2
    }
  }
}
```

If `entity_filters` is provided, the knowledge module traverses the graph starting from the specified nodes (or entities matching the type/ID filters) and includes reachable entities in the results. If no entity filters are specified but entities exist in the project, they are searched by embedding similarity only (no traversal).

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
2. Agent calls `createEntity({ type: "company", name: "Company X", properties: { industry: "saas" } })`
3. Agent calls `createEntity({ type: "metric", name: "10k MRR 2025", properties: { value: 10000, currency: "USD", period: "2025" } })`
4. Agent calls `createRelationship({ subjectType: "actor", subjectId: "act_01", verb: "is_owner_of", objectType: "entity", objectId: "ent_abc" })`
5. Agent calls `createRelationship({ subjectType: "entity", subjectId: "ent_abc", verb: "has_mrr", objectType: "entity", objectId: "ent_def" })`
6. Later, `searchKnowledge` traverses: `act_01 → company_x → 10k_mrr_2025`

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
├── createRelationship()       — create edge, validate both nodes exist
├── listRelationships()        — list with subject/object/verb filters
├── deleteRelationship()       — delete edge
├── traverseEntities()         — BFS/DFS graph traversal with depth limit
├── searchEntitiesByEmbedding() — cosine similarity on entity embeddings
└── types                      — Entity, Relationship, TraversalResult
```

### Traversal Algorithm

```
Input: start_node (type + id), verbs[]?, max_depth, direction, project_id

STEP 1 — VALIDATE
  Verify start_node exists and caller has read access.

STEP 2 — BFS
  Queue ← [(start_node, depth=0)]
  Visited ← {start_node}
  Paths ← []

  WHILE Queue is not empty:
    (node, depth) ← dequeue
    IF depth ≥ max_depth: continue

    edges ← query Relationship where:
      - projectId matches
      - subject or object matches node (based on direction)
      - verb IN verbs (if specified)

    FOR each edge:
      neighbor ← the other node on the edge
      IF neighbor NOT IN Visited:
        Visited.add(neighbor)
        Queue.add((neighbor, depth + 1))
        Record path: node → edge → neighbor

STEP 3 — RETURN
  Return collected paths with node details.
```

Max depth hard cap: 5 (prevents runaway traversals on dense graphs).

## Open Questions

1. **Verb vocabulary** — should verbs be free-form strings or constrained to a predefined set per project? Free-form is more flexible but risks inconsistency (`is_owner_of` vs `owns` vs `owner_of`). A project-level verb registry could help.

2. **Temporal relationships** — the `properties` JSONB on relationships can hold `valid_from` / `valid_to`, but should the module enforce temporal semantics (e.g., filtering by "current" relationships)?

3. **Entity extraction** — should agents automatically extract entities from conversations (like the planned memory extraction), or is entity creation always explicit?

4. **Relationship deduplication** — the unique constraint prevents exact duplicates, but what about semantically equivalent relationships with different verbs (`owns` vs `is_owner_of`)?

5. **Scale** — BFS traversal with max_depth=5 on a dense graph could touch many nodes. Should there be a `max_results` cap on traversal output?
