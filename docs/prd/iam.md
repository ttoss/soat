# PRD: Identity and Access Management (IAM)

## Context

Soat's current authorization system uses flat permission lists (`permissions` / `notPermissions`) on project policies. These lists support only **action-level** checks — e.g., allowing `files:GetFile` or denying `documents:*`. This is insufficient for real-world multi-tenant scenarios:

| Limitation                         | Example                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| No resource-level targeting        | Cannot grant access to a specific document (`doc_XYZ`) only       |
| No tag/attribute-based conditions  | Cannot allow agents tagged `"internal"` while denying `"public"`  |
| No explicit deny on specific items | Cannot deny a user access to one secret while allowing all others |
| Single policy per membership       | A user gets exactly one policy per project — no composition       |

This PRD introduces an **AWS IAM-inspired policy engine** that replaces the current flat-list model with structured policy statements supporting `Effect`, `Action`, `Resource`, and `Condition`.

### Goals

1. **Resource-level permissions** — grant or deny access to individual resources (a specific document, file, secret, etc.)
2. **Condition-based access control** — support tag-based conditions (e.g., only agents with tag `internal`)
3. **Explicit deny** — deny always wins over allow, enabling blocklists
4. **Policy composition** — attach multiple policies to a user/API key; the engine merges them
5. **Backward compatibility** — existing `permissions`/`notPermissions` arrays continue to work during migration

### Non-goals

- Federated identity (SSO, SAML, OIDC) — out of scope for v1
- Cross-account/cross-project trust policies
- Policy versioning or rollback
- Real-time policy simulation API (future iteration)

---

## Concepts

### Policy Document

