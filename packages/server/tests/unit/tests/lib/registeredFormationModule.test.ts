import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { db } from 'src/db';
import { buildRegisteredFormationModule } from 'src/lib/formation-modules/registeredFormationModule';
import type { FormationResourceTypeRegistration } from 'src/lib/formationResourceTypeConfig';
import {
  createFormation,
  deleteFormation,
  updateFormation,
} from 'src/lib/formations';
import {
  getFormationModule,
  registerFormationResourceTypes,
  unregisterFormationResourceTypes,
} from 'src/lib/formationsRegistry';
import { validateFormationTemplate } from 'src/lib/formationsValidation';
import { validateFormationTemplateAsync } from 'src/lib/formationsValidationAsync';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';

// The seam is the HTTP boundary to an operator's handler (#1078), so a real
// handler runs on localhost: the request is genuinely serialized and signed, and
// the signature verified here by independent HMAC.
//
// A `lib/` test per the keep-list rule: the protocol is reachable only from
// inside an apply, whose recorded event names neither operation nor rule.

const SECRET = 'handler-signing-secret';

type Recorded = {
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
};

/** What the fake handler answers next, per request type. */
type Reply = { status: number; body: unknown };

let server: Server;
let baseUrl: string;
let recorded: Recorded[] = [];
let replies: Partial<Record<string, Reply>> = {};
/** Delays the response, to drive the timeout path. */
let holdMs = 0;

const startHandler = async (): Promise<void> => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      const body = JSON.parse(raw) as Record<string, unknown>;
      recorded.push({ headers: req.headers, body });

      const requestType = String(body.request_type);
      const reply = replies[requestType] ?? {
        status: 200,
        body: { physical_resource_id: 'ext_default' },
      };

      const respond = () => {
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      };

      if (holdMs > 0) {
        setTimeout(respond, holdMs);
        return;
      }
      respond();
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
};

const buildRegistration = (args: {
  capabilities?: Array<'validate' | 'read'>;
  timeoutMs?: number;
  writeOnlyProperties?: string[];
}): FormationResourceTypeRegistration => {
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
      url: `${baseUrl}/formation-resources`,
      secret: SECRET,
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

/** A real project, so the `project_id` the handler receives is a real public id. */
let projectPublicId: string;
let projectId: number;

beforeAll(async () => {
  await startHandler();

  const setup = await setupProjectWithUsers({
    prefix: 'regfmod',
    policyActions: [],
    createNoPermUser: false,
  });
  projectPublicId = setup.projectId;
  const project = await db.Project.findOne({
    where: { publicId: projectPublicId },
  });
  projectId = project!.id;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      return resolve();
    });
  });
});

beforeEach(() => {
  recorded = [];
  replies = {};
  holdMs = 0;
});

// ── The handler protocol ────────────────────────────────────────────────────

