import { DomainError } from '../errors';

/**
 * A caller-supplied value for a column that holds one of a fixed set, checked
 * before it is written. Absent passes: the caller is not setting the field.
 */
export const assertEnumField = <T extends string>(args: {
  field: string;
  value: unknown;
  allowed: readonly T[];
}): T | undefined => {
  if (args.value === undefined) return undefined;
  const allowed: readonly unknown[] = args.allowed;
  const isAllowed = (value: unknown): value is T => {
    return allowed.includes(value);
  };
  if (isAllowed(args.value)) return args.value;

  throw new DomainError(
    'VALIDATION_FAILED',
    `\`${args.field}\` must be one of: ${args.allowed.join(', ')} — received ${JSON.stringify(args.value)}`,
    { field: args.field, allowed: [...args.allowed] }
  );
};
