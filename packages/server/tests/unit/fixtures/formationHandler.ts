/**
 * A real HTTP handler for an operator-registered formation resource type, on
 * localhost.
 *
 * The seam under test is the HTTP boundary, so the request is genuinely
 * serialized and signed and the signature is verifiable by independent HMAC —
 * a fake at the module level would test nothing of the protocol.
 */

import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { FormationResourceTypeRegistration } from 'src/lib/formationResourceTypeConfig';
import {
  registerIamModules,
  unregisterIamModules,
} from 'src/lib/iamRegistrations';

export const HANDLER_SECRET = 'handler-signing-secret';

/** The IAM module the `test_channel` type's `writer` declares its actions in. */
export const TEST_CHANNEL_ACTIONS = [
  'test-channels:CreateTestChannel',
  'test-channels:UpdateTestChannel',
  'test-channels:DeleteTestChannel',
];

export type Recorded = {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
};

/**
 * What the handler answers next, per request type. `stall` sends the head and
 * part of the body, then never finishes it.
 */
export type Reply = { status: number; body: unknown; stall?: boolean };

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
    overridesBuiltin: false,
    handler: {
      url: `${args.baseUrl}/formation-resources`,
      secret: HANDLER_SECRET,
      timeoutMs: args.timeoutMs ?? 5_000,
    },
    capabilities: new Set(args.capabilities ?? []),
    writeOnlyProperties: new Set(args.writeOnlyProperties ?? []),
    writer: {
      resourceType: 'test_channel',
      actions: {
        create: 'test-channels:CreateTestChannel',
        update: 'test-channels:UpdateTestChannel',
        delete: 'test-channels:DeleteTestChannel',
      },
      carries: [
        {
          property: 'agent_id',
          action: 'agents:CreateAgentGeneration',
          resourceType: 'agent',
        },
      ],
    },
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
        const text = JSON.stringify(reply.body);
        if (reply.stall) {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.write(text.slice(0, 1));
          return;
        }
        res.writeHead(reply.status, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        });
        res.end(text);
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
    registerIamModules({
      registrations: [
        {
          module: 'test-channels',
          resourceTypes: new Set(['test_channel']),
          projectGroupActions: new Map(),
          actions: new Map(
            TEST_CHANNEL_ACTIONS.map((action) => {
              return [action, ''];
            })
          ),
        },
      ],
    });
    handler.close = async () => {
      unregisterIamModules({ modules: ['test-channels'] });
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
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
