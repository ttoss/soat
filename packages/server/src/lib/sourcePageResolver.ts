import type { db } from '../db';
import { DomainError } from '../errors';
import type { SourcePage } from './chunking';
import { invokeConverter } from './converterInvocation';
import { readFileBuffer } from './fileStorage';
import {
  type MappedIngestionRule,
  resolveIngestionRule,
} from './ingestionRules';
import { extractPdfPages } from './pdf';

export const SUPPORTED_CONTENT_TYPES = [
  'application/pdf',
  'text/plain',
  'text/markdown',
];

type IngestedFile = InstanceType<(typeof db)['File']>;

export type ResolvedSourcePages =
  | { status: 'ready'; pages: SourcePage[]; rule: MappedIngestionRule | null }
  | {
      status: 'pending';
      rule: MappedIngestionRule;
      converterId: string;
      submittedAt: string;
    };

const extractNativePages = async (
  file: IngestedFile
): Promise<SourcePage[]> => {
  const buffer = await readFileBuffer({
    storageType: file.storageType,
    storagePath: file.storagePath,
  });
  if (!buffer) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `File '${file.publicId}' bytes are missing from storage.`
    );
  }

  if (file.contentType === 'application/pdf') {
    const rawPages = await extractPdfPages({ buffer });
    return rawPages
      .map((text, i) => {
        return { text: text.trim(), pageNumber: i + 1 };
      })
      .filter((page) => {
        return page.text.length > 0;
      });
  }

  // text/plain, text/markdown
  const text = buffer.toString('utf-8').trim();
  return text.length > 0 ? [{ text, pageNumber: 1 }] : [];
};

const convertWithRule = async (args: {
  file: IngestedFile;
  rule: MappedIngestionRule;
  documentId: string;
  attemptId: string;
}): Promise<ResolvedSourcePages> => {
  const outcome = await invokeConverter({
    file: args.file,
    rule: args.rule,
    projectId: args.file.projectId,
    documentId: args.documentId,
    attemptId: args.attemptId,
  });

  if (outcome.status === 'pending') {
    return {
      status: 'pending',
      rule: args.rule,
      converterId: outcome.converterId,
      submittedAt: outcome.submittedAt,
    };
  }
  return { status: 'ready', pages: outcome.pages, rule: args.rule };
};

/**
 * Resolves pages for a natively-supported type (PDF/text). A rule with
 * `native_extraction: skip` bypasses native extraction; otherwise native runs
 * first and the converter is only a fallback when it yields no text (scanned
 * PDFs). Returns the rule only when the converter actually ran.
 */
const resolveNativeSourcePages = async (
  file: IngestedFile,
  rule: MappedIngestionRule | null,
  documentId: string,
  attemptId: string
): Promise<ResolvedSourcePages> => {
  if (rule && rule.nativeExtraction === 'skip') {
    return convertWithRule({ file, rule, documentId, attemptId });
  }
  const pages = await extractNativePages(file);
  if (pages.length > 0) return { status: 'ready', pages, rule: null };
  if (rule) return convertWithRule({ file, rule, documentId, attemptId });
  return { status: 'ready', pages: [], rule: null };
};

/**
 * Produces the source pages for a file, routing through an ingestion-rule
 * converter when needed (non-native types, scanned-PDF fallback, or a rule
 * with `native_extraction: skip`). Returns the matched rule when a converter
 * ran, so the caller can apply the rule's default chunk config. A tool
 * converter may defer with `status: 'pending'` (Phase 5) instead of returning
 * pages immediately — the caller is responsible for persisting that state and
 * finishing the document later via the ingestion-callback endpoint.
 */
export const resolveSourcePages = async (
  file: IngestedFile,
  documentId: string,
  attemptId: string
): Promise<ResolvedSourcePages> => {
  const contentType = file.contentType ?? '';
  const rule = await resolveIngestionRule({
    projectId: file.projectId,
    contentType,
  });

  if (SUPPORTED_CONTENT_TYPES.includes(contentType)) {
    return resolveNativeSourcePages(file, rule, documentId, attemptId);
  }

  if (rule) return convertWithRule({ file, rule, documentId, attemptId });

  throw new DomainError(
    'UNSUPPORTED_FILE_TYPE',
    `File '${file.publicId}' has unsupported content type '${contentType || 'unknown'}' and no matching ingestion rule.`
  );
};
