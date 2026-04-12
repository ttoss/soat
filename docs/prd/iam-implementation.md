# IAM Implementation Plan

Step-by-step implementation of the IAM system defined in [iam.md](./iam.md). Each step is self-contained, testable, and builds on the previous one.

---

## Step 1: Define TypeScript Types and Validation

**Goal**: Create the core type definitions and a validation function for the new policy document format.

**Files to create/modify**:

- Create `packages/server/src/lib/iam.ts`

**What to do**:

1. Define `PolicyDocument`, `Statement`, `Condition`, and `SRN` types:

   ```ts
   type Effect = 'Allow' | 'Deny';

   type ConditionOperator = 'StringEquals' | 'StringNotEquals' | 'StringLike';

   type Condition = {
     [operator in ConditionOperator]?: Record<string, string>;
   };

   type Statement = {
     effect: Effect;
     action: string[];
     resource?: string[];
     condition?: Condition;
   };

   type PolicyDocument = {
     statement: Statement[];
   };
   ```

2. Write `validatePolicyDocument(doc: unknown): { valid: boolean; errors: string[] }`:
   - Each statement must have `effect` ∈ `{"Allow", "Deny"}`
   - `action` must be a non-empty `string[]` where each entry matches `module:Operation` or `*` or `module:*`
   - `resource`, if present, must be a non-empty `string[]` of valid SRN patterns
   - `condition` operators must be from `{StringEquals, StringNotEquals, StringLike}`
   - Condition keys must start with `soat:`

3. Write `buildSrn(args: { projectPublicId: string; resourceType: string; resourceId: string }): string` that returns `soat:<projectPublicId>:<resourceType>:<resourceId>`.

**Tests**: Add `packages/server/tests/unit/tests/iam.test.ts` with:

- Valid document passes validation
- Invalid `effect` fails
- Empty `action` array fails
- Invalid SRN format fails
- Invalid condition operator fails
- `buildSrn` produces correct SRN strings

**Run**:

```bash
pnpm --filter @soat/server test --testPathPatterns=iam.test.ts
```

---

## Step 2: Implement the Policy Evaluation Engine

**Goal**: Build the core `evaluate` function that takes policies, an action, a resource SRN, and context — then returns Allow or Deny.

**Files to modify**:

- `packages/server/src/lib/iam.ts` (extend from Step 1)

**What to do**:

1. Write `matchesPattern(args: { pattern: string; value: string }): boolean`:
   - `*` matches everything
   - `module:*` matches all actions in `module:`
   - `soat:proj_ABC:document:*` matches all documents in `proj_ABC`
   - Exact match for non-wildcard patterns

2. Write `evaluateCondition(args: { condition: Condition; context: Record<string, string> }): boolean`:
   - `StringEquals`: every key-value in the operator block must match exactly in context
   - `StringNotEquals`: every key-value must NOT match
   - `StringLike`: glob pattern match (`*` = any chars, `?` = single char)
   - All operator blocks must pass (AND logic)

3. Write `statementMatches(args: { statement: Statement; action: string; resource: string; context: Record<string, string> }): boolean`:
   - At least one `action` pattern matches the requested action
   - At least one `resource` pattern matches the target SRN (or resource is `["*"]` / omitted)
   - All conditions pass (or no conditions)

4. Write `evaluatePolicies(args: { policies: PolicyDocument[]; action: string; resource?: string; context?: Record<string, string> }): boolean`:
   - Default `resource` to `*` if omitted
   - Default `context` to `{}` if omitted
   - Loop through all policies and all statements
   - If any matching statement has `effect: "Deny"` → return `false` (explicit deny, short-circuit)
   - If any matching statement has `effect: "Allow"` → mark allowed
   - Return the allowed flag (default `false`)

**Tests**: Extend `iam.test.ts`:

- Action-only policy (no resource/condition) allows matching action
- Action-only policy denies non-matching action
- Wildcard `*` allows everything
- `module:*` matches all actions in module
- Resource-specific policy allows matching SRN
- Resource-specific policy denies different SRN
- Resource wildcard `soat:proj_ABC:document:*` matches specific doc
- Explicit deny overrides allow
- Multiple policies: allow from one + deny from another = deny
- Multiple policies: allow from one + no match from another = allow
- Condition `StringEquals` matches
- Condition `StringEquals` does not match
- Condition `StringNotEquals` works
- Condition `StringLike` with glob patterns
- No matching statements → default deny
- Omitted `resource` defaults to `["*"]`

**Run**:

```bash
pnpm --filter @soat/server test --testPathPatterns=iam.test.ts
```

