# PRD: Document Paths & Path-Based SRN Resources

## Overview

This PRD covers two tightly coupled changes:

1. **Add a `path` field to documents (and files)** — a dedicated, normalized path that decouples the logical hierarchy from the raw `filename`.
2. **Extend the SRN format to support path-based resources** — enabling policies that grant or deny access to entire directory subtrees, individual paths, or glob patterns, following the same model as AWS S3 bucket policies.

These two features combine to give SOAT a hierarchical, permission-aware document namespace — essential for the Memory module (RAG scoping) and for any multi-tenant or multi-department deployment.

## Motivation

### Current State

- Documents inherit `filename` from the underlying File record (e.g., `knowledge-base/bitcoin/intro.txt`).
- The `paths` filter in document queries uses `File.filename LIKE '{prefix}%'` — a SQL prefix match on a field that also serves as the human-readable file name.
- SRN format is `soat:<project>:<resourceType>:<resourceId>`. There is no way to reference a _group_ of documents by path — only by individual public ID or `*` (all).
- Policies cannot express "allow access to all documents under `/reports/2024/`" without enumerating every document ID.

### Problems

| Problem                                              | Impact                                                                                                                               |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `filename` conflates display name and path           | Renaming a file changes its position in the hierarchy                                                                                |
| No normalized path with leading `/`                  | Prefix queries are brittle — `reports/` vs `reports` vs `/reports/`                                                                  |
| SRN only supports `<resourceId>` or `*`              | Cannot scope agent boundary policies or user policies to a directory subtree                                                         |
| Memory `paths` filter lacks access control awareness | A memory with `paths: ["/secret/"]` returns docs the caller may not be authorized to see (unless boundary policy is also configured) |

## Key Concepts

### Document Path

A path is a `/`-separated, Unix-style string that defines where a document lives in the project's logical namespace.

| Rule                                               | Example                                          |
| -------------------------------------------------- | ------------------------------------------------ |
| Must start with `/`                                | `/reports/2024/q1.txt`                           |
| No trailing `/` (it's a file, not a directory)     | `/reports/2024/q1.txt` ✓ — `/reports/2024/` ✗    |
| May contain alphanumeric chars, `-`, `_`, `.`, `/` | `/my-folder/sub_dir/file.txt`                    |
| Max depth: 20 segments                             | `/a/b/c/.../t/file.txt`                          |
| Max length: 1024 characters                        | —                                                |
| Must be unique within a project                    | Two docs in the same project cannot share a path |

When a document is created:

- If `path` is provided, use it as-is (after validation and normalization).
- If `path` is omitted, default to `/<filename>`.

### Path vs Filename

| Field      | Purpose                                                                                                 | Example                             |
| ---------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `path`     | Hierarchical location in the project namespace. Used for policy matching, queries, and tree navigation. | `/knowledge-base/bitcoin/intro.txt` |
| `filename` | Original upload name. Human-readable label. Not used for access control.                                | `intro.txt`                         |

The `filename` field on File remains unchanged. The new `path` field lives on **Document** (not File) because paths are specific to the document namespace. A single File could theoretically back multiple documents (future), and the path is a document-level concept.

## Path-Based SRN

### Current SRN Format

```
soat:<projectPublicId>:<resourceType>:<resourceId>
```

Examples: `soat:proj_ABC:document:doc_123`, `soat:proj_ABC:document:*`

### Extended SRN Format

Add a new resource segment syntax for path-based resources:

```
soat:<projectPublicId>:<resourceType>:<resourceId-or-path>
```

The `<resourceId-or-path>` segment can be:

| Pattern                  | Matches                                                     | S3 Equivalent                               |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------- |
| `*`                      | All resources of this type                                  | `arn:aws:s3:::bucket/*`                     |
| `doc_ABC`                | Exact resource by ID                                        | `arn:aws:s3:::bucket/exact-key`             |
| `/my/path/*`             | All documents whose path starts with `/my/path/`            | `arn:aws:s3:::bucket/my/path/*`             |
| `/my/path/file.txt`      | Exact document at this path                                 | `arn:aws:s3:::bucket/my/path/file.txt`      |
| `/reports/*/summary.txt` | Glob: any folder under `/reports/` containing `summary.txt` | `arn:aws:s3:::bucket/reports/*/summary.txt` |

### How S3 Does It (and How SOAT Follows)

In S3, a bucket policy resource looks like:

```json
"Resource": "arn:aws:s3:::my-bucket/reports/*"
```

This matches all objects whose key starts with `reports/`. S3 treats `*` as "zero or more of any character" and `?` as "exactly one character". There is no regex — just glob-style wildcards.

SOAT follows the same model. The `matchesPattern` function in `iam.ts` already supports glob matching (`*` = any chars, `?` = single char). The extension is that the `<resourceId>` segment of an SRN can now contain `/` characters (representing paths), and the existing glob matching applies naturally.

### Policy Examples

**Allow all document operations under `/reports/2024/`:**

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:*"],
      "resource": ["soat:proj_ABC:document:/reports/2024/*"]
    }
  ]
}
```

**Allow read-only access to a specific document by path:**

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:GetDocument", "documents:SearchDocuments"],
      "resource": ["soat:proj_ABC:document:/knowledge-base/bitcoin/intro.txt"]
    }
  ]
}
```

