/**
 * An instant rendered in an IANA timezone through a closed set of pattern
 * fields (`yyyy-MM-dd HH:mm:ssZ` style). A letter outside {@link CLOCK_FIELDS}
 * makes the pattern invalid rather than passing through as literal text, so a
 * typo is refused when the pattern is written instead of reaching the model.
 */

type ClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
  offsetMinutes: number;
};

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];

const pad = (value: number, width = 2): string => {
  return String(value).padStart(width, '0');
};

const hour12 = (hour: number): number => {
  return hour % 12 === 0 ? 12 : hour % 12;
};

const formatOffset = (offsetMinutes: number): string => {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
};

/** Every pattern field, keyed by the letter run that names it. */
export const CLOCK_FIELDS: Record<string, (parts: ClockParts) => string> = {
  yyyy: (p) => {
    return pad(p.year, 4);
  },
  yy: (p) => {
    return pad(p.year % 100);
  },
  MMMM: (p) => {
    return MONTHS[p.month - 1];
  },
  MMM: (p) => {
    return MONTHS[p.month - 1].slice(0, 3);
  },
  MM: (p) => {
    return pad(p.month);
  },
  M: (p) => {
    return String(p.month);
  },
  dd: (p) => {
    return pad(p.day);
  },
  d: (p) => {
    return String(p.day);
  },
  EEEE: (p) => {
    return WEEKDAYS[p.weekday];
  },
  EEE: (p) => {
    return WEEKDAYS[p.weekday].slice(0, 3);
  },
  HH: (p) => {
    return pad(p.hour);
  },
  H: (p) => {
    return String(p.hour);
  },
  hh: (p) => {
    return pad(hour12(p.hour));
  },
  h: (p) => {
    return String(hour12(p.hour));
  },
  a: (p) => {
    return p.hour < 12 ? 'AM' : 'PM';
  },
  mm: (p) => {
    return pad(p.minute);
  },
  ss: (p) => {
    return pad(p.second);
  },
  Z: (p) => {
    return formatOffset(p.offsetMinutes);
  },
};

/** ISO 8601 with the zone's offset, e.g. `2026-11-25T10:54:17-03:00`. */
export const ISO_CLOCK_PATTERN = "yyyy-MM-dd'T'HH:mm:ssZ";

type Segment = { field: string } | { literal: string };

const isLetter = (char: string): boolean => {
  return /[A-Za-z]/.test(char);
};

/** Reads a `'quoted'` literal starting at `start`; `''` is one quote. */
const readQuoted = (
  pattern: string,
  start: number
): { literal: string; next: number } | null => {
  const close = pattern.indexOf("'", start + 1);
  if (close === -1) return null;
  const literal = close === start + 1 ? "'" : pattern.slice(start + 1, close);
  return { literal, next: close + 1 };
};

const readRun = (pattern: string, start: number): string => {
  let end = start;
  while (pattern[end] === pattern[start]) end += 1;
  return pattern.slice(start, end);
};

/** The pattern's segments, or `null` when it names an unknown field. */
const parseClockPattern = (pattern: string): Segment[] | null => {
  const segments: Segment[] = [];
  let index = 0;
  while (index < pattern.length) {
    const char = pattern[index];
    if (char === "'") {
      const quoted = readQuoted(pattern, index);
      if (!quoted) return null;
      segments.push({ literal: quoted.literal });
      index = quoted.next;
    } else if (isLetter(char)) {
      const run = readRun(pattern, index);
      if (!Object.hasOwn(CLOCK_FIELDS, run)) return null;
      segments.push({ field: run });
      index += run.length;
    } else {
      segments.push({ literal: char });
      index += 1;
    }
  }
  return segments;
};

export const isValidClockPattern = (pattern: string): boolean => {
  return pattern.length > 0 && parseClockPattern(pattern) !== null;
};

/** The IANA name Intl knows a timezone by, or `null` when it knows none. */
export const canonicalTimezone = (value: unknown): string | null => {
  if (typeof value !== 'string' || !/^[A-Za-z][\w+\-/]*$/.test(value)) {
    return null;
  }
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
};

const clockParts = (args: { now: Date; timezone: string }): ClockParts => {
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: args.timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
      .formatToParts(args.now)
      .map((part) => {
        return [part.type, Number(part.value)];
      })
  );
  const { year, month, day, hour, minute, second } = fields;
  const localAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const wholeSeconds = Math.floor(args.now.getTime() / 1000) * 1000;
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    offsetMinutes: Math.round((localAsUtc - wholeSeconds) / 60_000),
  };
};

/** Renders `now` in `timezone`; the pattern is checked on write. */
export const formatClock = (args: {
  now: Date;
  timezone: string;
  pattern: string;
}): string => {
  const segments = parseClockPattern(args.pattern) ?? [];
  const parts = clockParts(args);
  return segments
    .map((segment) => {
      return 'field' in segment
        ? CLOCK_FIELDS[segment.field](parts)
        : segment.literal;
    })
    .join('');
};
