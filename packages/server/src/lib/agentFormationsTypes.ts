// ── Template Types ────────────────────────────────────────────────────────

export type RefExpression = { ref: string };

export type ParamExpression = { param: string };

export type SubExpression = { sub: string };

export type ParameterDeclaration = {
  type?: string;
  default?: string;
  description?: string;
  no_echo?: boolean;
};

export type ResourceDeclaration = {
  type: string;
  properties: Record<string, unknown>;
  depends_on?: string[];
  metadata?: Record<string, unknown>;
};

export type FormationTemplate = {
  parameters?: Record<string, ParameterDeclaration>;
  resources: Record<string, ResourceDeclaration>;
  outputs?: Record<string, RefExpression | unknown>;
  metadata?: Record<string, unknown>;
};

export type ValidationError = {
  path: string;
  message: string;
};

export type ValidationResult = {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationError[];
};

export type PlanChange = {
  logicalId: string;
  resourceType: string;
  action: 'create' | 'update' | 'delete' | 'no-op';
};

export type PlanResult = {
  changes: PlanChange[];
};

export type FormationEvent = {
  timestamp: string;
  logicalId: string;
  resourceType: string;
  action: string;
  status: 'succeeded' | 'failed';
  physicalResourceId?: string;
  error?: string;
};

// ── Mapped Types ──────────────────────────────────────────────────────────

export type MappedAgentFormationResource = {
  id: string;
  logicalId: string;
  resourceType: string;
  physicalResourceId: string | null;
  status: string;
};

export type MappedAgentFormation = {
  id: string;
  projectId: string;
  name: string;
  template: FormationTemplate | null;
  outputs: Record<string, string> | null;
  status: string;
  metadata: Record<string, unknown> | null;
  resources?: MappedAgentFormationResource[];
  createdAt: Date;
  updatedAt: Date;
};

export type MappedFormationOperation = {
  id: string;
  operationType: string;
  status: string;
  events: FormationEvent[] | null;
  plan: PlanResult | null;
  error: object | null;
  createdAt: Date;
  updatedAt: Date;
};

// ── Supported Resource Types ──────────────────────────────────────────────

export const SUPPORTED_RESOURCE_TYPES = new Set([
  'ai_provider',
  'agent_tool',
  'agent',
  'document',
  'memory',
  'memory_entry',
  'webhook',
]);
