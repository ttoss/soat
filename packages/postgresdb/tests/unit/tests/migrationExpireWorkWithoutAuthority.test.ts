import type { Sequelize } from '@ttoss/postgresdb';
import { createMigrationRunner } from '@ttoss/postgresdb';

// The built output, not `src`: Babel rejects a decorated `declare` field.
import { MIGRATIONS } from '../../../dist/index.cjs';
import {
  createDatabase,
  dropDatabase,
  selectRows,
  startDatabaseServer,
  stopDatabaseServer,
} from './migrationFixtures';

jest.setTimeout(180_000);

const DATABASE = `soat_migration_expire_work_${process.pid}`;
const NAME = '2026-11-16-expire-work-without-authority';
const AUTHORITY = `'{"principal":{"type":"user","id":"usr_a"}}'`;

const runnerFor = (args: { client: Sequelize }) => {
  return createMigrationRunner({
    migrations: MIGRATIONS,
    sequelize: args.client,
    log: () => {
      return undefined;
    },
  });
};

type Row = {
  public_id: string;
  status: string;
  error: { code: string; message: string; meta?: unknown } | null;
  finished: boolean;
};

beforeAll(async () => {
  await startDatabaseServer();
});

afterAll(async () => {
  await dropDatabase(DATABASE);
  await stopDatabaseServer();
});

