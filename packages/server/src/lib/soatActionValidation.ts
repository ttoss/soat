import { DomainError } from '../errors';
import { isAgentExcludedAction } from './soatAgentActions';
import { soatTools } from './soatTools';

/**
 * What a `builtin` tool's `actions` array may name, refused at the write so a
 * binding that could never resolve is reported where the author can fix it.
 */
const KNOWN_SOAT_ACTIONS = new Set(
  soatTools.map((tool) => {
    return tool.name;
  })
);

// Action names are kebab-case, matching the MCP tool name derived from the
// operationId. Passing the camelCase operationId itself is a common mistake, so
// it is detected and the right name suggested.
const camelToKebab = (value: string): string => {
  return value.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
};

export const validateSoatActions = (actions: string[] | null | undefined) => {
  if (!actions) return;

  // Named before the unknown-action check: an excluded action exists and the
  // caller may well hold the permission for it, so "unknown" would send them
  // looking for a typo that is not there.
  const excluded = actions.filter(isAgentExcludedAction);
  if (excluded.length > 0) {
    throw new DomainError(
      'VALIDATION_FAILED',
      `SOAT action(s) not available to an agent: ${excluded
        .map((action) => {
          return `"${action}"`;
        })
        .join(
          ', '
        )}. These mint credentials, change authorization, read secret material or settle an approval, so a generation may not perform them however its caller is authorized.`
    );
  }

  const unknown = actions.filter((action) => {
    return !KNOWN_SOAT_ACTIONS.has(action);
  });
  if (unknown.length === 0) return;
  const details = unknown
    .map((action) => {
      const suggestion = camelToKebab(action);
      return KNOWN_SOAT_ACTIONS.has(suggestion)
        ? `"${action}" (did you mean "${suggestion}"?)`
        : `"${action}"`;
    })
    .join(', ');
  throw new DomainError(
    'VALIDATION_FAILED',
    `Unknown SOAT action(s): ${details}.`
  );
};
