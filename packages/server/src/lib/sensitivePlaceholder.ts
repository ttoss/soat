/**
 * What a credential-bearing value reads as once it has been stored.
 *
 * Deliberately an object rather than a masking string: a stored template is a
 * record a caller can read back, and the obvious next move is to edit it and
 * send it again. A string mask would round-trip as the new secret and silently
 * replace one; this fails the schema's `type: string` check instead, so the
 * mistake surfaces as a refusal rather than as a rotated credential nobody
 * asked for.
 */
export const SENSITIVE_PLACEHOLDER = { no_echo: true } as const;
