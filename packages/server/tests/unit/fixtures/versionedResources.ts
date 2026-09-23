/**
 * Parent resources carrying a config version, mapped to every REST call site
 * whose write must state a precondition against it — a resource may have more
 * than one, so the value is a list.
 *
 * An archive table (`AgentVersion`) carries a `version` too, but it is the
 * archived number rather than a counter anything writes against, and its rows
 * are never updated — so the set below is the parents only, and
 * `writePreconditionContract.test.ts` keeps that distinction from silently
 * absorbing a new parent. `versionedWriteContract.test.ts` drives every write
 * listed here through REST.
 */
export const VERSIONED_RESOURCES: Record<
  string,
  { module: string; update: string }[]
> = {
  'Agent.ts': [{ module: 'agents.ts', update: 'updateAgent' }],
  'Guardrail.ts': [{ module: 'guardrails.ts', update: 'updateGuardrail' }],
  'Orchestration.ts': [
    { module: 'orchestrations.ts', update: 'updateOrchestration' },
  ],
  'Workflow.ts': [{ module: 'workflows.ts', update: 'updateWorkflow' }],
  // A document's config write is `PATCH /documents/{id}`, registered on the
  // documents router; its withdrawal — a config write to a tombstone — is
  // registered from `documentVersionRoutes.ts`. Both claim the same counter.
  'Document.ts': [
    { module: 'documents.ts', update: 'updateDocument' },
    { module: 'documentVersionRoutes.ts', update: 'withdrawDocument' },
  ],
  // A memory has no archived-config table: its counter only separates two
  // writers racing on one memory. Both writes that change one claim it — the
  // update, and the retraction that retires the fact it holds.
  'Memory.ts': [
    { module: 'memories.ts', update: 'updateMemory' },
    { module: 'memories.ts', update: 'retractMemory' },
  ],
};
