# PRD: Knowledge Packages & Layered Context Assembly

> Part of [Agent Operations on Formations](./prd-agent-operations.md) (G7).
> Complements — does not replace — the retrieval stack in
> [prd-knowledge.md](./prd-knowledge.md) and [prd-memories.md](./prd-memories.md):
> packages hold curated, versioned doctrine; memories/documents keep serving
> the RAG layer. Injects [learned rules](./prd-learned-rules.md) as one of its
> layers.

## Implementation Status

| Component                                   | Status         | Notes                                                                |
| ------------------------------------------- | -------------- | --------------------------------------------------------------------|
| `KnowledgePackage` / `KnowledgeItem` models | ❌ Not started | Immutable per version; content encrypted at rest                     |
| Publish API (tarball + manifest)            | ❌ Not started | Publish-scoped key; called from the knowledge repo's CI              |
| `knowledge_package` formation resource type | ❌ Not started | Pins a package version per stack; parameter = rollout                |
| Layered context assembler                   | ❌ Not started | Pure function with per-layer token budgets                           |
| Fenced (non-system) injection               | ❌ Not started | Aligned with prd-knowledge.md Phase 6 injection hardening            |
| Confidentiality hardening + test suite      | ❌ Not started | Content never in list/get APIs, logs, or run events                  |

## Implementation Phases

### Phase 1 — Package Storage, Publish, Pinning ❌ Not started

**Goal:** Curated knowledge ships as a versioned, immutable artifact that
formations pin — the knowledge source repo itself is never readable by SOAT.

**Deliverables:**

- `KnowledgePackage` + `KnowledgeItem` models (see [Data Model](#data-model));
  item content **encrypted at rest** (same envelope approach as the secrets
  module)
- `POST /api/v1/knowledge-packages` — publish a tarball + manifest;
  authenticated with a **publish-scoped** API key (separate from admin keys);
  a `(name, version)` pair is immutable — re-publishing an existing version
  is a `409`
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

### Confidentiality Boundary

SOAT stores ciphertext and serves the runtime. The source repo is never
readable by SOAT; package content is never readable through SOAT's public
API. The publish credential is scoped to publishing only.

## Data Model

### KnowledgePackage

| Field        | Type   | Description                              |
| ------------ | ------ | ----------------------------------------- |
| `id`         | string | Public ID (`kpk_` prefix)                 |
| `name`       | string | e.g. `acme/ops-intelligence`              |
| `version`    | string | Semver string; unique with `name`         |
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
| createdAt  | TIMESTAMP   | Immutable                                     |

Agent gains `knowledgePackageId` (nullable FK) exposed as
`knowledge_package_id`.

## Permissions

| Permission                                   | Endpoint                                  |
| -------------------------------------------- | ------------------------------------------ |
| `knowledge-packages:PublishKnowledgePackage` | `POST /api/v1/knowledge-packages` (publish-scoped key) |
| `knowledge-packages:ListKnowledgePackages`   | `GET /api/v1/knowledge-packages`           |
| `knowledge-packages:GetKnowledgePackage`     | `GET /api/v1/knowledge-packages/:id` (metadata only) |
| `knowledge-packages:DeleteKnowledgePackage`  | `DELETE /api/v1/knowledge-packages/:id` (admin; blocked while pinned) |

There is deliberately no permission that returns item content.

## REST API

| Method | Path                                  | Description                                    |
| ------ | -------------------------------------- | ---------------------------------------------- |
| POST   | `/api/v1/knowledge-packages`           | Publish (tarball + manifest); immutable per version |
| GET    | `/api/v1/knowledge-packages`           | List packages/versions (metadata only)          |
| GET    | `/api/v1/knowledge-packages/:id`       | Get manifest + checksum (metadata only)         |
| DELETE | `/api/v1/knowledge-packages/:id`       | Remove an unpinned version (admin)              |
