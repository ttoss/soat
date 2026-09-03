import crypto from 'node:crypto';

import { db } from 'src/db';
import { buildRegisteredFormationModule } from 'src/lib/formation-modules/registeredFormationModule';
import {
  createFormation,
  deleteFormation,
  type FormationAuthorizer,
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
import {
  type FakeFormationHandler,
  HANDLER_SECRET,
  startFakeFormationHandler,
} from '../../fixtures/formationHandler';

// An operator-registered type has no SOAT action to authorize (#1181), so the
// deploy path must never consult the authorizer for one.
const neverAsked: FormationAuthorizer = (request) => {
  throw new Error(
    `unexpected authorization request for ${request.resourceType}`
  );
};

// The seam is the HTTP boundary to an operator's handler (#1078), so a real
// handler runs on localhost: the request is genuinely serialized and signed, and
// the signature verified here by independent HMAC.
//
// A `lib/` test per the keep-list rule: the protocol is reachable only from
// inside an apply, whose recorded event names neither operation nor rule.

let handler: FakeFormationHandler;

/** A real project, so the `project_id` the handler receives is a real public id. */
let projectPublicId: string;
let projectId: number;
let actingUserId: number;

beforeAll(async () => {
  handler = await startFakeFormationHandler();

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

  const user = await db.User.findOne({ where: { publicId: setup.userId } });
  actingUserId = user!.id as number;
});

afterAll(async () => {
  await handler.close();
});

beforeEach(() => {
  handler.reset();
});

// ── The handler protocol ────────────────────────────────────────────────────

describe('a registered resource type calls its handler', () => {
  test('create posts the resource and returns the physical resource id', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_42', outputs: { url: 'https://x' } },
    };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({}),
    });

    const physicalId = await module.create({
      properties: { name: 'Support', kind: 'whatsapp' },
      projectId,
      actingUserId,
      logicalId: 'MainChannel',
      resourceKey: 'fres_01',
    });

    expect(physicalId).toBe('chn_42');
    expect(handler.recorded).toHaveLength(1);
    expect(handler.recorded[0].body).toEqual({
      request_type: 'create',
      resource_type: 'test_channel',
      logical_id: 'MainChannel',
      project_id: projectPublicId,
      properties: { name: 'Support', kind: 'whatsapp' },
    });
  });

  test('the request is signed over `<timestamp>.<body>` with the registration secret', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_1' },
    };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({}),
    });

    await module.create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
      actingUserId,
      logicalId: 'C',
      resourceKey: 'fres_01',
    });

    const header = handler.recorded[0].headers['x-soat-signature'];
    expect(typeof header).toBe('string');
    const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(String(header));
    expect(match).not.toBeNull();

    // Verified independently, over the body the handler actually received.
    const [, timestamp, digest] = match as RegExpExecArray;
    const expected = crypto
      .createHmac('sha256', HANDLER_SECRET)
      .update(`${timestamp}.${JSON.stringify(handler.recorded[0].body)}`)
      .digest('hex');
    expect(digest).toBe(expected);
  });

  test('an idempotency key is sent, stable per resource and operation', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_1' },
    };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({}),
    });

    const create = () => {
      return module.create({
        properties: { name: 'A', kind: 'whatsapp' },
        projectId,
        actingUserId,
        logicalId: 'C',
        resourceKey: 'fres_01',
      });
    };
    await create();
    await create();

    const keys = handler.recorded.map((request) => {
      return request.headers['x-soat-idempotency-key'];
    });
    expect(typeof keys[0]).toBe('string');
    expect(keys[0]).toBe(keys[1]);

    // A different resource must not share the key, or a handler deduping on it
    // would answer the second create with the first resource's id.
    await module.create({
      properties: { name: 'B', kind: 'whatsapp' },
      projectId,
      actingUserId,
      logicalId: 'D',
      resourceKey: 'fres_02',
    });
    expect(handler.recorded[2].headers['x-soat-idempotency-key']).not.toBe(
      keys[0]
    );
  });

  test('update posts the physical resource id alongside the properties', async () => {
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_42' },
    };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({}),
    });

    const outcome = await module.update({
      properties: { name: 'Renamed', kind: 'whatsapp' },
      physicalResourceId: 'chn_42',
      projectId,
      actingUserId,
      logicalId: 'MainChannel',
      resourceKey: 'fres_01',
    });

    // Same id back — an in-place update, nothing to replace.
    expect(outcome).toBeUndefined();
    expect(handler.recorded[0].body).toEqual({
      request_type: 'update',
      resource_type: 'test_channel',
      logical_id: 'MainChannel',
      project_id: projectPublicId,
      physical_resource_id: 'chn_42',
      properties: { name: 'Renamed', kind: 'whatsapp' },
    });
  });

  test('an update answering with a different id signals a replacement', async () => {
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_99' },
    };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({}),
    });

    const outcome = await module.update({
      properties: { name: 'A', kind: 'discord' },
      physicalResourceId: 'chn_42',
      projectId,
      actingUserId,
      logicalId: 'MainChannel',
      resourceKey: 'fres_01',
    });

    expect(outcome).toEqual({ replacedWithPhysicalResourceId: 'chn_99' });
  });

  test('delete posts the physical resource id', async () => {
    handler.replies.delete = { status: 200, body: {} };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({}),
    });

    await module.delete({
      physicalResourceId: 'chn_42',
      projectId,
      actingUserId,
      logicalId: 'MainChannel',
      resourceKey: 'fres_01',
    });

    expect(handler.recorded[0].body).toEqual({
      request_type: 'delete',
      resource_type: 'test_channel',
      logical_id: 'MainChannel',
      project_id: projectPublicId,
      physical_resource_id: 'chn_42',
    });
  });
});

