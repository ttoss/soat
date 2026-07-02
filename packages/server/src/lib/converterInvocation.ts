import fs from 'node:fs';

import createDebug from 'debug';

import { DomainError } from '../errors';
import { createGeneration } from './agents';
import type { SourcePage } from './chunking';
import { buildFileDownloadUrl } from './fileDownloadToken';
import type { MappedIngestionRule } from './ingestionRules';
import { callTool } from './tools';

const log = createDebug('soat:ingestionConverter');

const EXTRACT_INSTRUCTION =
  'Extract all text from the provided file verbatim. Return plain text only.';

/** The minimal file shape a converter needs — matches a `db.File` instance. */
export type ConverterFile = {
  publicId: string;
  filename?: string | null;
  contentType?: string | null;
  size?: number | null;
  storagePath: string;
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * Normalizes a converter's output into source pages. Accepts the three shapes
 * of the converter contract: a bare string (one page), `{ pages: [...] }`, or
 * `{ status: "pending" }` (async — not supported without the callback path).
 */
const parseConverterOutput = (raw: unknown): SourcePage[] => {
  if (typeof raw === 'string') {
    const text = raw.trim();
    return text.length > 0 ? [{ text, pageNumber: 1 }] : [];
  }

  if (isRecord(raw)) {
    if (raw['status'] === 'pending') {
      throw new DomainError(
        'CONVERTER_FAILED',
        'Converter returned an async deferral ({ status: "pending" }), but the ingestion-callback path is not implemented.'
      );
    }
    const pages = raw['pages'];
    if (Array.isArray(pages)) {
      return pages
        .map((page, index) => {
          const record = isRecord(page) ? page : {};
          const text = String(record['text'] ?? '').trim();
          const rawPageNumber =
            record['page_number'] ?? record['pageNumber'] ?? index + 1;
          const pageNumber = Number(rawPageNumber);
          if (!Number.isFinite(pageNumber)) {
            throw new DomainError(
              'CONVERTER_OUTPUT_INVALID',
              `Converter page ${index} has a non-numeric page_number: ${JSON.stringify(rawPageNumber)}.`
            );
          }
          return { text, pageNumber };
        })
        .filter((page) => {
          return page.text.length > 0;
        });
    }
  }

  throw new DomainError(
    'CONVERTER_OUTPUT_INVALID',
    'Converter returned an unrecognized output shape. Expected a string, `{ pages: [{ text, page_number }] }`, or `{ status: "pending" }`.'
  );
};

const buildToolConverterInput = (args: {
  file: ConverterFile;
  rule: MappedIngestionRule;
}): Record<string, unknown> => {
  const fileInput: Record<string, unknown> = {
    id: args.file.publicId,
    filename: args.file.filename ?? null,
    content_type: args.file.contentType ?? null,
    size: args.file.size ?? null,
  };

  if (args.rule.fileDelivery === 'download_url') {
    fileInput['download_url'] = buildFileDownloadUrl({
      fileId: args.file.publicId,
    });
  } else {
    fileInput['data_base64'] = fs
      .readFileSync(args.file.storagePath)
      .toString('base64');
  }

  // `preset_parameters` merge at the top level; `file` is reserved and wins.
  return { ...(args.rule.presetParameters ?? {}), file: fileInput };
};

const invokeToolConverter = async (args: {
  file: ConverterFile;
  rule: MappedIngestionRule;
  projectId: number;
}): Promise<SourcePage[]> => {
  const input = buildToolConverterInput({ file: args.file, rule: args.rule });
  let raw: unknown;
  try {
    raw = await callTool({
      projectIds: [args.projectId],
      id: args.rule.toolId!,
      action: args.rule.action ?? undefined,
      input,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DomainError(
      'CONVERTER_FAILED',
      `Converter tool '${args.rule.toolId}' failed: ${message}`
    );
  }
  return parseConverterOutput(raw);
};

const buildAgentContentParts = (args: {
  file: ConverterFile;
}): Array<Record<string, unknown>> => {
  const contentType = args.file.contentType ?? 'application/octet-stream';
  const base64 = fs.readFileSync(args.file.storagePath).toString('base64');
  const dataUrl = `data:${contentType};base64,${base64}`;
  const filePart = contentType.startsWith('image/')
    ? { type: 'image', image: dataUrl }
    : { type: 'file', data: dataUrl, mediaType: contentType };
  return [{ type: 'text', text: EXTRACT_INSTRUCTION }, filePart];
};

const invokeAgentConverter = async (args: {
  file: ConverterFile;
  rule: MappedIngestionRule;
  projectId: number;
}): Promise<SourcePage[]> => {
  let result: Awaited<ReturnType<typeof createGeneration>>;
  try {
    result = await createGeneration({
      projectIds: [args.projectId],
      agentId: args.rule.agentId!,
      messages: [
        { role: 'user', content: buildAgentContentParts({ file: args.file }) },
      ],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new DomainError(
      'CONVERTER_FAILED',
      `Converter agent '${args.rule.agentId}' failed: ${message}`
    );
  }

  if (
    !('output' in result) ||
    !result.output ||
    typeof result.output.content !== 'string'
  ) {
    throw new DomainError(
      'CONVERTER_FAILED',
      `Converter agent '${args.rule.agentId}' did not return text output.`
    );
  }

  return parseConverterOutput(result.output.content);
};

/**
 * Runs the converter referenced by an ingestion rule against a file and returns
 * the extracted source pages. Dispatches to the agent or tool path per the
 * rule's `agentId`/`toolId` (exactly one is set — enforced at rule creation).
 */
export const invokeConverter = async (args: {
  file: ConverterFile;
  rule: MappedIngestionRule;
  projectId: number;
}): Promise<SourcePage[]> => {
  log(
    'invokeConverter: file=%s glob=%s toolId=%s agentId=%s delivery=%s',
    args.file.publicId,
    args.rule.contentTypeGlob,
    args.rule.toolId,
    args.rule.agentId,
    args.rule.fileDelivery
  );

  if (args.rule.agentId) {
    return invokeAgentConverter(args);
  }
  return invokeToolConverter(args);
};
