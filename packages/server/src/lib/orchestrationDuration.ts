const SUFFIX_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60000,
  h: 3600000,
  d: 86400000,
};

/**
 * Parses a duration string to milliseconds. Accepts a friendly suffix form
 * (`5s`, `30s`, `5m`, `2h`, `1d`, `500ms`) or ISO 8601 (`PT5S`, `PT1M30S`,
 * `P1DT2H`). Unparseable input resolves to `0` (a no-op wait), matching the
 * delay node's long-standing behaviour. Shared by the `delay` and `poll` nodes
 * so both accept the same formats.
 */
export const parseDuration = (value: string): number => {
  const suffix = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value.trim());
  if (suffix) {
    const amount = parseFloat(suffix[1] ?? '0');
    const unitMs = SUFFIX_UNIT_MS[suffix[2] ?? 's'] ?? 1000;
    return amount * unitMs;
  }
  const iso =
    /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      value
    );
  if (!iso) return 0;
  const days = parseFloat(iso[1] ?? '0');
  const hours = parseFloat(iso[2] ?? '0');
  const minutes = parseFloat(iso[3] ?? '0');
  const seconds = parseFloat(iso[4] ?? '0');
  return ((days * 24 + hours) * 60 + minutes) * 60000 + seconds * 1000;
};