// ── Optional capabilities ───────────────────────────────────────────────────

describe('capabilities are what the registration declares', () => {
  test('without `read`, the type declares no reader and no attributes', () => {
    const module = buildRegisteredFormationModule({
      registration: handler.registration({}),
    });

    // `read: undefined` is how the planner learns the type is drift-exempt.
    expect(module.read).toBeUndefined();
    expect(module.getAttributes).toBeUndefined();
  });

  test('with `read`, live properties come back from the handler', async () => {
    handler.replies.read = {
      status: 200,
      body: {
        exists: true,
        physical_resource_id: 'chn_42',
        properties: { name: 'Support', kind: 'whatsapp' },
      },
    };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({ capabilities: ['read'] }),
    });

    const properties = await module.read?.({
      physicalResourceId: 'chn_42',
      projectId,
    });

    expect(properties).toEqual({ name: 'Support', kind: 'whatsapp' });
    expect(handler.recorded[0].body.request_type).toBe('read');
    expect(handler.recorded[0].body.project_id).toBe(projectPublicId);
  });

  test('a resource the handler says is gone reads as drift, not a failure', async () => {
    handler.replies.read = { status: 200, body: { exists: false } };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({ capabilities: ['read'] }),
    });

    await expect(
      module.read?.({ physicalResourceId: 'chn_42', projectId })
    ).resolves.toBeNull();
  });

  test('an unreachable handler reads as drift rather than failing the plan', async () => {
    // The same contract every built-in `read` has: a read that cannot answer
    // returns null instead of taking the whole plan down.
    const registration = handler.registration({ capabilities: ['read'] });
    const module = buildRegisteredFormationModule({
      registration: {
        ...registration,
        handler: { ...registration.handler, url: 'http://127.0.0.1:1/nope' },
      },
    });

    await expect(
      module.read?.({ physicalResourceId: 'chn_42', projectId })
    ).resolves.toBeNull();
  });

  test('`read` outputs resolve `ref_attr` through getAttributes', async () => {
    handler.replies.read = {
      status: 200,
      body: {
        exists: true,
        physical_resource_id: 'chn_42',
        properties: { name: 'Support', kind: 'whatsapp' },
        outputs: { webhook_url: 'https://hook', port: 443 },
      },
    };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({ capabilities: ['read'] }),
    });

    const attributes = await module.getAttributes?.({
      physicalResourceId: 'chn_42',
      projectId,
    });

    expect(handler.recorded[0].body.project_id).toBe(projectPublicId);

    // Only string-valued outputs are addressable — `ref_attr` resolves to a
    // string. A non-string is skipped, never coerced.
    expect(attributes).toEqual({ webhook_url: 'https://hook' });
  });

  test('with `validate`, handler errors join the schema errors at plan time', async () => {
    handler.replies.validate = {
      status: 200,
      body: {
        errors: [{ path: 'properties.kind', message: 'unsupported kind' }],
      },
    };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({ capabilities: ['validate'] }),
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
    handler.replies.validate = { status: 200, body: { errors: [] } };
    const module = buildRegisteredFormationModule({
      registration: handler.registration({ capabilities: ['validate'] }),
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
      registration: handler.registration({}),
    });

    expect(module.validatePropertiesAsync).toBeUndefined();
    expect(handler.recorded).toHaveLength(0);
  });
});

// ── Failures ────────────────────────────────────────────────────────────────

