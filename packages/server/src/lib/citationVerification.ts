/**
 * The one check every citation crosses before a caller sees it: the ref names
 * a source this turn was given, and the quote is in that source's text. What
 * fails is returned as rejected with its reason, never as a citation.
 */
import type { CiteMark, MalformedCite, Span } from './citationMarkup';

/** A knowledge chunk the turn injected, or a page of a file it was sent. */
export type CitationSource = {
  origin: 'retrieval' | 'attached_file';
  documentId: string | null;
  documentVersion: number | null;
  chunkId: string | null;
  fileId: string | null;
  page: number | null;
  text: string;
};

export type Citation = {
  origin: CitationSource['origin'];
  document_id: string | null;
  document_version: number | null;
  chunk_id: string | null;
  file_id: string | null;
  page: number | null;
  page_end: number | null;
  /** The source's own text at `source_span`, not the model's quote. */
  quoted_text: string;
  /** Code points into the cited chunk's, or page's, text. */
  source_span: Span;
  /** Code points into the answer's `content`. */
  answer_span: Span;
  verification: 'runtime';
};

export const CITATION_REJECTION_REASONS = [
  'UNKNOWN_REF',
  'SOURCE_UNAVAILABLE',
  'QUOTE_NOT_FOUND',
  'MALFORMED_CITE',
] as const;

export type RejectedCitation = {
  ref: string | null;
  quoted_text: string | null;
  reason: (typeof CITATION_REJECTION_REASONS)[number];
};

/**
 * The source with each whitespace run read as one space, and for each code
 * point of that form, the range of the source it stands for.
 */
const collapseWhitespace = (codePoints: string[]) => {
  const collapsed: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  for (const [index, char] of codePoints.entries()) {
    const isSpace = /\s/.test(char);
    if (isSpace && collapsed[collapsed.length - 1] === ' ') {
      ends[ends.length - 1] = index + 1;
      continue;
    }
    collapsed.push(isSpace ? ' ' : char);
    starts.push(index);
    ends.push(index + 1);
  }
  return { text: collapsed.join(''), starts, ends };
};

const normalizeQuote = (quote: string): string => {
  return quote.normalize('NFC').replace(/\s+/g, ' ').trim();
};

/** Where `quote` sits in `text`, in code points of the NFC form of `text`. */
const locateQuote = (args: {
  text: string;
  quote: string;
}): { span: Span; quotedText: string } | null => {
  const needle = normalizeQuote(args.quote);
  if (!needle) return null;
  const codePoints = Array.from(args.text.normalize('NFC'));
  const haystack = collapseWhitespace(codePoints);
  const at = haystack.text.indexOf(needle);
  if (at < 0) return null;
  const first = Array.from(haystack.text.slice(0, at)).length;
  const last = first + Array.from(needle).length - 1;
  const span = { start: haystack.starts[first], end: haystack.ends[last] };
  return {
    span,
    quotedText: codePoints.slice(span.start, span.end).join(''),
  };
};

const verifyMark = (args: {
  mark: CiteMark;
  sources: Record<string, CitationSource | null>;
}): Citation | RejectedCitation => {
  const { mark } = args;
  const reject = (reason: RejectedCitation['reason']): RejectedCitation => {
    return { ref: mark.ref, quoted_text: mark.quote, reason };
  };
  if (!Object.hasOwn(args.sources, mark.ref)) return reject('UNKNOWN_REF');
  const source = args.sources[mark.ref];
  if (!source) return reject('SOURCE_UNAVAILABLE');
  const located = locateQuote({ text: source.text, quote: mark.quote });
  if (!located) return reject('QUOTE_NOT_FOUND');
  return {
    origin: source.origin,
    document_id: source.documentId,
    document_version: source.documentVersion,
    chunk_id: source.chunkId,
    file_id: source.fileId,
    page: source.page,
    page_end: source.page,
    quoted_text: located.quotedText,
    source_span: located.span,
    answer_span: mark.answerSpan,
    verification: 'runtime',
  };
};

export const verifyCitations = (args: {
  marks: CiteMark[];
  malformed: MalformedCite[];
  /** Each ref the turn was given; `null` when its source no longer resolves. */
  sources: Record<string, CitationSource | null>;
}): { citations: Citation[]; rejected: RejectedCitation[] } => {
  const citations: Citation[] = [];
  const rejected: RejectedCitation[] = [];
  for (const mark of args.marks) {
    const result = verifyMark({ mark, sources: args.sources });
    if ('reason' in result) rejected.push(result);
    else citations.push(result);
  }
  for (const cite of args.malformed) {
    rejected.push({
      ref: cite.ref,
      quoted_text: cite.quote,
      reason: 'MALFORMED_CITE',
    });
  }
  return { citations, rejected };
};