describe('a registered resource type calls its handler', () => {
  test('create posts the resource and returns the physical resource id', async () => {
    replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_42', outputs: { url: 'https://x' } },
    };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });

    const physicalId = await module.create({
      properties: { name: 'Support', kind: 'whatsapp' },
      projectId,
      logicalId: 'MainChannel',
      resourceKey: 'fres_01',
    });

    expect(physicalId).toBe('chn_42');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].body).toEqual({
      request_type: 'create',
      resource_type: 'test_channel',
      logical_id: 'MainChannel',
      project_id: projectPublicId,
      properties: { name: 'Support', kind: 'whatsapp' },
    });
  });

  test('the request is signed over `<timestamp>.<body>` with the registration secret', async () => {
    replies.create = { status: 200, body: { physical_resource_id: 'chn_1' } };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });

    await module.create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
      logicalId: 'C',
      resourceKey: 'fres_01',
    });

    const header = recorded[0].headers['x-soat-signature'];
    expect(typeof header).toBe('string');
    const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(header));
    expect(match).not.toBeNull();

    // Verified independently, over the body the handler actually received.
    const [, timestamp, digest] = match as RegExpExecArray;
    const expected = crypto
      .createHmac('sha256', SECRET)
      .update(`${timestamp}.${JSON.stringify(recorded[0].body)}`)
      .digest('hex');
    expect(digest).toBe(expected);
  });

  test('an idempotency key is sent, stable per resource and operation', async () => {
    replies.create = { status: 200, body: { physical_resource_id: 'chn_1' } };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });

    const create = () => {
      return module.create({
        properties: { name: 'A', kind: 'whatsapp' },
        projectId,
        logicalId: 'C',
        resourceKey: 'fres_01',
      });
    };
    await create();
    await create();

    const keys = recorded.map((request) => {
      return request.headers['x-soat-idempotency-key'];
    });
    expect(typeof keys[0]).toBe('string');
    expect(keys[0]).toBe(keys[1]);

    // A different resource must not share the key, or a handler deduping on it
    // would answer the second create with the first resource's id.
    await module.create({
      properties: { name: 'B', kind: 'whatsapp' },
      projectId,
      logicalId: 'D',
      resourceKey: 'fres_02',
    });
    expect(recorded[2].headers['x-soat-idempotency-key']).not.toBe(keys[0]);
  });

  test('update posts the physical resource id alongside the properties', async () => {
    replies.update = { status: 200, body: { physical_resource_id: 'chn_42' } };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });

    const outcome = await module.update({
      properties: { name: 'Renamed', kind: 'whatsapp' },
      physicalResourceId: 'chn_42',
      logicalId: 'MainChannel',
      resourceKey: 'fres_01',
    });

    // Same id back — an in-place update, nothing to replace.
    expect(outcome).toBeUndefined();
    expect(recorded[0].body).toEqual({
      request_type: 'update',
      resource_type: 'test_channel',
      logical_id: 'MainChannel',
      physical_resource_id: 'chn_42',
      properties: { name: 'Renamed', kind: 'whatsapp' },
    });
  });

  test('an update answering with a different id signals a replacement', async () => {
    replies.update = { status: 200, body: { physical_resource_id: 'chn_99' } };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });

    const outcome = await module.update({
      properties: { name: 'A', kind: 'discord' },
      physicalResourceId: 'chn_42',
      logicalId: 'MainChannel',
      resourceKey: 'fres_01',
    });

    expect(outcome).toEqual({ replacedWithPhysicalResourceId: 'chn_99' });
  });

  test('delete posts the physical resource id', async () => {
    replies.delete = { status: 200, body: {} };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });

    await module.delete({
      physicalResourceId: 'chn_42',
      logicalId: 'MainChannel',
      resourceKey: 'fres_01',
    });

    expect(recorded[0].body).toEqual({
      request_type: 'delete',
      resource_type: 'test_channel',
      logical_id: 'MainChannel',
      physical_resource_id: 'chn_42',
    });
  });
});

// ── Optional capabilities ───────────────────────────────────────────────────

describe('capabilities are what the registration declares', () => {
  test('without `read`, the type declares no reader and no attributes', () => {
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });

    // `read: undefined` is how the planner learns the type is drift-exempt.
    expect(module.read).toBeUndefined();
    expect(module.getAttributes).toBeUndefined();
  });

  test('with `read`, live properties come back from the handler', async () => {
    replies.read = {
      status: 200,
      body: {
        exists: true,
        physical_resource_id: 'chn_42',
        properties: { name: 'Support', kind: 'whatsapp' },
      },
    };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({ capabilities: ['read'] }),
    });

    const properties = await module.read?.({ physicalResourceId: 'chn_42' });

    expect(properties).toEqual({ name: 'Support', kind: 'whatsapp' });
    expect(recorded[0].body.request_type).toBe('read');
  });

  test('a resource the handler says is gone reads as drift, not a failure', async () => {
    replies.read = { status: 200, body: { exists: false } };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({ capabilities: ['read'] }),
    });

    await expect(
      module.read?.({ physicalResourceId: 'chn_42' })
    ).resolves.toBeNull();
  });

  test('an unreachable handler reads as drift rather than failing the plan', async () => {
    // The same contract every built-in `read` has: a read that cannot answer
    // returns null instead of taking the whole plan down.
    const registration = buildRegistration({ capabilities: ['read'] });
    const module = buildRegisteredFormationModule({
      registration: {
        ...registration,
        handler: { ...registration.handler, url: 'http://127.0.0.1:1/nope' },
      },
    });

    await expect(
      module.read?.({ physicalResourceId: 'chn_42' })
    ).resolves.toBeNull();
  });

  test('`read` outputs resolve `ref_attr` through getAttributes', async () => {
    replies.read = {
      status: 200,
      body: {
        exists: true,
        physical_resource_id: 'chn_42',
        properties: { name: 'Support', kind: 'whatsapp' },
        outputs: { webhook_url: 'https://hook', port: 443 },
      },
    };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({ capabilities: ['read'] }),
    });

    const attributes = await module.getAttributes?.({
      physicalResourceId: 'chn_42',
    });

    // Only string-valued outputs are addressable — `ref_attr` resolves to a
    // string. A non-string is skipped, never coerced.
    expect(attributes).toEqual({ webhook_url: 'https://hook' });
  });

  test('with `validate`, handler errors join the schema errors at plan time', async () => {
    replies.validate = {
      status: 200,
      body: {
        errors: [{ path: 'properties.kind', message: 'unsupported kind' }],
      },
    };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({ capabilities: ['validate'] }),
    });

    const errors = await module.validatePropertiesAsync?.({
      properties: { name: 'A', kind: 'carrier-pigeon' },
      basePath: 'resources.<test_channel>.properties',
    });

    expect(errors).toEqual([
      { path: 'properties.kind', message: 'unsupported kind' },
    ]);
  });

  test('an empty `errors` list from the handler means valid', async () => {
    replies.validate = { status: 200, body: { errors: [] } };
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({ capabilities: ['validate'] }),
    });

    await expect(
      module.validatePropertiesAsync?.({
        properties: { name: 'A', kind: 'whatsapp' },
        basePath: 'p',
      })
    ).resolves.toEqual([]);
  });

  test('without `validate`, no handler round trip happens at plan time', () => {
    const module = buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });

    expect(module.validatePropertiesAsync).toBeUndefined();
    expect(recorded).toHaveLength(0);
  });
});

