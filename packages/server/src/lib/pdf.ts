import createDebug from 'debug';
import { extractText, getDocumentProxy } from 'unpdf';

import { DomainError } from '../errors';

const log = createDebug('soat:pdf');

export const extractPdfPages = async (args: {
  buffer: Buffer;
}): Promise<string[]> => {
  log('extractPdfPages: parsing PDF buffer size=%d', args.buffer.length);

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

/** The text of each page, or null when the bytes are not a readable PDF. */
export const readPdfPages = async (args: {
  buffer: Buffer;
}): Promise<string[] | null> => {
  log('readPdfPages: parsing PDF buffer size=%d', args.buffer.length);
  try {
    const { text: pages } = await extractText(new Uint8Array(args.buffer), {
      mergePages: false,
    });
    return pages;
  } catch (error) {
    log('readPdfPages: unreadable %o', error);
    return null;
  }
};

/** The page count of a PDF; the bytes are copied, as the parser detaches them. */
export const countPdfPages = async (args: {
  bytes: Uint8Array;
}): Promise<number> => {
  try {
    const document = await getDocumentProxy(new Uint8Array(args.bytes));
    return document.numPages;
  } catch (error) {
    throw new DomainError(
      'PDF_PARSE_FAILED',
      `Failed to parse PDF: ${(error as Error).message}`
    );
  }
};
