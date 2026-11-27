---
paths:
  - "packages/server/src/middleware/**"
  - "packages/server/src/lib/**"
  - "packages/server/src/rest/v1/**"
  - "packages/postgresdb/src/models/**"
---

# Permissions

Read before adding a credential kind, a resource that acts later, a kind of
durable work, a tool type or a token. Each rule names where it lives and the
test that fails when a new site skips it.

## Authority is grant ∩ caps, computed once

- A request's authority is its grant intersected with every cap, built only by
  `buildAuthority` (`middleware/authority.ts`); checks, list filters, project
  resolution and key creation read that one answer.
  `tests/harness/authorityChokepoint.test.mjs`.
- A new credential kind states its `Grant` and `Cap`s in the credential
  resolvers (`middleware/auth.ts`, `middleware/authTerms.ts`) and hands them
  to `buildAuthority`; never build an `isAllowed` of its own.
  `authorityChokepoint.test.mjs` › no grant or cap is stated outside the
  credential resolvers.
- Absent and empty are stated values: an absent or empty grant allows
  `NOTHING`; an absent cap is `EVERYTHING` (no narrowing).
  `tests/unit/tests/rest/authorityGrantCap.test.ts`.

## A resource that acts later is a carrier

- Register it in `WRITER_RULE_CARRIERS` (`lib/writerRule.ts`), and in
  `POLICY_CARRIERS` (`lib/policyCarriers.ts`) when it names policies. Every
  create and edit goes through `assertWriterHolds`: the writer holds what the
  resource will do. `tests/harness/writerRule.test.mjs`,
  `tests/harness/policyCarriers.test.mjs`.
- A resource whose work runs under its own `policy_ids` starts that work only
  through `resourceWorkAuthority` (`lib/resourceWork.ts`).
  `tests/harness/resourceGrants.test.mjs`.
- A stored secret the server later sends outward asks `secrets:UseSecret`
  through `assertSecretUseAllowed` (`lib/secretUse.ts`).
  `tests/harness/secretUseChokepoint.test.mjs`.

## Durable work stores its authority

- A durable row's `authority` column is a `WorkAuthority`
  (`lib/workAuthority.ts`): `captureAuthority` from the request that starts
  it, written through `storedAuthority`. Add a new durable model to
  `DURABLE_MODELS`. `tests/harness/workAuthority.test.mjs`.
- Work storing none refuses through `requireWorkAuthority`
  (`WORK_AUTHORITY_MISSING`); never fall back to another identity. Work acts
  as a caller only through `workCaller` (`middleware/auth.ts`), which answers
  the same for an authority that no longer resolves.
  `tests/unit/tests/rest/workAuthority.test.ts` › work holding no authority,
  `workAuthority.test.mjs` › work acts as a caller only through workCaller.
- Work calls the API in process with its authority as a value
  (`dispatchApiRequest` → `attachWork`), never a minted token or an
  `Authorization` header. `workAuthority.test.mjs` › only the auth middleware
  reads Authorization.

## Inherited authority only narrows

- Child work stores the authority of the call that starts it, so it is never
  wider than its parent. `tests/unit/tests/rest/agentRunAs.test.ts` › work a
  builtin call starts stores the agent grant.
- A resume runs under `resumedAuthority`: the stored authority ∩ the
  resumer's, and resuming needs a permission on the work itself.
  `tests/unit/tests/rest/toolOutputsCredential.test.ts`,
  `tests/unit/tests/rest/workAuthority.test.ts` › does not borrow the resuming
  admin authority.
- An approved action runs under the authority the proposing work stores; the
  approver's is never used to execute.
  `tests/unit/tests/rest/approvalContinuation.test.ts` › the continuation runs
  under the authority the proposing segment stores.

## One gate for every tool call and content read

- An agent turn's authority is `turnAuthority` (`lib/turnAuthority.ts`);
  every check against it goes through `assertAllowedUnder`. Never evaluate an
  agent's `policy_ids` on their own. `tests/harness/agentTurnGate.test.mjs`.
- Which actions a `builtin` tool may name is the deployment's catalog's one
  answer, `findBuiltinAction` (`lib/builtinActionCatalog.ts`). An added action
  holds its writer to its declared actions (`carriedActionsOfTool`) and
  reaches its server only through `postMcp`, with the runtime's assertion.
  `tests/harness/builtinActionCatalog.test.mjs`,
  `tests/unit/tests/rest/builtinActionCatalog.test.ts`.
- A stored tool's call crosses `gateToolCall` (`lib/toolCallGate.ts`) on both
  surfaces: `tools:CallTool` on the tool, for every type. Every binding
  declares its `gate`. `agentTurnGate.test.mjs`,
  `tests/harness/toolSurfaceGate.test.mjs`.
- Every start in `START_ACTIONS` (`lib/startActions.ts`) is checked at its
  entry point, under the authority the work runs under: `gateToolCall`,
  `gateGenerationStart` (`lib/generationStartGate.ts`) and `gateStart`
  (`lib/startGate.ts`). A caller starting work for someone else never checks
  it again. `tests/harness/startChokepoint.test.mjs`.
- What the caller names in the call (a document or `tool_output` message, a
  `knowledge_config`, an `agent_id`, an actor) is read under
  `callerNamedAuthority`, as the caller. `agentTurnGate.test.mjs` › content an
  agent reads or writes is checked by the gate; `agentRunAs.test.ts` › a
  document the caller names is checked as the caller.

## Admission only refuses

- A declared write asks the deployment's admission service through
  `assertAdmitted` (`lib/admission.ts`), after its authorization allowed it, at
  two chokepoints: `admissionMiddleware` (`middleware/admission.ts`, REST and
  `builtin`) and `defineFormationModule` (create, update). A route authorizing
  outside `isAllowed`/`resolveProjectIds` asks through `admitAuthorized`.
  `tests/harness/admissionChokepoint.test.mjs`.
- A step of internal work (generation, tool call, start) asks through
  `assertWorkAdmitted`, called only by `assertAllowedUnder`; a refusal stops
  the work per kind (`isAdmissionRefusal`).
  `admissionChokepoint.test.mjs`, `tests/unit/tests/rest/admissionWork.test.ts`.
- A refusal or no answer refuses; only `on_unavailable: allow` passes an
  unanswered internal step. `tests/unit/tests/rest/admission.test.ts`.

## Agents, tokens, keys

- An agent's `run_as` (`AGENT_RUN_AS`, `lib/agentRunAs.ts`) states what its
  `policy_ids` are: `caller` (default) caps the caller; `agent` makes them the
  agent's own grant, required (`assertRunAsHasPolicies`).
  `tests/unit/tests/rest/agentRunAs.test.ts`.
- Every JWT is signed by `signToken` with a `typ` from `TOKEN_TYPES`
  (`lib/signedTokens.ts`) and verified by `verifyToken` naming the kinds it
  accepts. `tests/harness/signedTokens.test.mjs`.
- A request narrowed beyond its key's own `policy_ids`
  (`AuthUser.narrowing === 'beyond_key'`) creates or updates no API key: every
  key write goes through `boundKeyPolicyIds` (`lib/apiKeys.ts`,
  `CREDENTIAL_NARROWED`). `tests/unit/tests/rest/apiKeyScopedTokenMint.test.ts`.
