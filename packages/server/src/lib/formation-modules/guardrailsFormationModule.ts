import createDebug from 'debug';

import { DomainError } from '../../errors';
import type { FormationModule, ValidationError } from '../formationsTypes';
import type { GuardrailDocument } from '../guardrailDocument';
import { validateGuardrailDocument } from '../guardrailDocument';
import {
  createGuardrail,
  deleteGuardrail,
  getGuardrail,
  updateGuardrail,
} from '../guardrails';
import {
  normalizePropertyKeys,
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import {
  isFormationExpression,
  isObjectRecord,
  loadModuleSpec,
  pushFieldTypeErrors,
  pushRequiredFieldErrors,
  pushUnknownFieldErrors,
} from './formationSpecLoader';

const log = createDebug('soat:formations:guardrails');

const SCHEMA_NAME = 'GuardrailResourceProperties';
const RESOURCE_LABEL = 'guardrail';

const DOCUMENT_FIELDS = [
  'class',
  'default_class',
  'guard',
  'escalate',
] as const;

// ── Document assembly ────────────────────────────────────────────────────
// The REST API nests class/default_class/guard/escalate under a single
// `document` object; the formation resource flattens them to top-level
// properties (matching how a template author declares a guardrail) and
// reassembles `document` here. A formation resource declaration is always
// the full desired state for that resource (not a partial patch), and
// `updateGuardrail`'s `document` argument replaces the stored document
// wholesale rather than merging it — so the document is rebuilt from
// scratch on every create/update from whichever of the four fields are
// currently present, rather than merged with the prior stored document.

const hasExpressionField = (properties: Record<string, unknown>): boolean => {
  return DOCUMENT_FIELDS.some((key) => {
    return isFormationExpression(properties[key]);
  });
};

const buildGuardrailDocument = (
  properties: Record<string, unknown>
): Record<string, unknown> | undefined => {
  if (properties.class === undefined) return undefined;

  const document: Record<string, unknown> = { class: properties.class };
  if (properties.default_class !== undefined) {
    document.default_class = properties.default_class;
  }
  if (properties.guard !== undefined) {
    document.guard = properties.guard;
  }
  if (properties.escalate !== undefined) {
    document.escalate = properties.escalate;
  }
  return document;
};

// ── Property validation ──────────────────────────────────────────────────

const validateGuardrailProperties = (args: {
  properties: unknown;
  basePath: string;
  forUpdate?: boolean;
}): ValidationError[] => {
  const { basePath, forUpdate } = args;
  if (!isObjectRecord(args.properties)) {
    return [
      { path: basePath, message: 'Guardrail `properties` must be an object' },
    ];
  }

  const properties = normalizePropertyKeys(args.properties);
  const spec = loadModuleSpec({ schemaName: SCHEMA_NAME });
  const errors: ValidationError[] = [];
  pushUnknownFieldErrors({
    spec,
    resourceLabel: RESOURCE_LABEL,
    properties,
    basePath,
    errors,
  });
  if (!forUpdate) {
    pushRequiredFieldErrors({ spec, properties, basePath, errors });
  }
  pushFieldTypeErrors({ spec, properties, basePath, errors });

  // Validate the assembled action-class document (class literal/JSON-Logic
  // namespace checks, escalate boolean, etc.) — skipped when a document
  // field is still an unresolved `{ ref / param / sub }` expression, since
  // that can't be validated in isolation; `createGuardrail`/`updateGuardrail`
  // re-validate the resolved document at apply time regardless.
  if (properties.class !== undefined && !hasExpressionField(properties)) {
    try {
      validateGuardrailDocument(buildGuardrailDocument(properties));
    } catch (error) {
      const message =
        error instanceof DomainError ? error.message : String(error);
      errors.push({ path: `${basePath}.class`, message });
    }
  }

  return errors;
};

// ── Module export ────────────────────────────────────────────────────────

export const guardrailsFormationModule: FormationModule = {
  resourceType: 'guardrail',

  validateProperties: ({ properties, basePath }) => {
    return validateGuardrailProperties({ properties, basePath });
  },

  create: async ({ properties: rawProperties, projectId }) => {
    const errors = validateGuardrailProperties({
      properties: rawProperties,
      basePath: 'resources.<guardrail>.properties',
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    const result = await createGuardrail({
      projectId,
      name: properties.name as string,
      description: toOptionalString(properties.description),
      document: buildGuardrailDocument(properties)!,
      contextToolId: toNullableString(properties.context_tool_id),
      contextMode: toNullableString(properties.context_mode),
    });

    log(
      'created guardrail from formation: projectId=%d guardrailId=%s',
      projectId,
      result.id
    );
    return result.id;
  },

  update: async ({ properties: rawProperties, physicalResourceId }) => {
    const errors = validateGuardrailProperties({
      properties: rawProperties,
      basePath: 'resources.<guardrail>.properties',
      forUpdate: true,
    });
    if (errors.length > 0) {
      throw new Error(errors[0].message);
    }

    const properties = isObjectRecord(rawProperties)
      ? normalizePropertyKeys(rawProperties)
      : rawProperties;

    await updateGuardrail({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      document: buildGuardrailDocument(properties),
      contextToolId: toNullableString(properties.context_tool_id),
      contextMode: toNullableString(properties.context_mode),
    });

    log('updated guardrail from formation: id=%s', physicalResourceId);
  },

  delete: async ({ physicalResourceId }) => {
    await deleteGuardrail({ id: physicalResourceId });
    log('deleted guardrail from formation: id=%s', physicalResourceId);
  },

  read: async ({ physicalResourceId }) => {
    try {
      const guardrail = await getGuardrail({ id: physicalResourceId });
      const document = guardrail.document as GuardrailDocument;
      return {
        name: guardrail.name,
        description: guardrail.description,
        class: document.class,
        default_class: document.default_class ?? null,
        guard: document.guard ?? null,
        escalate: document.escalate ?? null,
        context_tool_id: guardrail.contextToolId,
        context_mode: guardrail.contextMode,
      };
    } catch {
      return null;
    }
  },
};