A **policy document** is a JSON object containing one or more **statements**. Each statement describes a permission rule. This is the core primitive — everything else (attaching to users, API keys, projects) is about where the document lives.

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:GetDocument", "documents:ListDocuments"],
      "resource": ["soat:proj_ABC:document:doc_XYZ"]
    },
    {
      "effect": "Deny",
      "action": ["secrets:*"],
      "resource": ["soat:proj_ABC:secret:sec_PROD_KEY"]
    }
  ]
}
```

### Statement

A single permission rule within a policy document.

| Field       | Type       | Required | Description                                             |
| ----------- | ---------- | -------- | ------------------------------------------------------- |
| `effect`    | `string`   | Yes      | `"Allow"` or `"Deny"`                                   |
| `action`    | `string[]` | Yes      | Actions this statement applies to (supports wildcards)  |
| `resource`  | `string[]` | No       | SRNs this statement applies to (default: `["*"]`)       |
| `condition` | `object`   | No       | Conditions that must be true for the statement to apply |

### Soat Resource Name (SRN)

Every addressable entity in Soat has a canonical identifier called a **Soat Resource Name (SRN)**. Format:

```
soat:<projectId>:<resourceType>:<resourceId>
```

Examples:

```
soat:proj_ABC:document:doc_XYZ          # specific document
soat:proj_ABC:document:*                # all documents in project
soat:proj_ABC:secret:sec_PROD           # specific secret
soat:proj_ABC:file:*                    # all files in project
soat:proj_ABC:actor:act_123             # specific actor
soat:proj_ABC:conversation:conv_789     # specific conversation
soat:proj_ABC:ai-provider:aip_456      # specific AI provider
soat:*:*:*                              # everything (admin-level)
```

Wildcards (`*`) are supported at any segment. The resource type maps directly to module names.

**Resource types:**

| Resource type  | Public ID prefix | Module        |
| -------------- | ---------------- | ------------- |
| `document`     | `doc_`           | Documents     |
| `file`         | `file_`          | Files         |
| `secret`       | `sec_`           | Secrets       |
| `actor`        | `act_`           | Actors        |
| `conversation` | `conv_`          | Conversations |
| `ai-provider`  | `aip_`           | AI Providers  |
| `project`      | `proj_`          | Projects      |
| `policy`       | `pol_`           | Policies      |
| `api-key`      | `key_`           | API Keys      |

### Actions

Actions follow the existing `module:Operation` pattern:

```
documents:GetDocument
documents:ListDocuments
documents:CreateDocument
documents:UpdateDocument
documents:DeleteDocument
documents:SearchDocuments
files:GetFile
files:CreateFile
files:DeleteFile
files:UploadFile
files:DownloadFile
files:UpdateFileMetadata
secrets:GetSecret
secrets:ListSecrets
secrets:CreateSecret
secrets:UpdateSecret
secrets:DeleteSecret
actors:ListActors
actors:GetActor
actors:CreateActor
actors:UpdateActor
actors:DeleteActor
conversations:ListConversations
conversations:GetConversation
conversations:CreateConversation
conversations:UpdateConversation
conversations:DeleteConversation
projects:GetProject
chats:CreateCompletion
agents:RunAgent
```

Wildcards: `documents:*` matches all document actions. `*` matches everything.

### Conditions

Conditions add attribute-based constraints. Each condition key is a **condition operator**, and its value is an object mapping **condition keys** to expected values.

```json
{
  "condition": {
    "StringEquals": {
      "soat:ResourceTag/environment": "production"
    },
    "StringLike": {
      "soat:ResourceTag/team": "engineering-*"
    }
  }
}
```

**Condition operators (v1):**

| Operator          | Description                   |
| ----------------- | ----------------------------- |
| `StringEquals`    | Exact string match            |
| `StringNotEquals` | Negated exact match           |
| `StringLike`      | Glob pattern match (`*`, `?`) |

**Condition keys (v1):**

| Key                      | Source        | Description                             |
| ------------------------ | ------------- | --------------------------------------- |
| `soat:ResourceTag/<key>` | Resource tags | Tag value on the target resource        |
| `soat:ResourceType`      | Request       | The type of the resource being accessed |

> **Future condition keys**: `soat:CurrentTime`, `soat:SourceIp`, `soat:RequestedModel`, `soat:TokenCost`, etc.

### Tags

Tags are key-value pairs attached to resources. They enable attribute-based access control (ABAC) via conditions. Any taggable resource (documents, files, actors, secrets, AI providers, conversations) can have tags.

```json
{
  "tags": {
    "environment": "production",
    "team": "engineering",
    "sensitivity": "high"
  }
}
```

Tags are stored as a JSONB column on each taggable model.

---

## Policy Evaluation Logic

Policy evaluation follows **AWS IAM semantics**:

1. **Default deny** — if no statement matches, access is denied
2. **Explicit deny wins** — if any policy statement explicitly denies, access is denied regardless of allows
3. **Allow** — if at least one statement allows and no statement denies, access is granted

```
function evaluate(policies, action, resource, context):
    decision = DENY  (default)

    for each policy in policies:
        for each statement in policy.statements:
            if statement matches (action, resource, context):
                if statement.effect == "Deny":
                    return DENY  (explicit deny, short-circuit)
                if statement.effect == "Allow":
                    decision = ALLOW

    return decision
```

### Statement matching

A statement matches a request when **all** of the following are true:

1. At least one pattern in `action` matches the requested action
2. At least one pattern in `resource` matches the target SRN (or `resource` is omitted / `["*"]`)
3. All `condition` blocks evaluate to true (or `condition` is omitted)

### Pattern matching

- `*` matches everything
- `module:*` matches all actions in a module
- `soat:proj_ABC:document:*` matches all documents in project `proj_ABC`
- Wildcards only at segment boundaries (no partial wildcards like `doc_X*`)

---

## Data Model

### `PolicyDocument` (new model)

Replaces the current `ProjectPolicy` model. A policy document contains the full IAM policy JSON and is scoped to a project.

- `publicId` — `pol_` prefix (reuses existing prefix)
- `projectId` — FK to `Project`
- `name` — human-readable label (e.g., "Read-only Documents", "Full Access")
- `description` — optional description of what this policy grants
- `document` — JSONB; the policy document (version + statement array)
- `createdAt`, `updatedAt`

```sql
CREATE TABLE policy_documents (
  id            SERIAL PRIMARY KEY,
  public_id     VARCHAR(32) UNIQUE NOT NULL,
  project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          VARCHAR(255) NOT NULL,
  description   TEXT,
  document      JSONB NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);
