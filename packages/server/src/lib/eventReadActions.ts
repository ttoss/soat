import type { SoatResourceType } from './soatEvents';

/**
 * The action that reads the resource an event is about, keyed by the event's
 * resource type. A subscriber acting under its own policies receives an event
 * only when they allow this action on the event's resource, so it never learns
 * of a resource its identity cannot see.
 */
export const EVENT_READ_ACTIONS: Readonly<Record<SoatResourceType, string>> = {
  agent: 'agents:GetAgent',
  approval: 'approvals:GetApproval',
  audit: 'audit:GetAuditEntry',
  conversation: 'conversations:GetConversation',
  conversation_message: 'conversations:GetConversation',
  decision: 'deciders:GetDecision',
  document: 'documents:GetDocument',
  eval_run: 'evaluations:GetEval',
  exception: 'exceptions:GetException',
  file: 'files:GetFile',
  generation: 'generations:GetGeneration',
  guardrail: 'guardrails:GetGuardrail',
  memory: 'memories:GetMemory',
  orchestration_run: 'orchestrations:GetRun',
  project: 'projects:GetProject',
  quota: 'quotas:GetQuota',
  session: 'agents:GetSession',
  task: 'tasks:GetTask',
  trace: 'traces:GetTrace',
  usage_threshold: 'usage:ListThresholds',
};