---

## Step 3: Update the Database Models

**Goal**: Replace `ProjectPolicy` flat permission columns with IAM document support and add `tags` to taggable models.

**Files to modify**:

- `packages/postgresdb/src/models/ProjectPolicy.ts`
- `packages/postgresdb/src/models/UserProject.ts`
- `packages/postgresdb/src/models/Document.ts`
- `packages/postgresdb/src/models/File.ts`
- `packages/postgresdb/src/models/Actor.ts`
- `packages/postgresdb/src/models/Conversation.ts`

**What to do**:

### 3a. Replace `ProjectPolicy` Columns

Remove the existing `permissions` and `notPermissions` columns. Replace with:

```ts
@Column({ type: DataType.STRING(255), allowNull: true })
declare name: string | null;

@Column({ type: DataType.TEXT, allowNull: true })
declare description: string | null;

@Column({ type: DataType.JSONB, allowNull: false })
declare document: object;  // PolicyDocument JSON
```

The `document` column stores a validated `PolicyDocument` and is now required for all policies.

### 3b. Update `UserProject` for Multiple Policies

Replace the single `policyId` FK with an array:

```ts
@Column({
  type: DataType.ARRAY(DataType.INTEGER),
  allowNull: false,
  defaultValue: [],
})
declare policyIds: number[];
```

Remove the `@ForeignKey` and `@BelongsTo` for the single policy relationship.

> **Note**: Since the project is not shipped yet, drop and recreate the dev DB after these schema changes.

### 3c. Add `tags` to Taggable Models

Add to `Document`, `File`, `Actor`, and `Conversation`:

```ts
@Column({
  type: DataType.JSONB,
  allowNull: true,
  defaultValue: {},
})
declare tags: Record<string, string> | null;
```

> **Note on Document model**: The existing `tags` column on Document is `DataType.ARRAY(DataType.TEXT)`. This changes to `DataType.JSONB` (key-value instead of array). Drop and recreate the dev DB to apply this type change.

### 3d. Rebuild

```bash
pnpm --filter @soat/postgresdb build
```

**Tests**: Run existing tests to verify nothing breaks:

```bash
pnpm --filter @soat/server test
```

---

## Step 4: Update the Permission Functions (`permissions.ts`)

**Goal**: Replace the permission evaluation to use the new IAM engine.

**Files to modify**:

- `packages/server/src/lib/permissions.ts`

**What to do**:

1. Import `evaluatePolicies`, `validatePolicyDocument`, and `PolicyDocument` from `./iam`.

2. Replace `policyAllows` to use the new format:

   ```ts
   export const policyAllows = (args: {
     policy: { document: object };
     action: string;
     resource?: string;
     context?: Record<string, string>;
   }): boolean => {
     return evaluatePolicies({
       policies: [args.policy.document as PolicyDocument],
       action: args.action,
       resource: args.resource,
       context: args.context,
     });
   };
   ```

3. Update `createJwtIsAllowed` and `createApiKeyIsAllowed`:
   - Load **all** policies from the `policyIds` array on UserProject (instead of a single `policyId`)
   - Extract the `document` from each policy
   - Call `evaluatePolicies` with the full array

**Tests**: Extend `iam.test.ts`:

- `policyAllows` works with IAM document
- Multiple policies evaluated together

**Run**:

```bash
pnpm --filter @soat/server test --testPathPatterns=iam.test.ts
```

---

## Step 5: Update `isAllowed` Signature and Auth Middleware

**Goal**: Extend `isAllowed` to accept optional `resource` and `context` parameters. Update the auth middleware to load multiple policies and pass tags as context.

**Files to modify**:

- `packages/server/src/Context.ts`
- `packages/server/src/middleware/auth.ts`

**What to do**:

### 5a. Update `Context.ts`

Change the `isAllowed` signature on `AuthUser`:

```ts
isAllowed: (args: {
  projectPublicId: string;
  action: string;
  resource?: string;
  context?: Record<string, string>;
}) => Promise<boolean>;
```

### 5b. Update `auth.ts`

**`resolveJwt`**:

Update `createJwtIsAllowed` call:

1. Load all policies for the user's membership by looking up `policyIds` array from `UserProject`, then fetching all matching `ProjectPolicy` rows.
2. Pass the array of policy documents to the evaluation.
3. Support the new `resource` and `context` args.

**`resolveApiKey`**:

Same approach — load the API key's policy AND the user's project policies, evaluate with intersection logic:

- Action must be allowed by user policies AND API key policy.
- Resource and context are checked in both.