// ── Failures ────────────────────────────────────────────────────────────────

describe('handler failures fail the deploy', () => {
  const module = () => {
    return buildRegisteredFormationModule({
      registration: buildRegistration({}),
    });
  };

  const create = () => {
    return module().create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
      logicalId: 'C',
      resourceKey: 'fres_01',
    });
  };

  test('a 4xx surfaces the handler message verbatim', async () => {
    replies.create = {
      status: 422,
      body: { message: 'kind "whatsapp" needs a verified number' },
    };

    await expect(create()).rejects.toThrow(
      /kind "whatsapp" needs a verified number/
    );
  });

  test('a 5xx with no message still names the type and the status', async () => {
    replies.create = { status: 503, body: {} };

    await expect(create()).rejects.toThrow(/test_channel.*503/);
  });

  test('a 2xx create with no physical_resource_id is a protocol violation', async () => {
    // Accepting this would record a resource the engine can never address
    // again — neither update nor delete has anything to send.
    replies.create = { status: 200, body: { outputs: {} } };

    await expect(create()).rejects.toThrow(/physical_resource_id/);
  });

  test('an unreachable handler fails rather than silently succeeding', async () => {
    const registration = buildRegistration({});
    await expect(
      buildRegisteredFormationModule({
        registration: {
          ...registration,
          handler: { ...registration.handler, url: 'http://127.0.0.1:1/nope' },
        },
      }).create({
        properties: { name: 'A', kind: 'whatsapp' },
        projectId,
        logicalId: 'C',
        resourceKey: 'fres_01',
      })
    ).rejects.toThrow(/test_channel/);
  });

  test('a handler that exceeds its timeout fails the operation', async () => {
    holdMs = 200;
    const registration = buildRegistration({ timeoutMs: 50 });

    await expect(
      buildRegisteredFormationModule({ registration }).create({
        properties: { name: 'A', kind: 'whatsapp' },
        projectId,
        logicalId: 'C',
        resourceKey: 'fres_01',
      })
    ).rejects.toThrow(/timed out|test_channel/);
  });

  test('a non-JSON 2xx body is a protocol violation', async () => {
    replies.create = { status: 200, body: 'not-an-object' };

    await expect(create()).rejects.toThrow(/test_channel/);
  });
});

// ── Write-only properties ───────────────────────────────────────────────────

