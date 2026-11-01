const declaredLength = (args: { response: Response }): number => {
  const declared = Number(args.response.headers.get('content-length'));
  return Number.isFinite(declared) ? declared : 0;
};

/**
 * Reads a response body of at most `maxBytes`, chunk by chunk, so an oversized
 * body is never buffered whole; a declared `Content-Length` can be absent or
 * wrong.
 *
 * `onOverflow` is required so each caller states what an oversized body is:
 * `'cut'` keeps its first `maxBytes`, a function returns the error to throw.
 */
export const readCappedBody = async (args: {
  response: Response;
  maxBytes: number;
  onOverflow: 'cut' | (() => Error);
}): Promise<Buffer> => {
  const { response, maxBytes, onOverflow } = args;
  const refusal = onOverflow === 'cut' ? null : onOverflow;

  if (refusal && declaredLength({ response }) > maxBytes) {
    await response.body?.cancel();
    throw refusal();
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      if (refusal) throw refusal();
      chunks.push(Buffer.from(value.subarray(0, room)));
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
};

/**
 * A body as text, read within `maxBytes`. A 2xx over it is refused with
 * `refusal`; any other status's body only explains the status, so it is cut.
 */
export const readCappedText = async (args: {
  response: Response;
  maxBytes: number;
  refusal: () => Error;
}): Promise<string> => {
  const body = await readCappedBody({
    response: args.response,
    maxBytes: args.maxBytes,
    onOverflow: args.response.ok ? args.refusal : 'cut',
  });
  return new TextDecoder().decode(body);
};