describe('handler failures fail the deploy', () => {
  const module = () => {
    return buildRegisteredFormationModule({
      registration: handler.registration({}),
    });
  };

  const create = () => {
    return module().create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
      actingUserId,
      logicalId: 'C',
      resourceKey: 'fres_01',
    });
  };

  test('a 4xx surfaces the handler message verbatim', async () => {
    handler.replies.create = {
      status: 422,
      body: { message: 'kind "whatsapp" needs a verified number' },
    };

    await expect(create()).rejects.toThrow(
      /kind "whatsapp" needs a verified number/
    );
  });

  test('a 5xx with no message still names the type and the status', async () => {
    handler.replies.create = { status: 503, body: {} };

    await expect(create()).rejects.toThrow(/test_channel.*503/);
  });

  test('a 2xx create with no physical_resource_id is a protocol violation', async () => {
    // Accepting this would record a resource the engine can never address
    // again — neither update nor delete has anything to send.
    handler.replies.create = { status: 200, body: { outputs: {} } };

    await expect(create()).rejects.toThrow(/physical_resource_id/);
  });

  test('an unreachable handler fails rather than silently succeeding', async () => {
    const registration = handler.registration({});
    await expect(
      buildRegisteredFormationModule({
        registration: {
          ...registration,
          handler: { ...registration.handler, url: 'http://127.0.0.1:1/nope' },
        },
      }).create({
        properties: { name: 'A', kind: 'whatsapp' },
        projectId,
        actingUserId,
        logicalId: 'C',
        resourceKey: 'fres_01',
      })
    ).rejects.toThrow(/test_channel/);
  });

  test('a handler that exceeds its timeout fails the operation', async () => {
    handler.holdMs = 200;
    const registration = handler.registration({ timeoutMs: 50 });

    await expect(
      buildRegisteredFormationModule({ registration }).create({
        properties: { name: 'A', kind: 'whatsapp' },
        projectId,
        actingUserId,
        logicalId: 'C',
        resourceKey: 'fres_01',
      })
    ).rejects.toThrow(/timed out|test_channel/);
  });

  test('a non-JSON 2xx body is a protocol violation', async () => {
    handler.replies.create = { status: 200, body: 'not-an-object' };

    await expect(create()).rejects.toThrow(/test_channel/);
  });
});

// ── Write-only properties ───────────────────────────────────────────────────

describe('write-only properties', () => {
  test('a registration that declares none exposes no sanitizer', () => {
    // Absent rather than a no-op: the apply pipeline branches on the key, and
    // a type with nothing to hide should store its properties verbatim.
    expect(
      buildRegisteredFormationModule({ registration: handler.registration({}) })
        .sanitizeLastAppliedProperties
    ).toBeUndefined();
  });

  test('declared properties are stripped from the stored snapshot', () => {
    const sanitize = buildRegisteredFormationModule({
      registration: handler.registration({ writeOnlyProperties: ['config'] }),
    }).sanitizeLastAppliedProperties;

    expect(
      sanitize?.({ name: 'A', kind: 'whatsapp', config: { token: 'sk_live' } })
    ).toEqual({ name: 'A', kind: 'whatsapp' });
  });

  test('the handler still receives the write-only value on the wire', async () => {
    // Stripping is about what is stored, never about what is sent — a create
    // that withheld the credential would provision nothing.
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_1' },
    };

    await buildRegisteredFormationModule({
      registration: handler.registration({ writeOnlyProperties: ['config'] }),
    }).create({
      properties: { name: 'A', kind: 'whatsapp', config: { token: 'sk_live' } },
      projectId,
      actingUserId,
      logicalId: 'C',
      resourceKey: 'fres_01',
    });

    expect(handler.recorded[0].body.properties).toEqual({
      name: 'A',
      kind: 'whatsapp',
      config: { token: 'sk_live' },
    });
  });
});

// ── Registry integration ────────────────────────────────────────────────────

