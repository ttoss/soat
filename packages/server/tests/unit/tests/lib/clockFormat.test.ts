import {
  canonicalTimezone,
  CLOCK_FIELDS,
  formatClock,
  ISO_CLOCK_PATTERN,
  isValidClockPattern,
} from 'src/lib/clockFormat';

// A `lib/` test per the keep-list rule: the pattern grammar is a pure algorithm
// whose input space (fields × timezones × quoting) is low-resolution through a
// generation's system prompt.

// 2026-02-28 21:05:09 Saturday in São Paulo (UTC-03:00).
const NOW = new Date('2026-03-01T00:05:09.750Z');

const render = (pattern: string, timezone = 'America/Sao_Paulo'): string => {
  return formatClock({ now: NOW, timezone, pattern });
};

describe('formatClock', () => {
  test.each([
    ['yyyy', '2026'],
    ['yy', '26'],
    ['MMMM', 'February'],
    ['MMM', 'Feb'],
    ['MM', '02'],
    ['M', '2'],
    ['dd', '28'],
    ['d', '28'],
    ['EEEE', 'Saturday'],
    ['EEE', 'Sat'],
    ['HH', '21'],
    ['H', '21'],
    ['hh', '09'],
    ['h', '9'],
    ['a', 'PM'],
    ['mm', '05'],
    ['ss', '09'],
    ['Z', '-03:00'],
  ])('renders %s as %s', (pattern, expected) => {
    expect(render(pattern)).toBe(expected);
  });

  test('every field has a case above', () => {
    expect(Object.keys(CLOCK_FIELDS).sort()).toEqual(
      [
        'yyyy',
        'yy',
        'MMMM',
        'MMM',
        'MM',
        'M',
        'dd',
        'd',
        'EEEE',
        'EEE',
        'HH',
        'H',
        'hh',
        'h',
        'a',
        'mm',
        'ss',
        'Z',
      ].sort()
    );
  });

  test('the ISO pattern carries the zone offset and drops milliseconds', () => {
    expect(render(ISO_CLOCK_PATTERN)).toBe('2026-02-28T21:05:09-03:00');
    expect(render(ISO_CLOCK_PATTERN, 'UTC')).toBe('2026-03-01T00:05:09+00:00');
  });

  test('a half-hour offset renders its minutes', () => {
    expect(render('Z', 'Asia/Kolkata')).toBe('+05:30');
  });

  test('noon and midnight are 12 on the 12-hour clock', () => {
    const at = (iso: string) => {
      return formatClock({
        now: new Date(iso),
        timezone: 'UTC',
        pattern: 'h a',
      });
    };
    expect(at('2026-03-01T12:00:00Z')).toBe('12 PM');
    expect(at('2026-03-01T00:00:00Z')).toBe('12 AM');
    expect(at('2026-03-01T09:00:00Z')).toBe('9 AM');
  });

  test("quoted text and '' render literally; other symbols pass through", () => {
    expect(render("EEEE, d 'de' MMMM 'at' HH:mm")).toBe(
      'Saturday, 28 de February at 21:05'
    );
    expect(render("HH''mm")).toBe("21'05");
  });
});

describe('isValidClockPattern', () => {
  test.each(["yyyy-MM-dd'T'HH:mm:ssZ", "'only text'", '-/:, ', "''"])(
    'accepts %p',
    (pattern) => {
      expect(isValidClockPattern(pattern)).toBe(true);
    }
  );

  test.each([
    ['an empty pattern', ''],
    ['an unknown letter', 'yyyy-QQ'],
    ['a run no field names', 'yyy'],
    ['an unterminated quote', "HH 'o clock"],
  ])('refuses %s', (_, pattern) => {
    expect(isValidClockPattern(pattern)).toBe(false);
  });
});

describe('canonicalTimezone', () => {
  test('returns the IANA name Intl knows', () => {
    expect(canonicalTimezone('America/Sao_Paulo')).toBe('America/Sao_Paulo');
    expect(canonicalTimezone('UTC')).toBe('UTC');
  });

  test.each([
    ['a non-string', 42],
    ['an empty string', ''],
    ['a value outside the name grammar', '../etc'],
    ['a well-formed name Intl does not know', 'Mars/Olympus_Mons'],
  ])('refuses %s', (_, value) => {
    expect(canonicalTimezone(value)).toBeNull();
  });
});
