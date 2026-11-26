import fs from 'node:fs';
import { Readable } from 'node:stream';

declare const storageBodyBrand: unique symbol;

/**
 * Bytes on their way to a storage backend, with their exact length. A backend
 * declares the length before the first byte (S3 needs `ContentLength` to take
 * a stream), so `FileStorageProvider.write` accepts nothing else: the size is
 * stated once, by whoever produced the bytes.
 */
export type StorageBody = {
  readonly stream: Readable;
  readonly size: number;
  readonly [storageBodyBrand]: true;
};

const brand = (args: { stream: Readable; size: number }) => {
  return args as StorageBody;
};

export const bufferBody = (args: { buffer: Buffer }): StorageBody => {
  return brand({
    stream: Readable.from([args.buffer]),
    size: args.buffer.length,
  });
};

/**
 * A file on local disk, opened only when the body is read: a request refused
 * before its write (quota, authorization) holds no descriptor.
 */
export const fileBody = (args: { path: string; size: number }): StorageBody => {
  const open = async function* () {
    yield* fs.createReadStream(args.path);
  };
  return brand({ stream: Readable.from(open()), size: args.size });
};

/**
 * A request body whose `Content-Length` is `size`. HTTP framing ends the
 * stream after exactly that many bytes or fails it, so the size holds without
 * counting.
 */
export const requestBody = (args: {
  stream: Readable;
  size: number;
}): StorageBody => {
  return brand(args);
};

/**
 * The first `length` bytes of `body` (fewer when it is shorter), and a body
 * that still yields every byte: the head is read once and replayed.
 */
export const peekBody = async (args: {
  body: StorageBody;
  length: number;
}): Promise<{ head: Buffer; body: StorageBody }> => {
  const iterator: AsyncIterator<Buffer> =
    args.body.stream[Symbol.asyncIterator]();
  const chunks: Buffer[] = [];
  let read = 0;
  while (read < args.length) {
    const next = await iterator.next();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    chunks.push(chunk);
    read += chunk.length;
  }
  const replay = async function* () {
    yield* chunks;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  };
  return {
    head: Buffer.concat(chunks).subarray(0, args.length),
    body: brand({ stream: Readable.from(replay()), size: args.body.size }),
  };
};