describe('a registered type is declarable in a template', () => {
  const registration = () => {
    return handler.registration({});
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
        handler.registration({ capabilities: ['validate', 'read'] }),
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
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_100' },
    };

    const created = await createFormation({
      authorize: neverAsked,
      actingUserId,
      projectId,
      name: 'registered-lifecycle',
      template: template({ name: 'Support', kind: 'whatsapp' }),
    });

    expect(created.status).toBe('active');
    expect(created.resources?.[0].physical_resource_id).toBe('chn_100');
    // The apply pipeline supplied the resource context, so the handler can
    // identify the resource it is being asked about.
    const createRequest = handler.recorded.find((request) => {
      return request.body.request_type === 'create';
    });
    expect(createRequest?.body.logical_id).toBe('Chan');

    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_100' },
    };
    const updated = await updateFormation({
      authorize: neverAsked,
      actingUserId,
      id: created.id,
      template: template({ name: 'Support Renamed', kind: 'whatsapp' }),
    });

    expect(updated.status).toBe('active');
    expect(updated.resources?.[0].physical_resource_id).toBe('chn_100');

    handler.replies.delete = { status: 200, body: {} };
    await deleteFormation({
      id: created.id,
      authorize: neverAsked,
      actingUserId,
    });
    expect(
      handler.recorded.some((request) => {
        return request.body.request_type === 'delete';
      })
    ).toBe(true);
  });

  test('a retained resource is not disposed of when it is replaced', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_400' },
    };
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
      authorize: neverAsked,
      actingUserId,
      projectId,
      name: 'registered-replacement-retain',
      template: retained,
    });

    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_401' },
    };
    await updateFormation({
      authorize: neverAsked,
      actingUserId,
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
      handler.recorded.some((request) => {
        return request.body.request_type === 'delete';
      })
    ).toBe(false);
  });

  test('a handler refusal fails the deploy with the handler message', async () => {
    handler.replies.create = {
      status: 422,
      body: { message: 'number not verified' },
    };

    const created = await createFormation({
      authorize: neverAsked,
      actingUserId,
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
    handler.replies.validate = {
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
      handler.recorded.some((request) => {
        return request.body.request_type === 'validate';
      })
    ).toBe(false);
  });

  test('a valid template with no handler objection passes', async () => {
    handler.replies.validate = { status: 200, body: { errors: [] } };

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
    expect(handler.recorded).toHaveLength(0);
  });
});

// ── Contract edges ──────────────────────────────────────────────────────────

describe('the module contract holds for a direct caller too', () => {
  const module = () => {
    return buildRegisteredFormationModule({
      registration: handler.registration({ capabilities: ['read'] }),
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
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_500' },
    };
    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_500' },
    };
    handler.replies.delete = { status: 200, body: {} };
    const built = module();

    await built.create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
      actingUserId,
    });
    await built.update({
      projectId,
      actingUserId,
      properties: { name: 'B', kind: 'whatsapp' },
      physicalResourceId: 'chn_500',
    });
    await built.delete({
      projectId,
      actingUserId,
      physicalResourceId: 'chn_500',
    });

    expect(
      handler.recorded.map((request) => {
        return request.body.logical_id;
      })
    ).toEqual(['', '', '']);
    // Without a resource key the idempotency anchor falls back to something
    // stable that is still available — the physical id, on update and delete.
    for (const request of handler.recorded) {
      expect(typeof request.headers['x-soat-idempotency-key']).toBe('string');
    }
  });

  test('create without a logical id still anchors its idempotency key', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_600' },
    };
    const built = module();

    await built.create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
      actingUserId,
      logicalId: 'OnlyLogicalId',
    });

    expect(handler.recorded[0].body.logical_id).toBe('OnlyLogicalId');
    expect(typeof handler.recorded[0].headers['x-soat-idempotency-key']).toBe(
      'string'
    );
  });

  test('a read answering without an outputs bag yields no attributes', async () => {
    handler.replies.read = {
      status: 200,
      body: { exists: true, physical_resource_id: 'chn_1', properties: {} },
    };

    await expect(
      module().getAttributes?.({
        projectId,
        physicalResourceId: 'chn_1',
      })
    ).resolves.toEqual({});
  });

  test('a read answering with a non-object properties bag reads as gone', async () => {
    handler.replies.read = {
      status: 200,
      body: { exists: true, physical_resource_id: 'chn_1', properties: 'nope' },
    };

    await expect(
      module().read?.({
        projectId,
        physicalResourceId: 'chn_1',
      })
    ).resolves.toBeNull();
  });

  test('malformed handler validation entries are skipped, not crashed on', async () => {
    handler.replies.validate = {
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
        registration: handler.registration({ capabilities: ['validate'] }),
      }).validatePropertiesAsync?.({
        properties: { name: 'A', kind: 'whatsapp' },
        basePath: 'p',
      })
    ).resolves.toEqual([{ path: '', message: 'the only usable one' }]);
  });

  test('a handler validate answer with no errors list is treated as valid', async () => {
    handler.replies.validate = { status: 200, body: {} };

    await expect(
      buildRegisteredFormationModule({
        registration: handler.registration({ capabilities: ['validate'] }),
      }).validatePropertiesAsync?.({
        properties: { name: 'A', kind: 'whatsapp' },
        basePath: 'p',
      })
    ).resolves.toEqual([]);
  });

  test('a validate call against a non-object bag still reaches the handler', async () => {
    handler.replies.validate = { status: 200, body: { errors: [] } };

    await buildRegisteredFormationModule({
      registration: handler.registration({ capabilities: ['validate'] }),
    }).validatePropertiesAsync?.({ properties: 'nope', basePath: 'p' });

    expect(handler.recorded[0].body.properties).toEqual({});
  });
});