describe('write-only properties', () => {
  test('a registration that declares none exposes no sanitizer', () => {
    // Absent rather than a no-op: the apply pipeline branches on the key, and
    // a type with nothing to hide should store its properties verbatim.
    expect(
      buildRegisteredFormationModule({ registration: buildRegistration({}) })
        .sanitizeLastAppliedProperties
    ).toBeUndefined();
  });

  test('declared properties are stripped from the stored snapshot', () => {
    const sanitize = buildRegisteredFormationModule({
      registration: buildRegistration({ writeOnlyProperties: ['config'] }),
    }).sanitizeLastAppliedProperties;

    expect(
      sanitize?.({ name: 'A', kind: 'whatsapp', config: { token: 'sk_live' } })
    ).toEqual({ name: 'A', kind: 'whatsapp' });
  });

  test('the handler still receives the write-only value on the wire', async () => {
    // Stripping is about what is stored, never about what is sent — a create
    // that withheld the credential would provision nothing.
    replies.create = { status: 200, body: { physical_resource_id: 'chn_1' } };

    await buildRegisteredFormationModule({
      registration: buildRegistration({ writeOnlyProperties: ['config'] }),
    }).create({
      properties: { name: 'A', kind: 'whatsapp', config: { token: 'sk_live' } },
      projectId,
      logicalId: 'C',
      resourceKey: 'fres_01',
    });

    expect(recorded[0].body.properties).toEqual({
      name: 'A',
      kind: 'whatsapp',
      config: { token: 'sk_live' },
    });
  });
});

// ── Registry integration ────────────────────────────────────────────────────

describe('a registered type is declarable in a template', () => {
  const registration = () => {
    return buildRegistration({});
  };

  afterEach(() => {
    // A registry mutation must never leak into another test file
    // (`.claude/rules/tests.md` — no global singleton state).
    unregisterFormationResourceTypes({ names: ['test_channel'] });
  });

  test('template validation accepts the type and enforces its schema', () => {
    registerFormationResourceTypes({ registrations: [registration()] });

    expect(getFormationModule({ resourceType: 'test_channel' })).toBeDefined();

    const valid = validateFormationTemplate({
      resources: {
        Chan: {
          type: 'test_channel',
          properties: { name: 'Support', kind: 'whatsapp' },
        },
      },
    });
    expect(valid.errors).toEqual([]);

    const unknownField = validateFormationTemplate({
      resources: {
        Chan: {
          type: 'test_channel',
          properties: { name: 'S', kind: 'w', nope: 'x' },
        },
      },
    });
    expect(
      unknownField.errors.some((error) => {
        return error.message.includes("Unknown test_channel field 'nope'");
      })
    ).toBe(true);

    const missingRequired = validateFormationTemplate({
      resources: { Chan: { type: 'test_channel', properties: { name: 'S' } } },
    });
    expect(
      missingRequired.errors.some((error) => {
        return error.message.includes('`kind` is required');
      })
    ).toBe(true);
  });

  test('registering a name that collides with a built-in throws', () => {
    expect(() => {
      return registerFormationResourceTypes({
        registrations: [{ ...registration(), name: 'agent' }],
      });
    }).toThrow(/agent/);
  });

  test('an unregistered type is still rejected', () => {
    const result = validateFormationTemplate({
      resources: { Chan: { type: 'test_channel', properties: { name: 'S' } } },
    });
    expect(
      result.errors.some((error) => {
        return error.message.startsWith(
          'Unsupported resource type: test_channel'
        );
      })
    ).toBe(true);
  });
});

// ── Through a real deploy ───────────────────────────────────────────────────