**Deny access to secret docs, allow everything else:**

```json
{
  "statement": [
    {
      "effect": "Deny",
      "action": ["documents:*"],
      "resource": ["soat:proj_ABC:document:/secret/*"]
    },
    {
      "effect": "Allow",
      "action": ["documents:*"],
      "resource": ["soat:proj_ABC:document:*"]
    }
  ]
}
```

Note: explicit Deny wins over Allow (same as AWS IAM and already implemented in `evaluatePolicies`).

**Agent boundary — restrict to a subtree:**

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

### SRN Resolution for Documents

When checking permissions for a document, the SRN is built using **both** the document's ID and its path. The `evaluatePolicies` function receives both and checks against all resource patterns in the policy:

```
Primary SRN:   soat:proj_ABC:document:doc_123
Path SRN:      soat:proj_ABC:document:/knowledge-base/bitcoin/intro.txt
```

A policy resource pattern matches if it matches **either** the ID-based SRN or the path-based SRN. This ensures backward compatibility — existing policies that use `doc_*` or `*` patterns continue to work.

### SRN Validation Changes

The current `isValidSrnPattern` function validates:

```
* | soat:<project>:<type>:<id>
```

It must be extended to allow `/` in the last segment:

```ts
const isValidSrnPattern = (srn: string): boolean => {
  if (srn === '*') return true;
  // Allow path characters (/, ., -, _) and wildcards (*, ?) in the resource segment
  return /^soat:[^:]+:[^:]+:[^:]+$/.test(srn);
};
```

The existing regex already allows any character in the last segment (`[^:]+` = one or more non-colon characters), so `/` is already technically valid. The change is semantic — documenting and intentionally supporting path values in that segment.

## Data Model Changes

### Document Table — New Column