### 5c. Update All `isAllowed` Call Sites

Since the signature changes from `(projectPublicId, action)` to `({ projectPublicId, action, resource?, context? })`, every call site in the REST handlers must be updated. Search for `isAllowed(` across `packages/server/src/rest/` and update to the object form:

```ts
// Before
await ctx.authUser.isAllowed(projectId, 'documents:GetDocument');

// After
await ctx.authUser.isAllowed({
  projectPublicId: projectId,
  action: 'documents:GetDocument',
});
```

At this point, no call sites need to pass `resource` or `context` yet — those will be added per-module in Step 7.

**Tests**: Run full test suite to verify everything works:

```bash
pnpm --filter @soat/server test
```

---

## Step 6: Update Policy REST Endpoints

**Goal**: Update the policy CRUD endpoints to accept the new IAM document format.

**Files to modify**:

- `packages/server/src/lib/projects.ts`
- `packages/server/src/rest/v1/projects.ts`
- `packages/server/src/rest/openapi/v1/projects.yaml` (if it exists)

**What to do**:

### 6a. Update `createProjectPolicy` in `lib/projects.ts`

Accept either legacy or new format:

```ts
export const createProjectPolicy = async (args: {
  projectId: string;
  name?: string;
  description?: string;
  document: PolicyDocument;
}) => { ... };
```

- Validate the document with `validatePolicyDocument`. Return 400 on invalid.

### 6b. Update `POST /projects/:projectId/policies`

Accept the new request body shape:

```json
{
  "name": "Document Readers",
  "description": "Read-only access to documents",
  "document": { "statement": [...] }
}
```

### 6c. Add `PUT /projects/:projectId/policies/:policyId`

Full replacement of a policy document. Validate the new document before saving.

### 6d. Add `DELETE /projects/:projectId/policies/:policyId`

Delete a policy. Must check that no UserProject references it before deleting (or cascade).

### 6e. Update Member Endpoints

Update `POST /projects/:projectId/members` to accept `policyIds: string[]` (array of policy public IDs) instead of a single `policyId`.

Add `PUT /projects/:projectId/members/:userId/policies` to update a member's attached policies.

Add `GET /projects/:projectId/members/:userId/policies` to list a member's attached policies.

### 6f. Update Response Shapes

Policy responses should include `name`, `description`, and `document` when present:

```json
{
  "id": "pol_...",
  "name": "Document Readers",
  "description": "Read-only access to documents",
  "document": { "statement": [...] },
  "projectId": "proj_...",
  "createdAt": "...",
  "updatedAt": "..."
}
```

**Tests**: Add to `projects.test.ts`:

- Create policy with IAM document format
- Invalid document returns 400
- Update policy with PUT
- Delete policy
- Add member with multiple `policyIds`
- Update member policies
- Get member policies
- Validation: invalid `effect`, empty `action` array

**Run**:

```bash
pnpm --filter @soat/server test --testPathPatterns=projects.test.ts
```

---

## Step 7: Add Resource-Level and Tag-Based Checks to Modules

**Goal**: Pass `resource` SRN and `context` (tags) to `isAllowed` in modules that benefit from fine-grained access control.

**Files to modify**:

- `packages/server/src/lib/documents.ts`
- `packages/server/src/lib/files.ts`
- `packages/server/src/lib/actors.ts`
- `packages/server/src/lib/conversations.ts`
- `packages/server/src/rest/v1/documents.ts`
- `packages/server/src/rest/v1/files.ts`
- `packages/server/src/rest/v1/actors.ts`
- `packages/server/src/rest/v1/conversations.ts`

**What to do**:

### 7a. Add SRN Construction to Lib Functions

In each module's lib layer, construct the SRN after loading the resource:

```ts
// documents.ts
const srn = buildSrn({
  projectPublicId: project.publicId,
  resourceType: 'document',
  resourceId: document.publicId,
});
```

### 7b. Add Tag Context Loading

When a resource is loaded and it has `tags`, build the condition context:

```ts
const context: Record<string, string> = {};
if (resource.tags) {
  for (const [key, value] of Object.entries(resource.tags)) {
    context[`soat:ResourceTag/${key}`] = value;
  }
}
context['soat:ResourceType'] = 'document';
```

### 7c. Update `isAllowed` Calls in Routes

For single-resource operations (`GET /:id`, `PUT /:id`, `DELETE /:id`):

1. Load the resource from DB
2. Build SRN and context
3. Call `isAllowed({ projectPublicId, action, resource: srn, context })`

