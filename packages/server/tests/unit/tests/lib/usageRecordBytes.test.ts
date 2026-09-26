import { randomBytes } from 'node:crypto';

import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import {
  lastSnapshotStoredBytes,
  snapshotProjectStorage,
} from 'src/lib/usageStorage';

/**
 * What the storage snapshot's `record_gb_day` quantifies: the records the
 * runtime writes about work it did, beside what a caller stored. The
 * stored-content terms are covered in `usageStorageBytes.test.ts`.
 *
 * Measured as the difference between two days' snapshots of one project. That
 * difference also holds the first day's own storage event, so each term is
 * bounded on both sides: at least the text seeded, and at most that plus
 * `SLACK` for fixed-width columns and that event. A meter that reads a TOAST
 * pointer instead of the value, or skips a column, falls outside.
 */

const SLACK = 1024;
const BYTES_PER_GB = 1_000_000_000;
const GENERATION_CHARS = 3_000;
const GENERATION_METADATA_CHARS = 700;
const TRACE_ERROR_CHARS = 400;
const USAGE_KEY_CHARS = 200;
const USAGE_UNIT_CHARS = 200;
// Enough components that their bytes outweigh `SLACK` on their own.
const USAGE_COMPONENTS = 8;
const AUDIT_DETAIL_CHARS = 900;
const ACTIVITY_SUMMARY_CHARS = 600;
const OTHER_PROJECT_CHARS = 20_000;
const TRACE_FILE_BYTES = 250_000;

// Single-byte and random, so a char is a byte and the text terms are exact: a
// row past the TOAST threshold is compressed, and the meter reads the stored
// width, so a repetitive payload would measure a fraction of its length.
const text = (chars: number): string => {
  return randomBytes(chars).toString('base64').slice(0, chars);
};

type Seeded = { projectId: number; projectPublicId: string; agentId: number };

// Created directly rather than through the bootstrap fixture, which mints the
// deployment's first admin and so can run once per file.
const seedProject = async (name: string): Promise<Seeded> => {
  const project = await db.Project.create({ name });
  const agent = await db.Agent.create({
    publicId: generatePublicId(PUBLIC_ID_PREFIXES.agent),
    projectId: project.id,
    name: `${name}-agent`,
  });
  return {
    projectId: project.id as number,
    projectPublicId: project.publicId,
    agentId: agent.id as number,
  };
};

const seedTrace = async (args: Seeded & { fileId?: number }) => {
  return db.Trace.create({
    publicId: generatePublicId(PUBLIC_ID_PREFIXES.trace),
    projectId: args.projectId,
    agentId: args.agentId,
    fileId: args.fileId ?? null,
  });
};

const seedGeneration = async (args: Seeded & { chars: number }) => {
  const trace = await seedTrace(args);
  return db.Generation.create({
    publicId: generatePublicId(PUBLIC_ID_PREFIXES.generation),
    projectId: args.projectId,
    agentId: args.agentId,
    traceId: trace.id,
    status: 'completed',
    startedAt: new Date(),
    inputMessages: [{ role: 'user', content: text(args.chars) }],
  });
};

type MeteredComponents = Record<string, { quantity: number; unit: string }>;

/** Snapshots `day` (`YYYY-MM-DD`) and reads back that event's components. */
const snapshot = async (args: {
  project: Seeded;
  day: string;
}): Promise<MeteredComponents> => {
  const created = await snapshotProjectStorage({
    projectId: args.project.projectId,
    projectPublicId: args.project.projectPublicId,
    now: new Date(`${args.day}T00:00:00.000Z`),
  });
  expect(created).toBe(true);

  const event = await db.UsageEvent.findOne({
    where: {
      idempotencyKey: `storage:${args.project.projectPublicId}:${args.day}`,
    },
  });
  const components = await db.UsageComponent.findAll({
    where: { usageEventId: event!.id },
  });
  return Object.fromEntries(
    components.map((component) => {
      return [
        component.component,
        { quantity: Number(component.quantity), unit: component.unit },
      ];
    })
  );
};

const bytesBetween = (args: {
  before: MeteredComponents;
  after: MeteredComponents;
  component: string;
}): number => {
  return Math.round(
    (args.after[args.component].quantity -
      args.before[args.component].quantity) *
      BYTES_PER_GB
  );
};