describe(NAME, () => {
  let client: Sequelize;

  const rowsOf = async (args: { table: string; finishedColumn: string }) => {
    const error = args.table === 'tasks' ? 'NULL::json' : 'error';
    return selectRows<Row>({
      client,
      sql: `SELECT public_id, status::text AS status, ${error} AS error,
              ${args.finishedColumn} IS NOT NULL AS finished
            FROM ${args.table} ORDER BY id`,
    });
  };

  const byId = (rows: Row[]) => {
    return Object.fromEntries(
      rows.map((row) => {
        return [row.public_id, row];
      })
    );
  };

  beforeAll(async () => {
    client = await createDatabase(DATABASE);

    await client.query(`
      CREATE TYPE enum_orchestration_runs_status AS ENUM
        ('queued', 'running', 'sleeping', 'awaiting_input', 'completed',
         'failed', 'cancelled', 'expired');
      CREATE TABLE generations (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        status varchar(32) NOT NULL,
        authority json,
        error json,
        stop_reason varchar(255),
        completed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT '2026-01-01'
      );
      CREATE TABLE orchestration_runs (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        status enum_orchestration_runs_status NOT NULL,
        authority json,
        error json,
        wake_at timestamptz,
        completed_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT '2026-01-01'
      );
      CREATE TABLE playbook_executions (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        status varchar(16) NOT NULL,
        authority json,
        error json,
        lease_expires_at timestamptz,
        finished_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT '2026-01-01'
      );
      CREATE TABLE tasks (
        id serial PRIMARY KEY,
        public_id varchar(32) NOT NULL,
        state varchar(255) NOT NULL,
        status varchar(255) NOT NULL,
        authority json,
        stall_deadline_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT '2026-01-01'
      );

      INSERT INTO generations (public_id, status, authority, error, completed_at) VALUES
        ('gen_waiting', 'requires_action', NULL, NULL, NULL),
        ('gen_running', 'running', NULL, NULL, NULL),
        ('gen_held', 'requires_action', ${AUTHORITY}, NULL, NULL),
        ('gen_done', 'completed', NULL, NULL, '2026-01-01'),
        ('gen_failed', 'failed', NULL, '{"code":"PROVIDER_ERROR","message":"x"}', '2026-01-01');
      INSERT INTO orchestration_runs (public_id, status, authority, wake_at, completed_at) VALUES
        ('orc_run_queued', 'queued', NULL, NULL, NULL),
        ('orc_run_sleeping', 'sleeping', NULL, '2026-01-02', NULL),
        ('orc_run_input', 'awaiting_input', NULL, NULL, NULL),
        ('orc_run_held', 'running', ${AUTHORITY}, NULL, NULL),
        ('orc_run_done', 'completed', NULL, NULL, '2026-01-01');
      INSERT INTO playbook_executions (public_id, status, authority, lease_expires_at, finished_at) VALUES
        ('pbk_exe_running', 'running', NULL, '2026-01-02', NULL),
        ('pbk_exe_queued', 'queued', NULL, NULL, NULL),
        ('pbk_exe_held', 'running', ${AUTHORITY}, '2026-01-02', NULL),
        ('pbk_exe_done', 'completed', NULL, NULL, '2026-01-01');
      INSERT INTO tasks (public_id, state, status, authority, stall_deadline_at) VALUES
        ('task_open', 'open', 'open', NULL, '2026-01-02'),
        ('task_held', 'open', 'open', ${AUTHORITY}, NULL),
        ('task_closed', 'closed', 'closed', NULL, NULL);
    `);

    await runnerFor({ client }).run({ names: [NAME] });
  });

  afterAll(async () => {
    await client.close();
  });

  test('an open generation without authority fails with WORK_AUTHORITY_MISSING', async () => {
    const rows = byId(
      await rowsOf({ table: 'generations', finishedColumn: 'completed_at' })
    );
    for (const id of ['gen_waiting', 'gen_running']) {
      expect(rows[id]).toMatchObject({
        status: 'failed',
        error: { code: 'WORK_AUTHORITY_MISSING' },
        finished: true,
      });
    }
    const [stop] = await selectRows<{ stop_reason: string }>({
      client,
      sql: `SELECT stop_reason FROM generations WHERE public_id = 'gen_waiting'`,
    });
    expect(stop.stop_reason).toBe('error');
    expect(rows.gen_waiting.error).toEqual({
      code: 'WORK_AUTHORITY_MISSING',
      message: "Generation 'gen_waiting' has no stored authority to run under.",
      meta: { work: "Generation 'gen_waiting'" },
    });
  });

  test('an open orchestration run without authority expires', async () => {
    const rows = byId(
      await rowsOf({
        table: 'orchestration_runs',
        finishedColumn: 'completed_at',
      })
    );
    for (const id of ['orc_run_queued', 'orc_run_sleeping', 'orc_run_input']) {
      expect(rows[id]).toMatchObject({
        status: 'expired',
        error: { code: 'WORK_AUTHORITY_MISSING' },
        finished: true,
      });
    }
    const [sleeping] = await selectRows<{ wake_at: Date | null }>({
      client,
      sql: `SELECT wake_at FROM orchestration_runs WHERE public_id = 'orc_run_sleeping'`,
    });
    expect(sleeping.wake_at).toBeNull();
  });

  test('an open playbook execution without authority fails', async () => {
    const rows = byId(
      await rowsOf({
        table: 'playbook_executions',
        finishedColumn: 'finished_at',
      })
    );
    for (const id of ['pbk_exe_running', 'pbk_exe_queued']) {
      expect(rows[id]).toMatchObject({
        status: 'failed',
        error: { code: 'WORK_AUTHORITY_MISSING' },
        finished: true,
      });
    }
    const [lease] = await selectRows<{ lease_expires_at: Date | null }>({
      client,
      sql: `SELECT lease_expires_at FROM playbook_executions WHERE public_id = 'pbk_exe_running'`,
    });
    expect(lease.lease_expires_at).toBeNull();
  });

  test('an open task without authority closes in its state', async () => {
    const [task] = await selectRows<{
      state: string;
      status: string;
      stall_deadline_at: Date | null;
    }>({
      client,
      sql: `SELECT state, status, stall_deadline_at FROM tasks WHERE public_id = 'task_open'`,
    });
    expect(task).toEqual({
      state: 'open',
      status: 'closed',
      stall_deadline_at: null,
    });
  });

  test('a row holding authority, or already finished, is untouched', async () => {
    const [snapshot] = await selectRows<{ untouched: string }>({
      client,
      sql: `SELECT
        (SELECT count(*) FROM generations WHERE updated_at = '2026-01-01'
           AND public_id IN ('gen_held', 'gen_done', 'gen_failed'))
        + (SELECT count(*) FROM orchestration_runs WHERE updated_at = '2026-01-01'
           AND public_id IN ('orc_run_held', 'orc_run_done'))
        + (SELECT count(*) FROM playbook_executions WHERE updated_at = '2026-01-01'
           AND public_id IN ('pbk_exe_held', 'pbk_exe_done'))
        + (SELECT count(*) FROM tasks WHERE updated_at = '2026-01-01'
           AND public_id IN ('task_held', 'task_closed')) AS untouched`,
    });
    expect(Number(snapshot.untouched)).toBe(9);
    const failed = byId(
      await rowsOf({ table: 'generations', finishedColumn: 'completed_at' })
    ).gen_failed;
    expect(failed.error).toEqual({ code: 'PROVIDER_ERROR', message: 'x' });
  });

  test('a second run is a no-op', async () => {
    await expect(
      runnerFor({ client }).run({ names: [NAME] })
    ).resolves.not.toThrow();
  });
});
