import fs from 'node:fs';

import type { db } from '../db';
import { DomainError } from '../errors';
import type { SourcePage } from './chunking';
import { invokeConverter } from './converterInvocation';
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

export type ResolvedSourcePages = {
  pages: SourcePage[];
  rule: MappedIngestionRule | null;
};

const extractNativePages = async (
  file: IngestedFile
): Promise<SourcePage[]> => {
  const buffer = fs.readFileSync(file.storagePath);

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

const convertWithRule = (
  file: IngestedFile,
  rule: MappedIngestionRule
): Promise<SourcePage[]> => {
  return invokeConverter({ file, rule, projectId: file.projectId });
};

/**
 * Resolves pages for a natively-supported type (PDF/text). A rule with
 * `native_extraction: skip` bypasses native extraction; otherwise native runs
 * first and the converter is only a fallback when it yields no text (scanned
 * PDFs). Returns the rule only when the converter actually ran.
 */
const resolveNativeSourcePages = async (
  file: IngestedFile,
  rule: MappedIngestionRule | null
): Promise<ResolvedSourcePages> => {
  if (rule && rule.nativeExtraction === 'skip') {
    return { pages: await convertWithRule(file, rule), rule };
  }
  const pages = await extractNativePages(file);
  if (pages.length > 0) return { pages, rule: null };
  if (rule) return { pages: await convertWithRule(file, rule), rule };
  return { pages: [], rule: null };
};

/**
 * Produces the source pages for a file, routing through an ingestion-rule
 * converter when needed (non-native types, scanned-PDF fallback, or a rule
 * with `native_extraction: skip`). Returns the matched rule when a converter
 * ran, so the caller can apply the rule's default chunk config.
 */
export const resolveSourcePages = async (
  file: IngestedFile
): Promise<ResolvedSourcePages> => {
  const contentType = file.contentType ?? '';
  const rule = await resolveIngestionRule({
    projectId: file.projectId,
    contentType,
  });

  if (SUPPORTED_CONTENT_TYPES.includes(contentType)) {
    return resolveNativeSourcePages(file, rule);
  }

  if (rule) return { pages: await convertWithRule(file, rule), rule };

  throw new DomainError(
    'UNSUPPORTED_FILE_TYPE',
    `File '${file.publicId}' has unsupported content type '${contentType || 'unknown'}' and no matching ingestion rule.`
  );
};