describe('Usage — what the storage snapshot counts as run records', () => {
  test('writes record_gb_day beside gb_day and chunk_count', async () => {
    const project = await seedProject('records-shape');

    const components = await snapshot({ project, day: '2026-08-01' });

    expect(Object.keys(components).sort()).toEqual([
      'chunk_count',
      'gb_day',
      'record_gb_day',
    ]);
    expect(components.record_gb_day.unit).toBe('gb_day');
  });

  test('counts a generation at its stored width, every column included', async () => {
    const project = await seedProject('records-generation');
    const first = await snapshot({ project, day: '2026-08-01' });

    const generation = await seedGeneration({
      ...project,
      chars: GENERATION_CHARS,
    });
    const second = await snapshot({ project, day: '2026-08-02' });

    const inserted = bytesBetween({
      before: first,
      after: second,
      component: 'record_gb_day',
    });
    expect(inserted).toBeGreaterThanOrEqual(GENERATION_CHARS);
    expect(inserted).toBeLessThan(GENERATION_CHARS + SLACK);

    // A column other than the transcript: the measured set follows the model,
    // so a field is counted without anyone listing it.
    await generation.update({
      metadata: { note: text(GENERATION_METADATA_CHARS) },
    });
    const third = await snapshot({ project, day: '2026-08-03' });

    const updated = bytesBetween({
      before: second,
      after: third,
      component: 'record_gb_day',
    });
    expect(updated).toBeGreaterThanOrEqual(GENERATION_METADATA_CHARS);
    expect(updated).toBeLessThan(GENERATION_METADATA_CHARS + SLACK);
  });

  test.each([
    {
      kind: 'a trace row',
      chars: TRACE_ERROR_CHARS,
      seed: async (project: Seeded) => {
        const trace = await seedTrace(project);
        await trace.update({ error: { message: text(TRACE_ERROR_CHARS) } });
      },
    },
    {
      kind: 'a usage event with its components',
      chars: USAGE_KEY_CHARS + USAGE_COMPONENTS * USAGE_UNIT_CHARS,
      seed: async (project: Seeded) => {
        const event = await db.UsageEvent.create({
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageEvent),
          projectId: project.projectId,
          meterType: 'compute_execution',
          provider: 'soat',
          model: 'compute-second',
          costUsd: null,
          idempotencyKey: text(USAGE_KEY_CHARS),
        });
        await db.UsageComponent.bulkCreate(
          Array.from({ length: USAGE_COMPONENTS }, () => {
            return {
              publicId: generatePublicId(PUBLIC_ID_PREFIXES.usageComponent),
              usageEventId: event.id,
              component: 'compute_second',
              quantity: '1',
              unit: text(USAGE_UNIT_CHARS),
            };
          })
        );
      },
    },
    {
      kind: 'an audit entry',
      chars: AUDIT_DETAIL_CHARS,
      seed: async (project: Seeded) => {
        await db.AuditEntry.create({
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.auditEntry),
          projectId: project.projectId,
          action: 'agents:CreateAgent',
          status: 201,
          detail: { note: text(AUDIT_DETAIL_CHARS) },
        });
      },
    },
    {
      kind: 'an activity entry',
      chars: ACTIVITY_SUMMARY_CHARS,
      seed: async (project: Seeded) => {
        await db.ActivityEntry.create({
          publicId: generatePublicId(PUBLIC_ID_PREFIXES.activityEntry),
          projectId: project.projectId,
          kind: 'action_executed',
          severity: 'info',
          summary: text(ACTIVITY_SUMMARY_CHARS),
        });
      },
    },
  ])('counts $kind', async ({ kind, chars, seed }) => {
    const project = await seedProject(`records-${kind}`);
    const first = await snapshot({ project, day: '2026-08-01' });

    await seed(project);
    const second = await snapshot({ project, day: '2026-08-02' });

    const bytes = bytesBetween({
      before: first,
      after: second,
      component: 'record_gb_day',
    });
    expect(bytes).toBeGreaterThanOrEqual(chars);
    expect(bytes).toBeLessThan(chars + SLACK);
  });

  test("never counts another project's records, nor an audit entry with no project", async () => {
    const project = await seedProject('records-isolated');
    const other = await seedProject('records-other');
    const first = await snapshot({ project, day: '2026-08-01' });

    await seedGeneration({ ...other, chars: OTHER_PROJECT_CHARS });
    await db.AuditEntry.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.auditEntry),
      projectId: null,
      action: 'users:CreateUser',
      status: 201,
      detail: { note: text(OTHER_PROJECT_CHARS) },
    });
    const second = await snapshot({ project, day: '2026-08-02' });

    // Only the first day's own storage event.
    expect(
      bytesBetween({ before: first, after: second, component: 'record_gb_day' })
    ).toBeLessThan(SLACK);
  });

  /**
   * Trace steps are stored as a file under `/.system/traces/`, which `gb_day`
   * already sums; the trace row is all `record_gb_day` adds, so the two
   * components never count one byte twice.
   */
  test('counts trace steps once, in gb_day', async () => {
    const project = await seedProject('records-disjoint');
    const first = await snapshot({ project, day: '2026-08-01' });

    const file = await db.File.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.file),
      projectId: project.projectId,
      size: TRACE_FILE_BYTES,
      storageType: 'local',
      storagePath: `seed/${generatePublicId(PUBLIC_ID_PREFIXES.file)}`,
      filename: 'trace.json',
      path: '/.system/traces/trace.json',
    });
    await seedTrace({ ...project, fileId: file.id as number });
    const second = await snapshot({ project, day: '2026-08-02' });

    expect(
      bytesBetween({ before: first, after: second, component: 'gb_day' })
    ).toBe(TRACE_FILE_BYTES);
    expect(
      bytesBetween({ before: first, after: second, component: 'record_gb_day' })
    ).toBeLessThan(SLACK);
  });

  test('the storage_bytes quota reads gb_day alone, never run records', async () => {
    const project = await seedProject('records-quota');
    await seedGeneration({ ...project, chars: GENERATION_CHARS });

    const components = await snapshot({ project, day: '2026-08-01' });
    expect(components.record_gb_day.quantity * BYTES_PER_GB).toBeGreaterThan(
      GENERATION_CHARS
    );

    const measured = await lastSnapshotStoredBytes({
      projectId: project.projectId,
    });
    expect(measured!.bytes).toBe(
      Math.round(components.gb_day.quantity * BYTES_PER_GB)
    );
  });
});