```

### `UserProject` (updated)

The existing `UserProject` model gains support for **multiple policies**. Instead of a single `policyId` FK, it references a join table or an array of policy IDs.

**Option chosen: array column** (simpler than a join table for v1):

- `policyIds` — `INTEGER[]`; replaces the single `policyId` column

During evaluation, all attached policies are loaded and merged using the evaluation logic above.

### Tags on existing models

Add a `tags` JSONB column to all taggable models:

- `Document`: `tags JSONB DEFAULT '{}'`
- `File`: `tags JSONB DEFAULT '{}'`
- `Actor`: `tags JSONB DEFAULT '{}'`
- `Secret` (when added): `tags JSONB DEFAULT '{}'`
- `AiProvider` (when added): `tags JSONB DEFAULT '{}'`
- `Conversation`: `tags JSONB DEFAULT '{}'`

---

## API

### Policy Documents

```
POST   /v1/projects/{projectId}/policies         Create a policy document
GET    /v1/projects/{projectId}/policies         List policy documents
GET    /v1/projects/{projectId}/policies/{id}    Get a policy document
PUT    /v1/projects/{projectId}/policies/{id}    Update a policy document
DELETE /v1/projects/{projectId}/policies/{id}    Delete a policy document
```

#### `POST /v1/projects/{projectId}/policies`

```json
{
  "name": "Document Readers",
  "description": "Read-only access to all documents",
  "document": {
    "version": "2025-01-01",
    "statement": [
      {
        "effect": "Allow",
        "action": [
          "documents:GetDocument",
          "documents:ListDocuments",
          "documents:SearchDocuments"
        ],
        "resource": ["soat:proj_ABC:document:*"]
      }
    ]
  }
}
```

Response (`201`):

```json
{
  "id": "pol_V1StGXR8Z5jdHi6B",
  "name": "Document Readers",
  "description": "Read-only access to all documents",
  "document": { "..." },
  "projectId": "proj_ABC",
  "createdAt": "2025-01-15T10:00:00Z",
  "updatedAt": "2025-01-15T10:00:00Z"
}
```

#### `PUT /v1/projects/{projectId}/policies/{id}`

Full replacement of the policy document. Partial updates are not supported — send the complete document.

### Project Members (updated)

```
POST /v1/projects/{projectId}/members                           Add user with policies
PUT  /v1/projects/{projectId}/members/{userId}/policies         Set policies for a member
GET  /v1/projects/{projectId}/members/{userId}/policies         Get policies for a member
```

#### `POST /v1/projects/{projectId}/members`

```json
{
  "userId": "usr_V1StGXR8Z5jdHi6B",
  "policyIds": ["pol_AAAA", "pol_BBBB"]
}
```

#### `PUT /v1/projects/{projectId}/members/{userId}/policies`

```json
{
  "policyIds": ["pol_AAAA", "pol_BBBB", "pol_CCCC"]
}
```

### Tags

Tags are managed via the existing resource endpoints. Each `POST`, `PATCH`, and `PUT` for taggable resources accepts an optional `tags` field:

```json
{
  "name": "Q4 Report",
  "tags": {
    "department": "finance",
    "sensitivity": "confidential"
  }
}
```

Tags can also be managed with dedicated sub-endpoints:

```
PUT    /v1/documents/{id}/tags      Replace all tags on a document
PATCH  /v1/documents/{id}/tags      Merge tags (add/update keys, keep others)
GET    /v1/documents/{id}/tags      Get tags for a document
```

The same pattern applies to all taggable resources (`files`, `actors`, `secrets`, `ai-providers`, `conversations`).

---

## Examples

### 1. Grant read access to a specific document

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["documents:GetDocument"],
      "resource": ["soat:proj_ABC:document:doc_REPORT"]
    }
  ]
}
```

### 2. Allow all file operations except delete

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["files:*"],
      "resource": ["soat:proj_ABC:file:*"]
    },
    {
      "effect": "Deny",
      "action": ["files:DeleteFile"],
      "resource": ["soat:proj_ABC:file:*"]
    }
  ]
}
```

### 3. Allow agents tagged "internal" only

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["agents:RunAgent"],
      "resource": ["soat:proj_ABC:actor:*"],
      "condition": {
        "StringEquals": {
          "soat:ResourceTag/visibility": "internal"
        }
      }
    }
  ]
}
```

