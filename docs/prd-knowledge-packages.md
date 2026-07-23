# PRD: Knowledge Packages & Layered Context Assembly

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G7).
> Complements — does not replace — the retrieval stack in
> [prd-knowledge.md](./prd-knowledge.md) and [prd-memories.md](./prd-memories.md):
> packages hold curated, versioned doctrine; memories/documents keep serving
> the RAG layer. Injects [learned rules](./prd-learned-rules.md) as one of its
> layers.

## Implementation Phases

### Phase 1 — Package Storage, Publish, Pinning ❌ Not started

**Goal:** Curated knowledge ships as a versioned, immutable artifact that
formations pin — the knowledge source repo itself is never readable by SOAT.

**Deliverables:**

- `KnowledgePackage` + `KnowledgeItem` models (see [Data Model](#data-model));
  item content **encrypted at rest** (same envelope approach as the secrets
  module)
- `POST /api/v1/knowledge-packages` — publish a tarball + manifest;
  authenticated with a **publish-scoped** project API key (separate from
  admin keys); a `(name, version)` pair is immutable within its project —
  re-publishing an existing version is a `409`
- Manifest declares items with a `kind` (free-form, e.g. `constitution`,
  `playbook`, `overlay`), an optional `role` filter, and the package's layer
  order (see [Key Concepts](#layer-order-is-package-defined))
- Formation resource type `knowledge_package` + `knowledge_package_id` on the
  Agent:

```yaml
resources:
  StackKnowledge:
    type: knowledge_package
    properties:
      package: acme/ops-intelligence
      version: { param: KnowledgeVersion } # bump = rollout, formation update semantics
```

- List/get APIs return **metadata only** (name, version, manifest, checksum) —
  never item content

**Unlocks:** Knowledge rollout by parameter bump — incremental and reversible
like any formation update — and every run able to state exactly which
knowledge version produced any action.

### Phase 2 — Layered Context Assembler ❌ Not started

**Goal:** Agent context is assembled in a fixed layer order under a token
budget, deterministically.

**Deliverables:**

- Pure assembler function:
  `(package, role, project, task, budget) → messages[]` — no I/O beyond its
  inputs, unit-testable in isolation (the hook for a future eval harness)
- Layer order (package-defined; typical): curated doctrine layers from the
  package (broadest first) → project context values → active
  [learned rules](./prd-learned-rules.md) (`global → project`, most specific
  last) → task RAG retrieval via the existing
  [knowledge search](./prd-knowledge.md)
- Per-layer budget shares from the package manifest; **truncation drops from
  the bottom** (RAG first), never the top doctrine layer
- All injected content is **fenced as reference data, never `system` role** —
  the injection-hardening direction of
  [prd-knowledge.md Phase 6](./prd-knowledge.md#phase-6--injection-hardening-memory-as-untrusted-input--future)
  applies to package content from day one
- Wired into agent generation when the agent has a `knowledge_package_id`;
  existing memory/document injection paths are unchanged for agents without
  one

**Unlocks:** Predictable context composition — the same inputs always produce
the same assembly, auditable and testable.

### Phase 3 — Confidentiality Hardening ❌ Not started

**Goal:** Package content is readable by the runtime at assembly time and by
nothing else.

**Deliverables:**

- Access rule: item content is decrypted only inside the assembler; no REST
  endpoint returns it (admin included — republish, don't read back)
- A dedicated **"knowledge never leaks"** test suite: content absent from
  list/get responses, logs, run events, node execution records, traces,
  webhook payloads, and error messages (including assembler failures)
- Checksum verification on publish and on load; audit log entries for every
  publish and every version pin change

**Unlocks:** Proprietary methodology can be deployed through SOAT with a
confidentiality boundary that is tested, not asserted.

## Overview

Operating agent stacks run on two kinds of knowledge. **Retrieved** knowledge
(memories, documents, RAG) already exists in SOAT. **Curated doctrine** — the
methodology, playbooks, and per-vertical overlays a team maintains in a
(possibly private) repo — does not fit that shape: it must be versioned as a
unit, rolled out and rolled back atomically, injected in a deliberate order
under a token budget, and auditable ("which playbook version produced this
action?").

A **knowledge package** is that artifact: built and published from the source
repo's CI, immutable per version, pinned by formations, and assembled into
agent context by a deterministic, budgeted, layered assembler.

## Key Concepts

### Immutability and Rollout

A published `(name, version)` never changes. Formations pin a version;
changing the pinned version is a normal formation update — incremental,
reversible, and recorded. Rollback is re-pinning the previous version.

### Layer Order Is Package-Defined

The manifest declares the package's layers (ordered, each mapping to item
`kind`s with a budget share). SOAT does not hard-code domain layer names; it
guarantees the **mechanics**: fixed order, per-layer budgets, bottom-first
truncation, learned rules and RAG appended after the package layers.

### Example Manifest

A complete manifest for a package with three layers:

```yaml
name: acme/ops-intelligence
version: 1.4.0
layers:
  - name: constitution
    kinds: [constitution]
    budget_share: 0.15
  - name: playbooks
    kinds: [playbook]
    budget_share: 0.55
  - name: vertical-overlays
    kinds: [overlay]
    budget_share: 0.30
items:
  - path: constitution/core.md
    kind: constitution
  - path: playbooks/budget-review.md
    kind: playbook
    role: analyst
  - path: playbooks/escalation.md
    kind: playbook
  - path: overlays/healthcare.md
    kind: overlay
    role: healthcare-ops
```

| Field                  | Required | Description                                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `name`                 | yes      | Package name, unique with `version` within the project                                            |
| `version`              | yes      | Semver string; a published `(name, version)` is immutable                                         |
| `layers[]`             | yes      | Ordered — assembly order is exactly this order, broadest doctrine first                           |
| `layers[].name`        | yes      | Free-form label; used in audit records and assembler errors                                       |
| `layers[].kinds`       | yes      | Item `kind`s this layer includes; a `kind` may appear in at most one layer                        |
| `layers[].budget_share`| yes      | Fraction (0, 1] of the package's total token budget; shares must sum to ≤ 1.0 (validated on publish) |
| `items[]`              | yes      | Every file in the tarball; order within a layer is priority order (earlier = higher)              |
| `items[].path`         | yes      | Path within the tarball, unique per package                                                       |
| `items[].kind`         | yes      | Must match a `kind` declared by some layer (validated on publish)                                 |
| `items[].role`         | no       | Item included only for agents with this role; omitted = all roles                                 |

Publish-time validation failures (shares out of range or summing above 1.0,
an item `kind` no layer declares, duplicate paths) reject the publish with a
`400` — a package that validated never fails structurally at assembly time.

### Token Budget Accounting

**Tokenizer (decision):** budgets are computed with a **model-agnostic
estimator** (a bundled `cl100k_base`-class tokenizer applied uniformly to
every item), not the target provider's tokenizer. Rationale: the assembler is
a pure, deterministic function — the same package must assemble identically
regardless of which provider/model the agent runs on, and provider tokenizers
would make assembly non-deterministic across models. Tradeoff: estimates can
drift ~10–20% from a given provider's true count, so layer budgets are
targets, not hard provider limits; the assembler applies a 10% safety margin
against the overall context budget.

Item token counts are computed once at publish and stored on the item, so
assembly never re-tokenizes content.

**Overflow (decision):** when a layer's content exceeds its
`budget_share × budget`, the assembler drops **whole items from the end of
the layer's manifest order** (manifest order = priority; later items drop
first) until the layer fits. Items are never split mid-content — a truncated
playbook is worse than an absent one. If even the first item of the first
(top doctrine) layer does not fit, assembly **fails with an error** rather
than injecting truncated doctrine. Cross-layer truncation is unchanged:
bottom layers (RAG first) shed before upper ones, never the top layer.

### Tenancy (Project-Scoped)

**Decision:** knowledge packages are **project-scoped**, like every other
SOAT resource: `KnowledgePackage` carries a `project_id` FK, `(name,
version)` uniqueness is per project, and all permission actions are scoped by
project policy. Rationale: consistency — every resource in the platform is
project-scoped and the policy engine already expresses per-project grants; a
global registry would require a new cross-project grant mechanism for no
current need. A team shipping the same package to several projects publishes
it to each from CI (the publish-scoped key is a project key, so this falls
out naturally). List/get/pin never cross project boundaries; a formation can
only pin packages in its own project.

### Confidentiality Boundary

SOAT stores ciphertext and serves the runtime. The source repo is never
readable by SOAT; package content is never readable through SOAT's public
API. The publish credential is scoped to publishing only.

## Data Model

### KnowledgePackage

| Field        | Type   | Description                              |
| ------------ | ------ | ----------------------------------------- |
| `id`         | string | Public ID (`kpk_` prefix)                 |
| `project_id` | string | Owning project — packages are project-scoped (see [Tenancy](#tenancy-project-scoped)) |
| `name`       | string | e.g. `acme/ops-intelligence`              |
| `version`    | string | Semver string; unique with `(project_id, name)` |
| `manifest`   | object | Layers, items, budget shares              |
| `checksum`   | string | SHA-256 of the published tarball          |
| `created_at` | string | Immutable — no `updated_at`               |

### KnowledgeItem

| Column     | Type        | Constraints                                  |
| ---------- | ----------- | --------------------------------------------- |
| packageId  | INTEGER     | FK → KnowledgePackage, NOT NULL               |
| path       | VARCHAR     | Path within the package, unique per package   |
| kind       | VARCHAR     | Manifest-declared kind                        |
| role       | VARCHAR     | NULL = applies to all roles                   |
| content    | BYTEA       | Encrypted at rest (`SECRETS_ENCRYPTION_KEY` envelope) |
| tokenCount | INTEGER     | Estimator token count, computed once at publish (see [Token Budget Accounting](#token-budget-accounting)) |
| createdAt  | TIMESTAMP   | Immutable                                     |

Agent gains `knowledgePackageId` (nullable FK) exposed as
`knowledge_package_id`.

## Permissions

| Permission                                   | Endpoint                                  |
| -------------------------------------------- | ------------------------------------------ |
| `knowledge-packages:PublishKnowledgePackage` | `POST /api/v1/knowledge-packages` (publish-scoped project key) |
| `knowledge-packages:ListKnowledgePackages`   | `GET /api/v1/knowledge-packages`           |
| `knowledge-packages:GetKnowledgePackage`     | `GET /api/v1/knowledge-packages/{package_id}` (metadata only) |
| `knowledge-packages:DeleteKnowledgePackage`  | `DELETE /api/v1/knowledge-packages/{package_id}` (admin; blocked while pinned) |

All actions are scoped by project policy, like every other module. There is
deliberately no permission that returns item content.

## REST API

| Method | Path                                         | Description                                    |
| ------ | --------------------------------------------- | ---------------------------------------------- |
| POST   | `/api/v1/knowledge-packages`                  | Publish (tarball + manifest); immutable per version |
| GET    | `/api/v1/knowledge-packages`                  | List packages/versions within the project (metadata only) |
| GET    | `/api/v1/knowledge-packages/{package_id}`     | Get manifest + checksum (metadata only)         |
| DELETE | `/api/v1/knowledge-packages/{package_id}`     | Remove an unpinned version (admin)              |