describe('a registered type inside a real formation deploy', () => {
  beforeEach(() => {
    registerFormationResourceTypes({
      registrations: [
        buildRegistration({ capabilities: ['validate', 'read'] }),
      ],
    });
  });

  afterEach(() => {
    unregisterFormationResourceTypes({ names: ['test_channel'] });
  });

  const template = (properties: Record<string, unknown>) => {
    return { resources: { Chan: { type: 'test_channel', properties } } };
  };

  test('deploy, update in place, and tear down', async () => {
    replies.create = { status: 200, body: { physical_resource_id: 'chn_100' } };

    const created = await createFormation({
      projectId,
      name: 'registered-lifecycle',
      template: template({ name: 'Support', kind: 'whatsapp' }),
    });

    expect(created.status).toBe('active');
    expect(created.resources?.[0].physical_resource_id).toBe('chn_100');
    // The apply pipeline supplied the resource context, so the handler can
    // identify the resource it is being asked about.
    const createRequest = recorded.find((request) => {
      return request.body.request_type === 'create';
    });
    expect(createRequest?.body.logical_id).toBe('Chan');

    replies.update = { status: 200, body: { physical_resource_id: 'chn_100' } };
    const updated = await updateFormation({
      id: created.id,
      template: template({ name: 'Support Renamed', kind: 'whatsapp' }),
    });

    expect(updated.status).toBe('active');
    expect(updated.resources?.[0].physical_resource_id).toBe('chn_100');

    replies.delete = { status: 200, body: {} };
    await deleteFormation({ id: created.id });
    expect(
      recorded.some((request) => {
        return request.body.request_type === 'delete';
      })
    ).toBe(true);
  });

  test('an update answering with a new id replaces the resource', async () => {
    replies.create = { status: 200, body: { physical_resource_id: 'chn_200' } };
    const created = await createFormation({
      projectId,
      name: 'registered-replacement',
      template: template({ name: 'A', kind: 'whatsapp' }),
    });

    replies.update = { status: 200, body: { physical_resource_id: 'chn_201' } };
    replies.delete = { status: 200, body: {} };

    const updated = await updateFormation({
      id: created.id,
      template: template({ name: 'A', kind: 'discord' }),
    });

    // The record now points at the replacement…
    expect(updated.status).toBe('active');
    expect(updated.resources?.[0].physical_resource_id).toBe('chn_201');

    // …and the superseded resource was disposed of.
    const deleted = recorded.filter((request) => {
      return request.body.request_type === 'delete';
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0].body.physical_resource_id).toBe('chn_200');

    await deleteFormation({ id: created.id });
  });

  test('a failed disposal leaks the old resource but does not fail the deploy', async () => {
    replies.create = { status: 200, body: { physical_resource_id: 'chn_300' } };
    const created = await createFormation({
      projectId,
      name: 'registered-replacement-cleanup-fails',
      template: template({ name: 'A', kind: 'whatsapp' }),
    });

    replies.update = { status: 200, body: { physical_resource_id: 'chn_301' } };
    replies.delete = { status: 500, body: { message: 'cannot delete' } };

    const updated = await updateFormation({
      id: created.id,
      template: template({ name: 'A', kind: 'discord' }),
    });

    // The desired state is realised, so the deploy succeeds; the leak is
    // recorded rather than rolled back.
    expect(updated.status).toBe('active');
    expect(updated.resources?.[0].physical_resource_id).toBe('chn_301');
  });

  test('a retained resource is not disposed of when it is replaced', async () => {
    replies.create = { status: 200, body: { physical_resource_id: 'chn_400' } };
    const retained = {
      resources: {
        Chan: {
          type: 'test_channel',
          properties: { name: 'A', kind: 'whatsapp' },
          deletion_policy: 'retain' as const,
        },
      },
    };
    const created = await createFormation({
      projectId,
      name: 'registered-replacement-retain',
      template: retained,
    });

    replies.update = { status: 200, body: { physical_resource_id: 'chn_401' } };
    await updateFormation({
      id: created.id,
      template: {
        resources: {
          Chan: {
            ...retained.resources.Chan,
            properties: { name: 'A', kind: 'discord' },
          },
        },
      },
    });

    expect(
      recorded.some((request) => {
        return request.body.request_type === 'delete';
      })
    ).toBe(false);
  });

  test('a handler refusal fails the deploy with the handler message', async () => {
    replies.create = { status: 422, body: { message: 'number not verified' } };

    const created = await createFormation({
      projectId,
      name: 'registered-handler-refusal',
      template: template({ name: 'A', kind: 'whatsapp' }),
    });

    // A deploy that fails to reconcile answers with `status: failed` and the
    // reason, rather than throwing (#1028).
    expect(created.status).toBe('failed');
    expect(created.error?.message).toMatch(/number not verified/);
  });

  test('the handler validate verdict reaches the template validator', async () => {
    replies.validate = {
      status: 200,
      body: { errors: [{ path: 'properties.kind', message: 'bad kind' }] },
    };

    const result = await validateFormationTemplateAsync(
      template({ name: 'A', kind: 'carrier-pigeon' })
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toEqual([
      { path: 'properties.kind', message: 'bad kind' },
    ]);
  });

  test('a template that fails locally never reaches the handler', async () => {
    const result = await validateFormationTemplateAsync(
      template({ name: 'A' }) // `kind` is required by the registration schema
    );

    expect(result.valid).toBe(false);
    expect(
      recorded.some((request) => {
        return request.body.request_type === 'validate';
      })
    ).toBe(false);
  });

  test('a valid template with no handler objection passes', async () => {
    replies.validate = { status: 200, body: { errors: [] } };

    const result = await validateFormationTemplateAsync(
      template({ name: 'A', kind: 'whatsapp' })
    );

    expect(result.valid).toBe(true);
  });

  test('a template of built-in types alone makes no handler call', async () => {
    const result = await validateFormationTemplateAsync({
      resources: { Mem: { type: 'memory', properties: { name: 'M' } } },
    });

    expect(result.valid).toBe(true);
    expect(recorded).toHaveLength(0);
  });
});

// ── Contract edges ──────────────────────────────────────────────────────────

describe('the module contract holds for a direct caller too', () => {
  const module = () => {
    return buildRegisteredFormationModule({
      registration: buildRegistration({ capabilities: ['read'] }),
    });
  };

  test('a non-object properties bag is rejected by name', () => {
    const errors = module().validateProperties?.({
      properties: 'not-an-object',
      basePath: 'resources.Chan.properties',
    });

    expect(errors).toEqual([
      {
        path: 'resources.Chan.properties',
        message: 'test_channel `properties` must be an object',
      },
    ]);
  });

  test('the resource context is optional on every write', async () => {
    // The apply pipeline always supplies it; a direct lib caller need not, and
    // the handler still gets a well-formed request.
    replies.create = { status: 200, body: { physical_resource_id: 'chn_500' } };
    replies.update = { status: 200, body: { physical_resource_id: 'chn_500' } };
    replies.delete = { status: 200, body: {} };
    const built = module();

    await built.create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
    });
    await built.update({
      properties: { name: 'B', kind: 'whatsapp' },
      physicalResourceId: 'chn_500',
    });
    await built.delete({ physicalResourceId: 'chn_500' });

    expect(
      recorded.map((request) => {
        return request.body.logical_id;
      })
    ).toEqual(['', '', '']);
    // Without a resource key the idempotency anchor falls back to something
    // stable that is still available — the physical id, on update and delete.
    for (const request of recorded) {
      expect(typeof request.headers['x-soat-idempotency-key']).toBe('string');
    }
  });

  test('create without a logical id still anchors its idempotency key', async () => {
    replies.create = { status: 200, body: { physical_resource_id: 'chn_600' } };
    const built = module();

    await built.create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
      logicalId: 'OnlyLogicalId',
    });

    expect(recorded[0].body.logical_id).toBe('OnlyLogicalId');
    expect(typeof recorded[0].headers['x-soat-idempotency-key']).toBe('string');
  });

  test('a read answering without an outputs bag yields no attributes', async () => {
    replies.read = {
      status: 200,
      body: { exists: true, physical_resource_id: 'chn_1', properties: {} },
    };

    await expect(
      module().getAttributes?.({ physicalResourceId: 'chn_1' })
    ).resolves.toEqual({});
  });

  test('a read answering with a non-object properties bag reads as gone', async () => {
    replies.read = {
      status: 200,
      body: { exists: true, physical_resource_id: 'chn_1', properties: 'nope' },
    };

    await expect(
      module().read?.({ physicalResourceId: 'chn_1' })
    ).resolves.toBeNull();
  });

  test('malformed handler validation entries are skipped, not crashed on', async () => {
    replies.validate = {
      status: 200,
      body: {
        errors: [
          'not-an-object',
          { path: 'p' },
          { message: 'the only usable one' },
        ],
      },
    };

    await expect(
      buildRegisteredFormationModule({
        registration: buildRegistration({ capabilities: ['validate'] }),
      }).validatePropertiesAsync?.({
        properties: { name: 'A', kind: 'whatsapp' },
        basePath: 'p',
      })
    ).resolves.toEqual([{ path: '', message: 'the only usable one' }]);
  });

  test('a handler validate answer with no errors list is treated as valid', async () => {
    replies.validate = { status: 200, body: {} };

    await expect(
      buildRegisteredFormationModule({
        registration: buildRegistration({ capabilities: ['validate'] }),
      }).validatePropertiesAsync?.({
        properties: { name: 'A', kind: 'whatsapp' },
        basePath: 'p',
      })
    ).resolves.toEqual([]);
  });

  test('a validate call against a non-object bag still reaches the handler', async () => {
    replies.validate = { status: 200, body: { errors: [] } };

    await buildRegisteredFormationModule({
      registration: buildRegistration({ capabilities: ['validate'] }),
    }).validatePropertiesAsync?.({ properties: 'nope', basePath: 'p' });

    expect(recorded[0].body.properties).toEqual({});
  });
});