For list operations (`GET /`), the policy check stays at the action level (no specific resource). Resources are filtered post-query if needed, or the action-level check is sufficient for v1.

### 7d. Add Tag CRUD Sub-Endpoints

For each taggable module, add:

```
PUT    /v1/documents/:id/tags   — replace all tags
PATCH  /v1/documents/:id/tags   — merge tags
GET    /v1/documents/:id/tags   — get tags
```

The same pattern for `files`, `actors`, `conversations`.

**Tests**: Extend each module's test file:

- Resource-level allow: policy allows `doc_XYZ`, request for `doc_XYZ` passes
- Resource-level deny: policy allows `documents:*` but denies specific `doc_XYZ`, request for `doc_XYZ` blocked
- Tag condition: policy with `StringEquals { "soat:ResourceTag/env": "prod" }`, resource tagged `env=prod` passes, `env=dev` fails
- Tag CRUD: create/update/get tags on a resource

**Run**:

```bash
pnpm --filter @soat/server test
```

---

## Step 8: Update MCP Tools

**Goal**: Expose policy management and tag operations via MCP tools.

**Files to modify**:

- `packages/server/src/mcp/tools/projects.ts`
- `packages/server/src/mcp/tools/index.ts`

**What to do**:

### 8a. Add Policy Management Tools

```
create-policy        POST /projects/{projectId}/policies
list-policies        GET  /projects/{projectId}/policies
get-policy           GET  /projects/{projectId}/policies/{id}
update-policy        PUT  /projects/{projectId}/policies/{id}
delete-policy        DELETE /projects/{projectId}/policies/{id}
```

### 8b. Add Member Policy Tools

```
set-member-policies  PUT /projects/{projectId}/members/{userId}/policies
get-member-policies  GET /projects/{projectId}/members/{userId}/policies
```

### 8c. Add Tag Tools (per module)

For each taggable module, add tools:

```
set-document-tags    PUT  /documents/{id}/tags
get-document-tags    GET  /documents/{id}/tags
```

(Same for files, actors, conversations.)

### 8d. Register in `index.ts`

Import and call `registerTools` for the new/updated tool files.

**Tests**: Manual verification via MCP inspector or integration tests.

---

## Step 9: Documentation

- `packages/website/docs/modules/iam.md`

**What to do**:

1. Write the module doc covering:
   - Overview: what the IAM system does
   - Key concepts: policy documents, statements, SRNs, conditions, tags
   - Policy evaluation rules (default deny, explicit deny wins)
   - How to create and attach policies
   - Tag-based ABAC examples

2. Update `packages/website/sidebars.ts` if needed to include the IAM doc.

---

## Step 10: End-to-End Smoke Test

**Goal**: Verify the full IAM flow works end-to-end.

**Files to modify**:

- `tests/smoke-test.sh`

**What to do**:

Add IAM scenarios to the smoke test:

1. Bootstrap admin + create project
2. Create an IAM policy document (resource-level allow for a specific document)
3. Create a user, add to project with the policy
4. Upload a document, tag it
5. Verify user CAN access the allowed document
6. Verify user CANNOT access a different document
7. Create a deny policy for a specific resource
8. Verify deny overrides allow

**Run**:

```bash
pnpm run -w smoke-test
```

---

## Implementation Order Summary

| Step | Description                        | Depends On | Risk   |
| ---- | ---------------------------------- | ---------- | ------ |
| 1    | Types and validation               | —          | Low    |
| 2    | Policy evaluation engine           | 1          | Low    |
| 3    | Database model changes             | —          | Medium |
| 4    | Update permission functions        | 1, 2, 3    | Medium |
| 5    | Update isAllowed + auth middleware | 4          | High   |
| 6    | Update policy REST endpoints       | 3, 4       | Medium |
| 7    | Resource-level + tag checks        | 5, 6       | Medium |
| 8    | MCP tools                          | 6, 7       | Low    |
| 9    | Documentation                      | All        | Low    |
| 10   | End-to-end smoke test              | All        | Low    |

Steps 1–2 and 3 can be done in parallel. Steps 4–5 are the critical path. Steps 8–10 can be done in any order after their dependencies.

### Estimated Breakdown by Area

- **Policy engine** (Steps 1–2): Pure functions, no side effects, highly testable in isolation
- **Database** (Step 3): Drop and recreate dev DB after schema changes
- **Auth integration** (Steps 4–5): Highest risk — touches every authenticated request
- **REST API** (Steps 6–7): Incremental — add new endpoints, update existing ones
- **MCP + Docs + Smoke test** (Steps 8–10): Low risk, mostly additive
