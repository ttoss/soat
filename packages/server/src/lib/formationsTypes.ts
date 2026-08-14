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
   * Why `delete` would refuse for this resource, or `null` when it would
   * succeed. Declared only by resource types that have a *predictable* refusal
   * (an agent with generation history); a type without one contributes no
   * pre-flight answer and is simply attempted.
   *
   * Teardown deletes in dependency order, so a refusal discovered by attempting
   * the delete arrives after everything ordered ahead of it is already gone.
   * Consulting this first lets the whole teardown fail having destroyed nothing.
   */
  findDeletionBlocker?: (args: {
    physicalResourceId: string;
  }) => Promise<string | null>;
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

// ── Wire Types ────────────────────────────────────────────────────────────
//
// `PlanChange`/`FormationEvent` carry structural keys in camelCase
// internally, but are documented (and specced in `formations.yaml`) as
// snake_case on the wire — both in the `POST /formations/plan` response and
// embedded in a `FormationOperation`'s `events`/`plan`. `diff.desired` /
// `diff.current` are the resource's own template properties (already
// snake_case, author-authored) and round-trip verbatim, unlike the
// structural fields around them.

export type PlanChangeWire = {
  logical_id: string;
  resource_type: string;
  action: 'create' | 'update' | 'delete' | 'no-op';
  physical_resource_id?: string;
  diff?: {
    desired: Record<string, unknown>;
    current: Record<string, unknown> | null;
  };
};

export type PlanResultWire = {
  changes: PlanChangeWire[];
};

export type FormationEventWire = {
  timestamp: string;
  logical_id: string;
  resource_type: string;
  action: string;
  status: 'succeeded' | 'failed';
  physical_resource_id?: string;
  error?: string;
};

/** Converts an internal `PlanChange` to its snake_case wire shape. */
export const planChangeToWire = (change: PlanChange): PlanChangeWire => {
  return {
    logical_id: change.logicalId,
    resource_type: change.resourceType,
    action: change.action,
    ...(change.physicalResourceId !== undefined
      ? { physical_resource_id: change.physicalResourceId }
      : {}),
    ...(change.diff !== undefined ? { diff: change.diff } : {}),
  };
};

/** Converts an internal `PlanResult` to its snake_case wire shape. */
export const planResultToWire = (plan: PlanResult): PlanResultWire => {
  return { changes: plan.changes.map(planChangeToWire) };
};

/** Converts an internal `FormationEvent` to its snake_case wire shape. */
export const formationEventToWire = (
  event: FormationEvent
): FormationEventWire => {
  return {
    timestamp: event.timestamp,
    logical_id: event.logicalId,
    resource_type: event.resourceType,
    action: event.action,
    status: event.status,
    ...(event.physicalResourceId !== undefined
      ? { physical_resource_id: event.physicalResourceId }
      : {}),
    ...(event.error !== undefined ? { error: event.error } : {}),
  };
};

// ── Mapped Types ──────────────────────────────────────────────────────────

export type MappedFormationResource = {
  id: string;
  logical_id: string;
  resource_type: string;
  physical_resource_id: string | null;
  status: string;
};

export type MappedFormation = {
  id: string;
  project_id: string;
  name: string;
  template: FormationTemplate | null;
  outputs: Record<string, string> | null;
  status: string;
  metadata: Record<string, unknown> | null;
  resolved_metadata: Record<string, unknown> | null;
  resolved_parameters: Record<string, string> | null;
  resources?: MappedFormationResource[];
  created_at: Date;
  updated_at: Date;
};

/** A formation operation is a response body, so the type is the wire shape. */
export type MappedFormationOperation = {
  id: string;
  operation_type: string;
  status: string;
  events: FormationEventWire[] | null;
  plan: PlanResultWire | null;
  error: object | null;
  created_at: Date;
  updated_at: Date;
};