| Column | DB Type       | Notes                                                                                                                                                                                           |
| ------ | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| path   | VARCHAR(1024) | Normalized path starting with `/`. Unique within a project (composite unique: `projectId` + `path` via the File's `projectId`). Nullable initially for migration (backfill from `/<filename>`). |

Since Document doesn't have a direct `projectId` FK (it goes through File), the uniqueness constraint is: unique index on `(path)` scoped to documents within the same project. This can be enforced at the application level or via a composite unique index joining Document.path with File.projectId.

**Alternative**: Add `path` to the **File** model instead (since File already has `projectId`). This keeps the uniqueness constraint simpler (`UNIQUE(projectId, path)` on File). Documents inherit the path from their File. Non-document files also get path support for free.

**Recommendation**: Add `path` to **File** (not Document). Rationale:

- File already has `projectId` — composite unique `(projectId, path)` is trivial.
- Future: non-document files (images, PDFs) also benefit from path hierarchy.
- Document queries already join on File — no extra join needed.
- The Memory `paths` filter already queries `File.filename` — switching to `File.path` is a minimal change.

### File Table — New Column

| Column | DB Type       | Notes                                                                                  |
| ------ | ------------- | -------------------------------------------------------------------------------------- |
| path   | VARCHAR(1024) | Normalized path starting with `/`. Unique within a project: `UNIQUE(projectId, path)`. |

### Migration

1. Add `path` column (nullable) to `files` table.
2. Backfill: `UPDATE files SET path = '/' || filename WHERE path IS NULL`.
3. Add unique composite index on `(projectId, path)`.
4. Make `path` NOT NULL.

## REST API Changes

### Create Document — `POST /api/v1/documents`

Add optional `path` field to request body:

```json
{
  "project_id": "proj_ABC",
  "filename": "intro.txt",
  "path": "/knowledge-base/bitcoin/intro.txt",
  "content": "Bitcoin is a..."
}
```

If `path` is omitted, default to `/<filename>`.

### Create File — `POST /api/v1/files`

Same: add optional `path` field.

### Update Document — `PATCH /api/v1/documents/:id`

Allow updating `path` (move a document to a new location):

```json
{
  "path": "/archive/bitcoin/intro.txt"
}
```

### Document Responses

Add `path` to all document response bodies:

```json
{
  "id": "doc_ABC",
  "path": "/knowledge-base/bitcoin/intro.txt",
  "filename": "intro.txt",
  "project_id": "proj_ABC",
  "...": "..."
}
```

### File Responses

Add `path` to all file response bodies.

### Document Search — `POST /api/v1/documents/search`

The `paths` filter in the search config switches from `File.filename LIKE` to `File.path LIKE`:

```json
{
  "paths": ["/knowledge-base/"],
  "search": "bitcoin"
}
```

No API change — the field name and semantics remain the same. The backing query changes from `filename LIKE` to `path LIKE`.

## Permission Evaluation Changes

### Current Flow

```
1. Build SRN: soat:proj_ABC:document:doc_123
2. Evaluate policies against this SRN
```

### New Flow

```
1. Build SRN by ID:   soat:proj_ABC:document:doc_123
2. Build SRN by path: soat:proj_ABC:document:/knowledge-base/bitcoin/intro.txt
3. Evaluate policies against BOTH SRNs
   → If ANY resource pattern in ANY matching statement matches EITHER SRN, the statement applies
```

This is implemented by changing `statementMatches` (or adding a helper) to accept multiple SRN values for a single resource check:

```ts
export const statementMatchesMultiResource = (args: {
  statement: Statement;
  action: string;
  resources: string[]; // [idSrn, pathSrn]
  context: Record<string, string>;
}): boolean => {
  // ... action check, condition check (same as before)
  const patterns = statement.resource ?? ['*'];
  return args.resources.some((res) =>
    patterns.some((pattern) => matchesPattern({ pattern, value: res }))
  );
};
```

### Boundary Policy Changes (`documentQuery.ts`)

`applyBoundaryFilter` currently builds an SRN from `doc.id`. It must also build a path SRN:

```ts
const idSrn = buildSrn({
  projectPublicId,
  resourceType: 'document',
  resourceId: doc.id,
});
const pathSrn = buildSrn({
  projectPublicId,
  resourceType: 'document',
  resourceId: doc.path ?? doc.id,
});
// Evaluate against both
```

## Impact on Memories Module

The Memory module's `paths` config filter is **not** a permission mechanism — it's a query filter. It narrows results within the caller's permitted document set. With this PRD:

- Memory `config.paths` queries `File.path` instead of `File.filename`.
- Agent boundary policies can now use path-based SRNs to restrict which documents a memory can return.
- These are orthogonal — `config.paths` is data filtering, boundary `resource` is access control.

## Implementation Checklist

### Phase 1: Document Path

- [ ] **DB Model**: Add `path` column to `File` model in `packages/postgresdb/src/models/File.ts`
- [ ] **DB Sync**: Run migration to add column, backfill, add unique index
- [ ] **Documents lib**: Update `createDocument` to accept and store `path`; default to `/<filename>`
- [ ] **Files lib**: Update `createFile` to accept and store `path`
- [ ] **Document mapper**: Add `path` to `mapDocument` output in `documentQuery.ts`
- [ ] **Document query**: Change `paths` filter from `File.filename LIKE` to `File.path LIKE`
- [ ] **REST routes**: Add `path` to create/update/response schemas for documents and files
- [ ] **OpenAPI specs**: Add `path` field to documents.yaml and files.yaml
- [ ] **MCP tools**: Add `path` to document tool schemas
- [ ] **Docs**: Update `packages/website/docs/modules/documents.md` and `files.md`
- [ ] **Tests**: Update document tests to use `path`; test path uniqueness, normalization, defaults

### Phase 2: Path-Based SRN

- [ ] **IAM module**: Update `isValidSrnPattern` docs/comments to explicitly note path support
- [ ] **IAM module**: Add `buildPathSrn` helper (or extend `buildSrn` to accept path)
- [ ] **IAM module**: Add multi-resource evaluation (id SRN + path SRN)
- [ ] **REST routes**: Update document permission checks to pass both id and path SRNs
- [ ] **Document query**: Update `applyBoundaryFilter` to evaluate both id and path SRNs
- [ ] **Policy validation**: Update `validatePolicyDocument` error message to mention path format
- [ ] **Docs**: Update IAM docs with path-based SRN examples
- [ ] **Tests**: Add tests for path-based SRN matching, Deny on path subtree, mixed id/path policies

### Phase 3: Integration

- [ ] **Memory module**: Ensure memory `paths` config uses `File.path` (coordinate with memories PRD)
- [ ] **Agent boundary**: Add examples and tests for path-scoped agent boundaries
- [ ] **Smoke tests**: Add path-based permission scenarios to `tests/smoke-tests.sh`

## Path Normalization Rules

A `normalizePath` utility function ensures consistent path format:

| Input                                  | Normalized                          | Rule                     |
| -------------------------------------- | ----------------------------------- | ------------------------ |
| `knowledge-base/bitcoin/intro.txt`     | `/knowledge-base/bitcoin/intro.txt` | Prepend `/` if missing   |
| `/knowledge-base/bitcoin/intro.txt`    | `/knowledge-base/bitcoin/intro.txt` | Already valid            |
| `/knowledge-base//bitcoin///intro.txt` | `/knowledge-base/bitcoin/intro.txt` | Collapse consecutive `/` |
| `/knowledge-base/bitcoin/intro.txt/`   | `/knowledge-base/bitcoin/intro.txt` | Remove trailing `/`      |
| `  /foo/bar.txt  `                     | `/foo/bar.txt`                      | Trim whitespace          |
| `/a/../b/file.txt`                     | `/b/file.txt`                       | Resolve `..`             |
| `/a/./b/file.txt`                      | `/a/b/file.txt`                     | Resolve `.`              |

## Security Considerations

- **Path traversal**: `normalizePath` must resolve `..` and `.` to prevent escaping the namespace. Reject paths that resolve above `/`.
- **Injection**: Paths are used in SQL `LIKE` queries. The `%` and `_` characters in paths must be escaped before use in `LIKE` clauses. Use parameterized queries (already in place via Sequelize `Op.like`).
- **Deny precedence**: Explicit Deny on a path subtree always wins, preventing privilege escalation via Allow rules on child paths. This is already implemented in `evaluatePolicies`.

## Examples: Full Policy Scenarios

### Scenario 1: Department-Scoped Access

Marketing team can only access marketing documents:

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:*"],
      "resource": ["soat:proj_ABC:document:/marketing/*"]
    }
  ]
}
```

### Scenario 2: Read-Everything, Write-Only-Own-Folder

```json
{
  "statement": [
    {
      "effect": "Allow",
      "action": [
        "documents:GetDocument",
        "documents:ListDocuments",
        "documents:SearchDocuments"
      ],
      "resource": ["soat:proj_ABC:document:*"]
    },
    {
      "effect": "Allow",
      "action": [
        "documents:CreateDocument",
        "documents:UpdateDocument",
        "documents:DeleteDocument"
      ],
      "resource": ["soat:proj_ABC:document:/team-alice/*"]
    }
  ]
}
```

### Scenario 3: Agent Boundary — RAG Only on Knowledge Base

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

Combined with a memory config:

```json
{
  "name": "KB Search",
  "config": {
    "search": "user query",
    "paths": ["/knowledge-base/"],
    "limit": 10
  }
}
```

The boundary policy is the **hard limit**; the memory config is a **soft filter** within that limit.
