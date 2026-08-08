import { DomainError } from '../../errors';
import type { GuardrailDocument } from '../guardrailDocument';
import { validateGuardrailDocument } from '../guardrailDocument';
import {
  createGuardrail,
  deleteGuardrail,
  getGuardrail,
  updateGuardrail,
} from '../guardrails';
import {
  toNullableString,
  toOptionalString,
} from '../resource-inputs/normalizers';
import { defineFormationModule } from './defineFormationModule';
import { isFormationExpression } from './formationSpecLoader';

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

export const guardrailsFormationModule = defineFormationModule({
  resourceType: 'guardrail',

  // Validate the assembled action-class document (class literal/JSON-Logic
  // namespace checks, escalate boolean, etc.) — skipped when a document
  // field is still an unresolved `{ ref / param / sub }` expression, since
  // that can't be validated in isolation; `createGuardrail`/`updateGuardrail`
  // re-validate the resolved document at apply time regardless.
  extraChecks: ({ properties, basePath, errors }) => {
    if (properties.class === undefined || hasExpressionField(properties)) {
      return;
    }
    try {
      validateGuardrailDocument(buildGuardrailDocument(properties));
    } catch (error) {
      const message =
        error instanceof DomainError ? error.message : String(error);
      errors.push({ path: `${basePath}.class`, message });
    }
  },

  create: ({ properties, projectId }) => {
    return createGuardrail({
      projectId,
      name: properties.name as string,
      description: toOptionalString(properties.description),
      document: buildGuardrailDocument(properties)!,
      contextToolId: toNullableString(properties.context_tool_id),
      contextMode: toNullableString(properties.context_mode),
    });
  },

  update: async ({ properties, physicalResourceId }) => {
    await updateGuardrail({
      id: physicalResourceId,
      name: toOptionalString(properties.name),
      description: toNullableString(properties.description),
      document: buildGuardrailDocument(properties),
      contextToolId: toNullableString(properties.context_tool_id),
      contextMode: toNullableString(properties.context_mode),
    });
  },

  remove: ({ physicalResourceId }) => {
    return deleteGuardrail({ id: physicalResourceId });
  },

  fetch: ({ physicalResourceId }) => {
    return getGuardrail({ id: physicalResourceId });
  },

  // The stored `document` is flattened back to the four template fields, so
  // this view is a mapping rather than a plain field selection.
  read: (guardrail) => {
    const document = guardrail.document as GuardrailDocument;
    return {
      name: guardrail.name,
      description: guardrail.description,
      class: document.class,
      default_class: document.default_class ?? null,
      guard: document.guard ?? null,
      escalate: document.escalate ?? null,
      context_tool_id: guardrail.context_tool_id,
      context_mode: guardrail.context_mode,
    };
  },
});
