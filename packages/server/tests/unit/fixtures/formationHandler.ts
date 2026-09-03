/**
 * A real HTTP handler for an operator-registered formation resource type
 * (#1078), on localhost.
 *
 * The seam under test is the HTTP boundary, so the request is genuinely
 * serialized and signed and the signature is verifiable by independent HMAC —
 * a fake at the module level would test nothing of the protocol.
 */

import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FormationResourceTypeRegistration } from 'src/lib/formationResourceTypeConfig';

export const HANDLER_SECRET = 'handler-signing-secret';

export type Recorded = {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
};

/** What the handler answers next, per request type. */
export type Reply = { status: number; body: unknown };

/**
 * A reply may be computed from the request, so one deploy can answer a
 * replacement for one resource and an in-place update for another.
 */
export type ReplyFor = Reply | ((request: Record<string, unknown>) => Reply);

export type FakeFormationHandler = {
  baseUrl: string;
  /** Every request the handler received, oldest first. */
  recorded: Recorded[];
  replies: Partial<Record<string, ReplyFor>>;
  /** Delays the response, to drive the timeout path. */
  holdMs: number;
  /** A registration for the `test_channel` type, pointed at this handler. */
  registration: (args: {
    capabilities?: Array<'validate' | 'read'>;
    timeoutMs?: number;
    writeOnlyProperties?: string[];
  }) => FormationResourceTypeRegistration;
  reset: () => void;
  close: () => Promise<void>;
};

const buildRegistration = (args: {
  baseUrl: string;
  capabilities?: Array<'validate' | 'read'>;
  timeoutMs?: number;
  writeOnlyProperties?: string[];
}): FormationResourceTypeRegistration => {
  // Held in a variable rather than inlined: as a literal in the return, `type`
  // trips the excess-property check against `SchemaWithProperties`.
  const schema = {
    type: 'object',
    properties: {
      name: { type: 'string' },
      kind: { type: 'string' },
      agent_id: { type: 'string' },
      config: { type: 'object' },
    },
    required: ['name', 'kind'],
  };

  return {
    name: 'test_channel',
    description: 'A test channel.',
    handler: {
      url: `${args.baseUrl}/formation-resources`,
      secret: HANDLER_SECRET,
      timeoutMs: args.timeoutMs ?? 5_000,
    },
    capabilities: new Set(args.capabilities ?? []),
    writeOnlyProperties: new Set(args.writeOnlyProperties ?? []),
    schema,
    schemaFields: {
      allowedFields: new Set(['name', 'kind', 'agent_id', 'config']),
      requiredFields: new Set(['name', 'kind']),
      fieldSpecs: {
        name: { type: 'string', nullable: false },
        kind: { type: 'string', nullable: false },
        agent_id: { type: 'string', nullable: false },
        config: { type: 'object', nullable: false },
      },
    },
  };
};

const listenerFor = (handler: FakeFormationHandler): RequestListener => {
  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const body = JSON.parse(raw) as Record<string, unknown>;
      handler.recorded.push({ headers: req.headers, body });

      const configured = handler.replies[String(body.request_type)];
      const reply =
        typeof configured === 'function'
          ? configured(body)
          : (configured ?? {
              status: 200,
              body: { physical_resource_id: 'ext_default' },
            });

      const respond = () => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      };

      if (handler.holdMs > 0) {
        setTimeout(respond, handler.holdMs);
        return;
      }
      respond();
    });
  };
};

export const startFakeFormationHandler =
  async (): Promise<FakeFormationHandler> => {
    const handler: FakeFormationHandler = {
      baseUrl: '',
      recorded: [],
      replies: {},
      holdMs: 0,
      registration: (args) => {
        return buildRegistration({ ...args, baseUrl: handler.baseUrl });
      },
      reset: () => {
        handler.recorded.length = 0;
        handler.replies = {};
        handler.holdMs = 0;
      },
      close: async () => {
        return;
      },
    };

    const server = createServer(listenerFor(handler));
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });

    const { port } = server.address() as AddressInfo;
    handler.baseUrl = `http://127.0.0.1:${String(port)}`;
    handler.close = async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          return resolve();
        });
      });
    };

    return handler;
  };

/**
 * The physical ids the handler was asked to delete, in the order the requests
 * arrived — the observable that says when a disposal ran relative to the
 * updates around it.
 */
export const deletedPhysicalIds = (
  handler: FakeFormationHandler
): unknown[] => {
  return handler.recorded
    .filter((request) => {
      return request.body.request_type === 'delete';
    })
    .map((request) => {
      return request.body.physical_resource_id;
    });
};
