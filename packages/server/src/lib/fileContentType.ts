import createDebug from 'debug';

import { peekBody, type StorageBody } from './storageBody';

const log = createDebug('soat:file-content-type');

/** Each type a model reads natively, by the bytes its files start with. */
const SIGNATURES: ReadonlyArray<{
  contentType: string;
  parts: ReadonlyArray<{ offset: number; bytes: Buffer }>;
}> = [
  {
    contentType: 'image/png',
    parts: [
      {
        offset: 0,
        bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ],
  },
  {
    contentType: 'image/jpeg',
    parts: [{ offset: 0, bytes: Buffer.from([0xff, 0xd8, 0xff]) }],
  },
  {
    contentType: 'image/gif',
    parts: [{ offset: 0, bytes: Buffer.from('GIF8') }],
  },
  {
    contentType: 'image/webp',
    parts: [
      { offset: 0, bytes: Buffer.from('RIFF') },
      { offset: 8, bytes: Buffer.from('WEBP') },
    ],
  },
  {
    contentType: 'application/pdf',
    parts: [{ offset: 0, bytes: Buffer.from('%PDF-') }],
  },
];

const HEAD_LENGTH = 12;

const sniff = (head: Buffer): string | undefined => {
  return SIGNATURES.find(({ parts }) => {
    return parts.every(({ offset, bytes }) => {
      return head.subarray(offset, offset + bytes.length).equals(bytes);
    });
  })?.contentType;
};

// `application/octet-stream` is what a client sends when it does not know.
const isUndeclared = (contentType: string | undefined): boolean => {
  return (
    !contentType ||
    contentType.split(';')[0].trim().toLowerCase() ===
      'application/octet-stream'
  );
};

/**
 * The type a stored file carries: the declared one, else the one its bytes
 * show, so a model reads it natively instead of as opaque bytes.
 */
export const resolveContentType = async (args: {
  body: StorageBody;
  contentType: string | undefined;
}): Promise<{ body: StorageBody; contentType: string | undefined }> => {
  if (!isUndeclared(args.contentType)) return args;
  const peeked = await peekBody({ body: args.body, length: HEAD_LENGTH });
  const sniffed = sniff(peeked.head);
  log('resolveContentType: declared=%s sniffed=%s', args.contentType, sniffed);
  return { body: peeked.body, contentType: sniffed ?? args.contentType };
};
