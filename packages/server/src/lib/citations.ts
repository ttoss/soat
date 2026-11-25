/**
 * Whether a turn asks for and returns citations: the agent's stored
 * `citation_config`, unless the generation request names its own.
 */
import createDebug from 'debug';

import { db } from '../db';
import { parseCitationMarkup } from './citationMarkup';
import {
  type Citation,
  type CitationSource,
  type RejectedCitation,
  verifyCitations,
} from './citationVerification';
import { assertValidEnabledConfig, readEnabledConfig } from './enabledConfig';
import type {
  KnowledgeRetrieval,
  KnowledgeRetrievalEntry,
} from './knowledgeRetrievalRecord';

const log = createDebug('soat:citations');

export const assertValidCitationConfig = (value: unknown): void => {
  assertValidEnabledConfig({ field: 'citation_config', value });
};

export const resolveCitationsEnabled = (args: {
  stored: unknown;
  requested: unknown;
}): boolean => {
  const source = args.requested === undefined ? args.stored : args.requested;
  return readEnabledConfig(source).enabled;
};

/** The ref a turn's `index`-th injected knowledge result is cited by. */
export const citationRef = (index: number): string => {
  return `c${index + 1}`;
};

export const CITATION_INSTRUCTION =
  'Cite the reference material you rely on. Wrap each statement it supports ' +
  'in <cite ref="LABEL" quote="EXACT TEXT">statement</cite>, where LABEL is ' +
  'the c-number in the bracketed header of the passage you used and EXACT ' +
  'TEXT is copied verbatim from that passage (write " as &quot;). Cite only ' +
  'passages that carry a c-number.';

export type TurnCitations = {
  citations: Citation[];
  rejected: RejectedCitation[];
};

/** A citation as the generation record keeps it: pointers, never text. */
export type CitationPointer = Omit<Citation, 'quoted_text'>;

export const toCitationPointers = (
  citations: Citation[]
): CitationPointer[] => {
  return citations.map(({ quoted_text: _text, ...pointer }) => {
    return pointer;
  });
};

type RetrievedDocument = Extract<
  KnowledgeRetrievalEntry,
  { source_type: 'document' }
>;

/**
 * Every ref the turn was given, from its own `retrieval` record — the ids it
 * injected, in injection order — with the text of each chunk. A chunk that no
 * longer resolves is `null`.
 */
const loadCitationSources = async (args: {
  retrieval: KnowledgeRetrieval;
}): Promise<Record<string, CitationSource | null>> => {
  const documents = (args.retrieval ?? []).flatMap((entry, index) => {
    return entry.source_type === 'document'
      ? [{ ref: citationRef(index), entry }]
      : [];
  });
  const chunks = await db.DocumentChunk.findAll({
    where: {
      publicId: documents.map(({ entry }) => {
        return entry.chunk_id;
      }),
    },
    attributes: ['publicId', 'content'],
  });
  const contentById = new Map(
    chunks.map((chunk) => {
      return [chunk.publicId, chunk.content];
    })
  );
  const toSource = (entry: RetrievedDocument): CitationSource | null => {
    const text = contentById.get(entry.chunk_id);
    if (text === undefined) return null;
    return {
      origin: 'retrieval',
      documentId: entry.document_id,
      documentVersion: entry.document_version,
      chunkId: entry.chunk_id,
      page: entry.page,
      text,
    };
  };
  return Object.fromEntries(
    documents.map(({ ref, entry }) => {
      return [ref, toSource(entry)];
    })
  );
};

/**
 * The chokepoint every completed turn's text crosses. A turn that cites (its
 * record's `citations` is not null) gets its markup stripped and each citation
 * verified against the sources the turn was given; any other turn's text is
 * returned untouched.
 */
export const resolveTurnCitations = async (args: {
  generationId: string;
  text: string;
}): Promise<{ content: string; turn: TurnCitations | null }> => {
  const gen = await db.Generation.findOne({
    where: { publicId: args.generationId },
    attributes: ['citations', 'retrieval'],
  });
  if (!gen || gen.citations === null) {
    return { content: args.text, turn: null };
  }
  const parsed = parseCitationMarkup({ text: args.text });
  // Written only by `toKnowledgeRetrieval`, so the stored shape is the type.
  const sources = await loadCitationSources({
    retrieval: gen.retrieval as KnowledgeRetrieval,
  });
  const turn = verifyCitations({
    marks: parsed.marks,
    malformed: parsed.malformed,
    sources,
  });
  log(
    'resolveTurnCitations: generationId=%s citations=%d rejected=%d',
    args.generationId,
    turn.citations.length,
    turn.rejected.length
  );
  return { content: parsed.content, turn };
};
