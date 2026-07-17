// ── Template Types ────────────────────────────────────────────────────────

export type RefExpression = { ref: string };

export type RefAttrExpression = { ref_attr: string };

export type ParamExpression = { param: string };

export type SubExpression = { sub: string };

export type ParameterDeclaration = {
  type?: string;
  default?: string;
  description?: string;
  no_echo?: boolean;
  /**
   * When true, omitting this parameter on update reuses its previously stored
   * value instead of failing the required-parameter check — analogous to
   * CloudFormation's UsePreviousValue, but declared in the template. An
   * explicitly supplied value still overrides. Has no effect on create (there
   * is no previous value yet).
   */
  use_previous_value?: boolean;
};

export type ResourceDeclaration = {
  type: string;
  properties: Record<string, unknown>;
  depends_on?: string[];
  metadata?: Record<string, unknown>;
  deletion_policy?: 'delete' | 'retain';
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

export type FormationModule = {
  resourceType: string;
  validateProperties?: (args: {
    properties: unknown;
    basePath: string;
  }) => ValidationError[];
  // Non-fatal checks — e.g. a declared input that no part of the resource
  // config ever reads. Surfaced in `ValidationResult.warnings`, never fails
  // validation.
  warnProperties?: (args: {
    properties: unknown;
    basePath: string;
  }) => ValidationError[];
  create: (args: {
    properties: Record<string, unknown>;
    projectId: number;
  }) => Promise<string>;
  update: (args: {
    properties: Record<string, unknown>;
    physicalResourceId: string;
  }) => Promise<void>;
  delete: (args: { physicalResourceId: string }) => Promise<void>;
  /**
   * Read the current live state of a resource and return its properties in
   * the same snake_case format used by the formation template. Returns null
   * if the resource no longer exists (drift).
   */
  read?: (args: {
    physicalResourceId: string;
  }) => Promise<Record<string, unknown> | null>;
  /**
   * Strip sensitive fields before the resolved properties are persisted in
   * `lastAppliedProperties`. Implement this for resources whose properties
   * contain secrets or other values that must not be stored in plaintext.
   */
  sanitizeLastAppliedProperties?: (
    properties: Record<string, unknown>
  ) => Record<string, unknown>;
  /**
   * True for resources whose live state cannot be read back at all (e.g. a
   * secret's value is encrypted at rest), so `read` always returns null
   * structurally rather than as a "resource deleted externally" signal. When
   * set, the planner diffs the resolved template against the resource's
   * persisted `lastAppliedProperties` snapshot instead of treating the null
   * read as drift.
   */
  writeOnly?: boolean;
  /**
   * Return named attributes for a resource beyond its physical resource ID.
   * Used to resolve `ref_attr` expressions in formation outputs.
   */
  getAttributes?: (args: {
    physicalResourceId: string;
  }) => Promise<Record<string, string>>;
};

export type PlanChange = {
  logicalId: string;
  resourceType: string;
  action: 'create' | 'update' | 'delete' | 'no-op';
  /** The physical resource ID for existing resources (update / no-op / delete). */
  physicalResourceId?: string;
  /**
   * Resolved desired-state properties (post parameter/ref substitution) and,
   * when available, the current live/last-applied properties they are being
   * compared against. Omitted when neither side could be computed (e.g. an
   * unregistered resource type).
   */
  diff?: {
    desired: Record<string, unknown>;
    current: Record<string, unknown> | null;
  };
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

export type MappedFormationResource = {
  id: string;
  logicalId: string;
  resourceType: string;
  physicalResourceId: string | null;
  status: string;
};

export type MappedFormation = {
  id: string;
  projectId: string;
  name: string;
  template: FormationTemplate | null;
  outputs: Record<string, string> | null;
  status: string;
  metadata: Record<string, unknown> | null;
  resources?: MappedFormationResource[];
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
  'tool',
  'agent',
  'actor',
  'api_key',
  'chat',
  'conversation',
  'discussion',
  'document',
  'file',
  'ingestion_rule',
  'memory',
  'memory_entry',
  'orchestration',
  'policy',
  'project_price',
  'secret',
  'session',
  'webhook',
  'trigger',
]);
