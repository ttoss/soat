import { DomainError } from '../errors';

/**
 * Puts each resolved secret back as its `{{secret:}}` reference. Case-blind and
 * on the percent-encoded form too: `URL` lowercases a host and encodes a path.
 */
const redactSecretValues = (args: {
  text: string;
  secrets: ReadonlyMap<string, string>;
}): string => {
  let text = args.text;
  for (const [id, value] of args.secrets) {
    for (const form of new Set([value, encodeURIComponent(value)])) {
      if (form === '') continue;
      const pattern = new RegExp(
        form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
        'gi'
      );
      text = text.replace(pattern, `{{secret:${id}}}`);
    }
  }
  return text;
};

export const redactEgressSecrets = (args: {
  error: unknown;
  secrets?: ReadonlyMap<string, string>;
}): unknown => {
  const { error, secrets } = args;
  if (!(error instanceof DomainError) || error.code !== 'TOOL_EGRESS_BLOCKED') {
    return error;
  }
  if (!secrets || secrets.size === 0) return error;
  const redact = (text: string): string => {
    return redactSecretValues({ text, secrets });
  };
  const meta = error.meta
    ? Object.fromEntries(
        Object.entries(error.meta).map(([key, value]) => {
          return [key, typeof value === 'string' ? redact(value) : value];
        })
      )
    : undefined;
  return new DomainError(error.code, redact(error.message), meta);
};
