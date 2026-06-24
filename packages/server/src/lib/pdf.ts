import createDebug from 'debug';

import { DomainError } from '../errors';

const log = createDebug('soat:pdf');

export const extractPdfPages = async (args: {
  buffer: Buffer;
}): Promise<string[]> => {
  log('extractPdfPages: parsing PDF buffer size=%d', args.buffer.length);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let extractText: (...args: any[]) => Promise<{ text: string[] }>;

  try {
    ({ extractText } = await import('unpdf'));
  } catch (error) {
    throw new DomainError(
      'PDF_PARSE_FAILED',
      `Failed to load PDF parser: ${(error as Error).message}`
    );
  }

  try {
    const { text: pages } = await extractText(new Uint8Array(args.buffer), {
      mergePages: false,
    });

    log('extractPdfPages: extracted %d pages', pages.length);
    return pages;
  } catch (error) {
    throw new DomainError(
      'PDF_PARSE_FAILED',
      `Failed to parse PDF: ${(error as Error).message}`
    );
  }
};
