import type { IncomingMessage } from 'node:http';

/** The whole body of a request a test server received, as UTF-8 text. */
export const readRequestBody = (req: IncomingMessage): Promise<string> => {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
};
