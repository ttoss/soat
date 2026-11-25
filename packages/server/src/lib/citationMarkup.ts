/**
 * The `<cite ref="…" quote="…">claim</cite>` markup a model writes when a turn
 * asks for citations (`citations.ts`), read by one tokenizer: the streamed
 * text and the parsed `content` come out of the same events, so a stream never
 * carries text the stored answer does not.
 */
export type Span = { start: number; end: number };

export type CiteMark = { ref: string; quote: string; answerSpan: Span };

export type MalformedCite = { ref: string | null; quote: string | null };

type MarkupEvent =
  | { type: 'text'; text: string }
  | { type: 'open'; attributes: string }
  | { type: 'close' };

const OPEN_PREFIX = '<cite';
const CLOSE_TAG = '</cite>';
// An opening tag longer than this is prose that happens to start with `<cite`.
const MAX_TAG_LENGTH = 4000;

const codePointLength = (text: string): number => {
  return Array.from(text).length;
};

const createTokenizer = (args: { emit: (event: MarkupEvent) => void }) => {
  let pending = '';
  let inTag = false;
  let inQuote = false;

  const emitText = (text: string) => {
    if (text) args.emit({ type: 'text', text });
  };

  const consumeTagChar = (char: string) => {
    pending += char;
    if (char === '"') inQuote = !inQuote;
    if (char === '>' && !inQuote) {
      args.emit({
        type: 'open',
        attributes: pending.slice(OPEN_PREFIX.length, -1),
      });
      pending = '';
      inTag = false;
      return;
    }
    if (pending.length > MAX_TAG_LENGTH) {
      const text = pending;
      pending = '';
      inTag = false;
      inQuote = false;
      emitText(text);
    }
  };

  // `pending` holds a `<` and what follows it while it can still become a tag.
  const startsTag = (char: string): boolean => {
    return pending === OPEN_PREFIX && (char === '>' || /\s/.test(char));
  };

  /**
   * `pending` is a `<` and what follows it, extended by `char`. Returns what to
   * rescan: the characters after the `<` of something that is not a tag.
   */
  const consumePendingChar = (char: string): string => {
    const candidate = pending + char;
    if (candidate === CLOSE_TAG) {
      pending = '';
      args.emit({ type: 'close' });
      return '';
    }
    if (CLOSE_TAG.startsWith(candidate) || OPEN_PREFIX.startsWith(candidate)) {
      pending = candidate;
      return '';
    }
    if (startsTag(char)) {
      inTag = true;
      inQuote = false;
      consumeTagChar(char);
      return '';
    }
    pending = '';
    emitText(candidate[0]);
    return candidate.slice(1);
  };

  const consumeChar = (char: string): void => {
    if (inTag) consumeTagChar(char);
    else if (pending) {
      for (const next of consumePendingChar(char)) consumeChar(next);
    } else if (char === '<') pending = char;
    else emitText(char);
  };

  return {
    push: (chunk: string) => {
      for (const char of chunk) consumeChar(char);
    },
    flush: () => {
      const text = pending;
      pending = '';
      inTag = false;
      inQuote = false;
      emitText(text);
    },
  };
};

/**
 * Strips citation markup from a text stream. `push` returns only text that can
 * no longer turn into a tag; `flush` returns what is held at the end.
 */
export const createCitationMarkupStripper = () => {
  let out = '';
  const tokenizer = createTokenizer({
    emit: (event) => {
      if (event.type === 'text') out += event.text;
    },
  });
  const take = () => {
    const text = out;
    out = '';
    return text;
  };
  return {
    push: (chunk: string): string => {
      tokenizer.push(chunk);
      return take();
    },
    flush: (): string => {
      tokenizer.flush();
      return take();
    },
  };
};

/** {@link createCitationMarkupStripper} as a stream stage. */
export const citationMarkupStripStream = (): TransformStream<
  string,
  string
> => {
  const stripper = createCitationMarkupStripper();
  return new TransformStream<string, string>({
    transform: (chunk, controller) => {
      const text = stripper.push(chunk);
      if (text) controller.enqueue(text);
    },
    flush: (controller) => {
      const text = stripper.flush();
      if (text) controller.enqueue(text);
    },
  });
};

const decodeEntities = (value: string): string => {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
};

const readAttributes = (raw: string): Record<string, string> => {
  const attributes: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_][\w-]*)\s*=\s*"([^"]*)"/g)) {
    attributes[match[1]] = decodeEntities(match[2]);
  }
  return attributes;
};

type OpenMark = { ref: string | null; quote: string | null; start: number };

/** The answer without markup, each well-formed mark, and each malformed one. */
export const parseCitationMarkup = (args: {
  text: string;
}): { content: string; marks: CiteMark[]; malformed: MalformedCite[] } => {
  let content = '';
  let length = 0;
  // Held on an object: the tokenizer's callback assigns it, which a `let`
  // narrowed to `null` at the call site would hide from the compiler.
  const state: { open: OpenMark | null } = { open: null };
  const marks: CiteMark[] = [];
  const malformed: MalformedCite[] = [];

  const closeOpen = () => {
    const { open } = state;
    if (!open) {
      malformed.push({ ref: null, quote: null });
      return;
    }
    state.open = null;
    const { ref, quote, start } = open;
    if (ref && quote !== null && quote.trim()) {
      marks.push({ ref, quote, answerSpan: { start, end: length } });
      return;
    }
    malformed.push({ ref, quote });
  };

  const tokenizer = createTokenizer({
    emit: (event) => {
      if (event.type === 'text') {
        content += event.text;
        length += codePointLength(event.text);
        return;
      }
      if (event.type === 'close') {
        closeOpen();
        return;
      }
      if (state.open) {
        malformed.push({ ref: state.open.ref, quote: state.open.quote });
      }
      const attributes = readAttributes(event.attributes);
      state.open = {
        ref: attributes.ref ?? null,
        quote: attributes.quote ?? null,
        start: length,
      };
    },
  });
  tokenizer.push(args.text);
  tokenizer.flush();
  if (state.open) {
    malformed.push({ ref: state.open.ref, quote: state.open.quote });
  }

  return { content, marks, malformed };
};