### 4. Deny access to a specific secret

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["secrets:*"],
      "resource": ["soat:proj_ABC:secret:*"]
    },
    {
      "effect": "Deny",
      "action": ["secrets:GetSecret"],
      "resource": ["soat:proj_ABC:secret:sec_PROD_KEY"]
    }
  ]
}
```

### 5. Full admin policy (equivalent to current `*` permission)

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": ["*"],
      "resource": ["*"]
    }
  ]
}
```

### 6. Read-only across all modules

```json
{
  "version": "2025-01-01",
  "statement": [
    {
      "effect": "Allow",
      "action": [
        "documents:GetDocument",
        "documents:ListDocuments",
        "documents:SearchDocuments",
        "files:GetFile",
        "files:DownloadFile",
        "secrets:ListSecrets",
        "secrets:GetSecret",
        "actors:ListActors",
        "actors:GetActor",
        "conversations:ListConversations",
        "conversations:GetConversation",
        "projects:GetProject"
      ],
      "resource": ["*"]
    }
  ]
}
```

---

## Migration from Current System

The current `ProjectPolicy` model stores flat arrays:

```json
{
  "permissions": ["files:*", "documents:GetDocument"],
  "notPermissions": ["secrets:DeleteSecret"]
}
```

### Migration strategy

1. **Dual-mode evaluation**: the policy engine checks if a `PolicyDocument` has a `document` field (new format) or `permissions`/`notPermissions` (legacy format). Both are supported simultaneously.

2. **Automatic conversion**: an admin endpoint or CLI command converts legacy policies to the new format:

   ```json
   {
     "version": "2025-01-01",
     "statement": [
       {
         "effect": "Allow",
         "action": ["files:*", "documents:GetDocument"],
         "resource": ["*"]
       },
       {
         "effect": "Deny",
         "action": ["secrets:DeleteSecret"],
         "resource": ["*"]
       }
     ]
   }
   ```

3. **Deprecation**: after migration, the `permissions` and `notPermissions` columns are removed.

### `isAllowed` signature change

Current:

```typescript
isAllowed(projectPublicId: string, action: string): Promise<boolean>
```

New:

```typescript
isAllowed(args: {
  projectPublicId: string;
  action: string;
  resource?: string;    // SRN of the target resource
  context?: Record<string, string>;  // condition context (e.g., tags)
}): Promise<boolean>
```

The new signature is backward-compatible: if `resource` and `context` are omitted, it behaves like the current system (action-only check with `resource = "*"`).

---

## Implementation Notes

### File locations

| Component            | Path                                                 |
| -------------------- | ---------------------------------------------------- |
| PolicyDocument model | `packages/postgresdb/src/models/PolicyDocument.ts`   |
| Policy engine        | `packages/server/src/lib/permissions.ts` (extend)    |
| REST routes          | `packages/server/src/rest/v1/projects.ts` (update)   |
| MCP tools            | `packages/server/src/mcp/tools/projects.ts` (update) |
| Auth middleware      | `packages/server/src/middleware/auth.ts` (update)    |
| Tests                | `packages/server/tests/unit/tests/projects.test.ts`  |
| Docs                 | `packages/website/docs/modules/iam.md`               |

### Policy document validation

The server must validate policy documents on create/update:

- `version` must be a recognized version string
- Each statement must have `effect` ∈ `{"Allow", "Deny"}`
- `action` must be a non-empty array of strings matching `module:Operation` or wildcard patterns
- `resource`, if present, must be valid SRN patterns
- `condition` operators must be from the supported set
- Condition keys must be from the recognized set

Invalid documents are rejected with `400 Bad Request` and a descriptive error.

### Performance considerations

- **Policy caching**: resolved policies for a user+project pair should be cached in memory for the duration of a request (already the case in the auth middleware)
- **Tag loading**: when conditions reference `soat:ResourceTag/*`, tags must be loaded for the target resource. This adds one query per authorization check that uses tag conditions. Use eager loading where possible.
- **Index on tags**: add a GIN index on the `tags` JSONB column for efficient queries

### SRN construction

Each module's lib layer constructs the SRN from the resource being accessed:

```typescript
// Example in documents.ts
const srn = `soat:${projectPublicId}:document:${document.publicId}`;
```

The auth middleware passes this SRN to the policy engine.

### Public ID prefix

Reuses `pol_` for policy documents (same concept, upgraded model).
