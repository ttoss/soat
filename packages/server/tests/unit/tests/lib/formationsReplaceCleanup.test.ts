/**
 * Replacement disposal on a formation deploy: when it runs, and what happens
 * when it fails (#1193, #1194).
 *
 * Driven through a registered resource type because replacement is only
 * reachable there — a handler answering an `update` with a different
 * `physical_resource_id` is what tells the engine it could not change the
 * resource in place. A `lib/` test per the keep-list rule: the ordering is
 * observable only from inside an apply.
 */

import { db } from 'src/db';
import {
  createFormation,
  deleteFormation,
  type FormationAuthorizer,
  updateFormation,
} from 'src/lib/formations';
import {
  registerFormationResourceTypes,
  unregisterFormationResourceTypes,
} from 'src/lib/formationsRegistry';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';
import {
  deletedPhysicalIds,
  type FakeFormationHandler,
  startFakeFormationHandler,
} from '../../fixtures/formationHandler';

// An operator-registered type has no SOAT action to authorize (#1181).
const neverAsked: FormationAuthorizer = (request) => {
  throw new Error(
    `unexpected authorization request for ${request.resourceType}`
  );
};

let handler: FakeFormationHandler;
let projectId: number;
let actingUserId: number;

beforeAll(async () => {
  handler = await startFakeFormationHandler();

  const setup = await setupProjectWithUsers({
    prefix: 'fmreplace',
    policyActions: [],
    createNoPermUser: false,
  });
  const project = await db.Project.findOne({
    where: { publicId: setup.projectId },
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
  registerFormationResourceTypes({
    registrations: [
      handler.registration({ capabilities: ['validate', 'read'] }),
    ],
  });
});

afterEach(() => {
  // A registry mutation must never leak into another test file
  // (`.claude/rules/tests.md`).
  unregisterFormationResourceTypes({ names: ['test_channel'] });
});

describe('a replaced resource is disposed of at the end of the deploy', () => {
  const template = (properties: Record<string, unknown>) => {
    return { resources: { Chan: { type: 'test_channel', properties } } };
  };

  test('an update answering with a new id replaces the resource', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_200' },
    };
    const created = await createFormation({
      authorize: neverAsked,
      actingUserId,
      projectId,
      name: 'registered-replacement',
      template: template({ name: 'A', kind: 'whatsapp' }),
    });

    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_201' },
    };
    handler.replies.delete = { status: 200, body: {} };

    const updated = await updateFormation({
      authorize: neverAsked,
      actingUserId,
      id: created.id,
      template: template({ name: 'A', kind: 'discord' }),
    });

    // The record now points at the replacement…
    expect(updated.status).toBe('active');
    expect(updated.resources?.[0].physical_resource_id).toBe('chn_201');

    // …and the superseded resource was disposed of.
    expect(deletedPhysicalIds(handler)).toEqual(['chn_200']);

    await deleteFormation({
      id: created.id,
      authorize: neverAsked,
      actingUserId,
    });
  });

  test('a failed disposal leaks the old resource but does not fail the deploy', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_300' },
    };
    const created = await createFormation({
      authorize: neverAsked,
      actingUserId,
      projectId,
      name: 'registered-replacement-cleanup-fails',
      template: template({ name: 'A', kind: 'whatsapp' }),
    });

    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_301' },
    };
    handler.replies.delete = {
      status: 500,
      body: { message: 'cannot delete' },
    };

    const updated = await updateFormation({
      authorize: neverAsked,
      actingUserId,
      id: created.id,
      template: template({ name: 'A', kind: 'discord' }),
    });

    // The desired state is realised, so the deploy succeeds; the leak is
    // reported on the formation rather than rolled back (#1193).
    expect(updated.status).toBe('active');
    expect(updated.resources?.[0].physical_resource_id).toBe('chn_301');
    expect(updated.error?.code).toBe('FORMATION_REPLACE_CLEANUP_FAILED');
    expect(updated.error?.message).toContain('chn_300');
    expect(updated.error?.meta?.failures).toEqual([
      {
        logical_id: 'Chan',
        resource_type: 'test_channel',
        physical_resource_id: 'chn_300',
        error: expect.stringContaining('cannot delete'),
      },
    ]);
  });

  test('a failed disposal is retried by the next deploy, and clears once it succeeds', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_310' },
    };
    const created = await createFormation({
      authorize: neverAsked,
      actingUserId,
      projectId,
      name: 'registered-replacement-cleanup-retried',
      template: template({ name: 'A', kind: 'whatsapp' }),
    });

    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_311' },
    };
    handler.replies.delete = {
      status: 500,
      body: { message: 'cannot delete' },
    };
    await updateFormation({
      authorize: neverAsked,
      actingUserId,
      id: created.id,
      template: template({ name: 'A', kind: 'discord' }),
    });

    handler.recorded.length = 0;
    handler.replies.update = (request) => {
      return {
        status: 200,
        body: { physical_resource_id: request.physical_resource_id },
      };
    };
    handler.replies.delete = { status: 200, body: {} };

    const reconciled = await updateFormation({
      authorize: neverAsked,
      actingUserId,
      id: created.id,
      template: template({ name: 'B', kind: 'discord' }),
    });

    // The un-deleted resource is on the ledger as pending cleanup, so the next
    // operation drives it to completion — and a transient handler failure
    // self-heals.
    expect(deletedPhysicalIds(handler)).toEqual(['chn_310']);
    expect(reconciled.status).toBe('active');
    expect(reconciled.error).toBeNull();
  });

  test('a leaked replacement is swept when the formation is torn down', async () => {
    handler.replies.create = {
      status: 200,
      body: { physical_resource_id: 'chn_320' },
    };
    const created = await createFormation({
      authorize: neverAsked,
      actingUserId,
      projectId,
      name: 'registered-replacement-cleanup-teardown',
      template: template({ name: 'A', kind: 'whatsapp' }),
    });

    handler.replies.update = {
      status: 200,
      body: { physical_resource_id: 'chn_321' },
    };
    handler.replies.delete = {
      status: 500,
      body: { message: 'cannot delete' },
    };
    await updateFormation({
      authorize: neverAsked,
      actingUserId,
      id: created.id,
      template: template({ name: 'A', kind: 'discord' }),
    });

    handler.recorded.length = 0;
    handler.replies.delete = { status: 200, body: {} };
    await deleteFormation({
      id: created.id,
      authorize: neverAsked,
      actingUserId,
    });

    expect(deletedPhysicalIds(handler)).toEqual(['chn_320', 'chn_321']);
  });

  test('a replaced resource is disposed of only after its dependents are re-pointed', async () => {
    // #1194: the old resource is still referenced while a dependent points at
    // it, and a type whose delete refuses over live references can never be
    // cleaned up if the disposal runs first.
    handler.replies.create = (request) => {
      return {
        status: 200,
        body: {
          physical_resource_id:
            request.logical_id === 'Chan' ? 'chn_500' : 'dep_500',
        },
      };
    };

    const dependentTemplate = (kind: string) => {
      return {
        resources: {
          Chan: { type: 'test_channel', properties: { name: 'A', kind } },
          Dep: {
            type: 'test_channel',
            properties: {
              name: 'D',
              kind: 'whatsapp',
              agent_id: { ref: 'Chan' },
            },
          },
        },
      };
    };

    const created = await createFormation({
      authorize: neverAsked,
      actingUserId,
      projectId,
      name: 'registered-replacement-ordering',
      template: dependentTemplate('whatsapp'),
    });
    expect(created.status).toBe('active');

    handler.recorded.length = 0;
    handler.replies.update = (request) => {
      return request.physical_resource_id === 'chn_500'
        ? { status: 200, body: { physical_resource_id: 'chn_501' } }
        : {
            status: 200,
            body: { physical_resource_id: request.physical_resource_id },
          };
    };
    handler.replies.delete = { status: 200, body: {} };

    const updated = await updateFormation({
      authorize: neverAsked,
      actingUserId,
      id: created.id,
      template: dependentTemplate('discord'),
    });

    expect(updated.status).toBe('active');
    expect(
      handler.recorded
        .filter((request) => {
          return (
            request.body.request_type === 'update' ||
            request.body.request_type === 'delete'
          );
        })
        .map((request) => {
          return `${String(request.body.request_type)}:${String(
            request.body.physical_resource_id
          )}`;
        })
    ).toEqual(['update:chn_500', 'update:dep_500', 'delete:chn_500']);

    await deleteFormation({
      id: created.id,
      authorize: neverAsked,
      actingUserId,
    });
  });
});
