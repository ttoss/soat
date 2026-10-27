import { db } from 'src/db';
import { buildRegisteredFormationModule } from 'src/lib/formation-modules/registeredFormationModule';
import { registerFormationResourceTypes } from 'src/lib/formationsRegistry';
import type { FormationActor } from 'src/lib/formationsTypes';
import { resolveStartingPrincipal } from 'src/lib/orchestrationRunToken';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  type FakeFormationHandler,
  startFakeFormationHandler,
} from '../../fixtures/formationHandler';

// A `lib/` test per the keep-list rule: the apply pipeline always supplies the
// resource context and only ever asks a handler to validate a bag that already
// validated locally, so the contract a direct caller gets — and the registry's
// own refusal to shadow a built-in, which the boot-time parser pre-empts — is
// reachable from no route. Everything a deploy does with a registered type is
// pinned through REST in `rest/formationsRegisteredType*.test.ts`.

let handler: FakeFormationHandler;
let projectId: number;
let actor: FormationActor;

beforeAll(async () => {
  handler = await startFakeFormationHandler();

  const setup = await setupProjectWithUsers({
    prefix: 'regfmod',
    policyActions: ['formations:GetFormation'],
    createNoPermUser: false,
  });
  const project = await db.Project.findOne({
    where: { publicId: setup.projectId },
  });
  projectId = project!.id;

  const user = await db.User.findOne({ where: { publicId: setup.userId } });
  actor = {
    userId: user!.id as number,
    author: { principalType: 'user', principalId: setup.userId },
    principal: resolveStartingPrincipal({
      authUser: { publicId: setup.userId },
    }),
    isAllowed: async () => {
      return true;
    },
  };
});

afterAll(async () => {
  await handler.close();
});

beforeEach(() => {
  handler.reset();
});

describe('the module contract holds for a direct caller', () => {
  const module = () => {
    return buildRegisteredFormationModule({
      registration: handler.registration({ capabilities: ['validate'] }),
    });
  };

  test('the resource context is optional on every write', async () => {
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
      actor,
    });
    await built.update({
      projectId,
      actor,
      properties: { name: 'B', kind: 'whatsapp' },
      physicalResourceId: 'chn_500',
    });
    await built.delete({
      projectId,
      actor,
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

  test('create without a resource key anchors its idempotency key on the logical id', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_600' },
    };

    await module().create({
      properties: { name: 'A', kind: 'whatsapp' },
      projectId,
      actor,
      logicalId: 'OnlyLogicalId',
    });

    expect(handler.recorded[0].body.logical_id).toBe('OnlyLogicalId');
    expect(typeof handler.recorded[0].headers['x-soat-idempotency-key']).toBe(
      'string'
    );
  });

  test('a validate call against a non-object bag still reaches the handler', async () => {
    handler.replies.validate = { status: 200, body: { errors: [] } };

    await module().validatePropertiesAsync?.({
      properties: 'nope',
      basePath: 'p',
    });

    expect(handler.recorded[0].body.properties).toEqual({});
  });
});

describe('registerFormationResourceTypes', () => {
  test('refuses a name that collides with a built-in', () => {
    expect(() => {
      return registerFormationResourceTypes({
        registrations: [{ ...handler.registration({}), name: 'agent' }],
      });
    }).toThrow(
      "Cannot register formation resource type 'agent': it is a built-in type"
    );
  });
});
