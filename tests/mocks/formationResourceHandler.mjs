/**
 * A minimal formation resource-type handler, for the smoke suite.
 *
 * It stands in for what a deployment operator would run behind
 * `FORMATION_RESOURCE_TYPES_CONFIG` (see the Formations module docs): a service
 * that owns the create/update/delete of a resource SOAT knows nothing about,
 * while SOAT keeps the deploy engine.
 *
 * Resources live in memory in a Map — the point of the smoke step is the
 * protocol (is it called, is it signed, does the id come back and get recorded,
 * does teardown reach it), not the storage.
 *
 * Configuration:
 *   PORT                          port to listen on (default 50480)
 *   FORMATION_HANDLER_SECRET      the shared secret; when set, every request's
 *                                 signature is verified and a bad one is a 401
 *   SIGNATURE_MAX_AGE_SECONDS     replay window (default 300)
 */

import crypto from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT ?? 50480);
const SECRET = process.env.FORMATION_HANDLER_SECRET ?? '';
const MAX_AGE_SECONDS = Number(process.env.SIGNATURE_MAX_AGE_SECONDS ?? 300);

const HANDLER_URL = `http://formation-handler:${PORT}/formation-resources`;

/** physical_resource_id -> properties */
const resources = new Map();
let counter = 0;

/**
 * Verifies `t=<unix>,v1=<hex>` over `<t>.<rawBody>`.
 *
 * Over the **raw** bytes, never a re-encoded parse of them: re-serializing a
 * parsed body can change it (key order, number formatting) and the digest
 * would stop matching for reasons that have nothing to do with authenticity.
 */
const verifySignature = (header, rawBody) => {
  if (!SECRET) return true;
  if (typeof header !== 'string') return false;

  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header);
  if (!match) return false;

  const [, timestamp, digest] = match;
  const age = Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp));
  if (age > MAX_AGE_SECONDS) return false;

  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');

  const given = Buffer.from(digest, 'hex');
  const want = Buffer.from(expected, 'hex');
  return given.length === want.length && crypto.timingSafeEqual(given, want);
};

/** Drops the write-only property the registration declares. */
const withoutCredential = (properties) => {
  const { access_token: _dropped, ...rest } = properties;
  return rest;
};

const handle = (body) => {
  const { request_type: requestType, properties } = body;
  const physicalResourceId = body.physical_resource_id;

  switch (requestType) {
    case 'validate': {
      // The check a JSON Schema cannot express: which kinds this service knows.
      const kind = properties?.kind;
      const errors =
        kind && !['whatsapp', 'discord'].includes(kind)
          ? [
              {
                path: 'properties.kind',
                message: `unsupported kind '${kind}'`,
              },
            ]
          : [];
      return { status: 200, body: { errors } };
    }

    case 'create': {
      counter += 1;
      const id = `chan_smoke_${counter}`;
      // The credential is used and dropped, never echoed back on `read` — a
      // handler that returned it would put it straight back into the drift
      // comparison the engine strips it from.
      resources.set(id, withoutCredential(properties ?? {}));
      return {
        status: 200,
        body: { physical_resource_id: id, outputs: { handler_url: HANDLER_URL } },
      };
    }

    case 'update': {
      if (!resources.has(physicalResourceId)) {
        return { status: 404, body: { message: `no such channel: ${physicalResourceId}` } };
      }
      resources.set(physicalResourceId, withoutCredential(properties ?? {}));
      return { status: 200, body: { physical_resource_id: physicalResourceId } };
    }

    case 'delete': {
      // Idempotent by contract: deleting an already-gone resource is a 2xx.
      resources.delete(physicalResourceId);
      return { status: 200, body: {} };
    }

    case 'read': {
      const stored = resources.get(physicalResourceId);
      if (!stored) return { status: 200, body: { exists: false } };
      return {
        status: 200,
        body: {
          exists: true,
          physical_resource_id: physicalResourceId,
          properties: stored,
          outputs: { handler_url: HANDLER_URL },
        },
      };
    }

    default:
      return {
        status: 400,
        body: { message: `unknown request_type: ${requestType}` },
      };
  }
};

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => {
    return chunks.push(chunk);
  });
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf-8');

    if (!verifySignature(req.headers['x-soat-signature'], raw)) {
      console.log('[formation-handler] REJECTED — bad or missing signature');
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"message":"invalid signature"}');
      return;
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end('{"message":"body was not JSON"}');
      return;
    }

    const reply = handle(body);
    console.log(
      `[formation-handler] ${body.request_type} logical_id=${body.logical_id ?? '-'} ` +
        `idempotency=${req.headers['x-soat-idempotency-key'] ?? '-'} -> ${reply.status}`
    );
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});

server.listen(PORT, () => {
  console.log(`[formation-handler] listening on ${PORT}`);
});
