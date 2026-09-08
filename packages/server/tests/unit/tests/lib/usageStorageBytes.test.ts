import { generatePublicId, PUBLIC_ID_PREFIXES } from '@soat/postgresdb';
import { db } from 'src/db';
import { snapshotProjectStorage } from 'src/lib/usageStorage';

import { setupProjectWithUsers } from '../../fixtures/bootstrap';

/**
 * What the storage snapshot quantifies, row by row. The event shape,
 * idempotency and pricing are covered in `rest/usageStorage.test.ts`; this
 * asserts the measured quantities themselves, on a project of its own so each
 * one is exactly what these fixtures seed (#1221, #1232).
 *
 * An embedding is the dominant term — a `vector(1024)` stores ~4 KB against the
 * ~1 KB of text it encodes — so a meter blind to it reports a fraction of the
 * footprint, and under-reports in the direction that lets an unbounded corpus
 * grow.
 *
 * Bytes still miss the index over those vectors, which no `pg_column_size` can
 * see and which costs more per element than the vector itself. `chunk_count`
 * is the term that prices it, so what it counts is asserted here beside them.
 *
 * The evaluations corpus is seeded here for the same reason (#1247): an eval
 * result freezes its own copy of the item it scored, so the stored bytes grow
 * with runs rather than with the dataset, and the retention sweep clears only
 * `output` of them.
 */

const DIMENSIONS = Number(process.env.EMBEDDING_DIMENSIONS);

const FILE_BYTES = 1_000;
const EMBEDDED_CHUNK_CHARS = 500;
const UNEMBEDDED_CHUNK_CHARS = 200;
const EMBEDDED_ENTRY_CHARS = 300;
const UNEMBEDDED_ENTRY_CHARS = 100;
const ITEM_INPUT_CHARS = 400;
const ITEM_EXPECTED_CHARS = 120;
const ITEM_METADATA_CHARS = 60;
const RESULT_OUTPUT_CHARS = 250;

// Single-byte characters, so a char is a byte and the text terms are exact.
const text = (chars: number): string => {
  return 'x'.repeat(chars);
};

const vector = (): number[] => {
  return new Array(DIMENSIONS).fill(0.125);
};

const messages = (chars: number): Array<{ content: string; role: string }> => {
  return [{ content: text(chars), role: 'user' }];
};

describe('Usage — what the storage snapshot counts', () => {
  let projectId: string;
  let projectInternalId: number;
  let datasetItemPublicId: string;
  let evalResultPublicId: string;
  let evalInternalId: number;
  let datasetItemInternalId: number;

  /**
   * One more run of the seeded item, scored. Every result freezes its own copy
   * of the item, so this is what a re-run adds to the corpus.
   */
  const seedRunWithResult = async (): Promise<string> => {
    const run = await db.EvalRun.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.evalRun),
      evalId: evalInternalId,
      agentVersion: 1,
      status: 'completed',
      itemCount: 1,
    });

    const result = await db.EvalResult.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.evalResult),
      evalRunId: run.id,
      datasetItemId: datasetItemInternalId,
      input: messages(ITEM_INPUT_CHARS),
      expectedOutput: text(ITEM_EXPECTED_CHARS),
      output: text(RESULT_OUTPUT_CHARS),
      scores: [{ passed: true, score: 1, scorer: 'exact_match' }],
      passed: true,
    });

    return result.publicId;
  };

  beforeAll(async () => {
    const setup = await setupProjectWithUsers({
      prefix: 'usagebytes',
      policyActions: ['usage:ListEvents'],
      createNoPermUser: false,
    });
    projectId = setup.projectId;

    const project = await db.Project.findOne({
      where: { publicId: projectId },
    });
    projectInternalId = project!.id as number;

    const file = await db.File.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.file),
      projectId: projectInternalId,
      size: FILE_BYTES,
      storageType: 'local',
      storagePath: `seed/${generatePublicId(PUBLIC_ID_PREFIXES.file)}`,
      filename: 'seed.bin',
    });

    const document = await db.Document.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.document),
      fileId: file.id,
      status: 'ready',
    });

    await db.DocumentChunk.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.documentChunk),
      documentId: document.id,
      content: text(EMBEDDED_CHUNK_CHARS),
      chunkIndex: 0,
      embedding: vector(),
    });

    // Indexed text with no vector yet: its content is stored, its embedding is
    // not, so it must contribute the former and nothing for the latter.
    await db.DocumentChunk.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.documentChunk),
      documentId: document.id,
      content: text(UNEMBEDDED_CHUNK_CHARS),
      chunkIndex: 1,
      embedding: null,
    });

    const memory = await db.Memory.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.memory),
      projectId: projectInternalId,
      name: 'seed-memory',
    });

    await db.MemoryEntry.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.memoryEntry),
      memoryId: memory.id,
      content: text(EMBEDDED_ENTRY_CHARS),
      embedding: vector(),
    });

    await db.MemoryEntry.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.memoryEntry),
      memoryId: memory.id,
      content: text(UNEMBEDDED_ENTRY_CHARS),
      embedding: null,
    });

    const dataset = await db.Dataset.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.dataset),
      projectId: projectInternalId,
      name: 'seed-dataset',
    });

    const item = await db.DatasetItem.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.datasetItem),
      datasetId: dataset.id,
      input: messages(ITEM_INPUT_CHARS),
      expectedOutput: text(ITEM_EXPECTED_CHARS),
      metadata: { topic: text(ITEM_METADATA_CHARS) },
    });
    datasetItemPublicId = item.publicId;
    datasetItemInternalId = item.id as number;

    const agent = await db.Agent.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.agent),
      projectId: projectInternalId,
      name: 'seed-agent',
    });

    const evaluation = await db.Eval.create({
      publicId: generatePublicId(PUBLIC_ID_PREFIXES.evaluation),
      projectId: projectInternalId,
      name: 'seed-eval',
      agentId: agent.id,
      datasetId: dataset.id,
      scorers: [{ type: 'exact_match' }],
    });
    evalInternalId = evaluation.id as number;

    evalResultPublicId = await seedRunWithResult();
  });

  type MeteredComponent = { quantity: number; unit: string; billable: boolean };

  /**
   * Snapshots `now`'s day and reads back that event's components by name. The
   * event is located by the same idempotency key the snapshot writes, so a
   * suite that samples more than one day never reads another day's row.
   */
  const meteredComponents = async (
    now: Date
  ): Promise<Record<string, MeteredComponent>> => {
    const created = await snapshotProjectStorage({
      projectId: projectInternalId,
      projectPublicId: projectId,
      now,
    });
    expect(created).toBe(true);

    const event = await db.UsageEvent.findOne({
      where: {
        idempotencyKey: `storage:${projectId}:${now.toISOString().slice(0, 10)}`,
      },
    });
    const components = await db.UsageComponent.findAll({
      where: { usageEventId: event!.id },
    });

    return Object.fromEntries(
      components.map((component) => {
        return [
          component.component,
          {
            quantity: Number(component.quantity),
            unit: component.unit,
            billable: component.billable,
          },
        ];
      })
    );
  };

  /** The `gb_day` quantity of the snapshot for `now`'s day, in bytes. */
  const meteredBytes = async (now: Date): Promise<number> => {
    const components = await meteredComponents(now);
    return components.gb_day.quantity * 1_000_000_000;
  };

  /**
   * Read from the seeded row rather than computed: the width of a stored
   * `vector` is pgvector's business (a 4-byte float per dimension, plus a
   * header whose size depends on whether the value went out of line), and the
   * contract asserted here is that the meter counts whatever that width is.
   * Pinned against `4 × dimensions` below so a meter counting a TOAST pointer,
   * or nothing, cannot satisfy it.
   */
  const storedVectorBytes = async (): Promise<number> => {
    const [rows] = await db.sequelize.query(
      `SELECT pg_column_size(dc."embedding") AS bytes
         FROM "document_chunks" dc
        WHERE dc."embedding" IS NOT NULL
        LIMIT 1`
    );
    const [row] = rows as Array<{ bytes: number }>;
    return Number(row.bytes);
  };

  /**
   * Same contract as {@link storedVectorBytes} for a JSONB payload: the meter
   * counts the width PostgreSQL stored, whatever the binary encoding costs on
   * top of the text. Pinned against the payload below so a TOAST pointer, or
   * nothing, cannot satisfy it.
   */
  const storedJsonbBytes = async (args: {
    column: string;
    publicId: string;
    table: string;
  }): Promise<number> => {
    const [rows] = await db.sequelize.query(
      `SELECT pg_column_size(t."${args.column}") AS bytes
         FROM "${args.table}" t
        WHERE t."public_id" = :publicId`,
      { replacements: { publicId: args.publicId } }
    );
    const [row] = rows as Array<{ bytes: number }>;
    return Number(row.bytes);
  };

  /** Every JSONB term the evaluations corpus seeded above contributes. */
  const seededJsonbBytes = async (): Promise<number> => {
    const [itemInput, itemMetadata, resultInput, resultScores] =
      await Promise.all([
        storedJsonbBytes({
          column: 'input',
          publicId: datasetItemPublicId,
          table: 'dataset_items',
        }),
        storedJsonbBytes({
          column: 'metadata',
          publicId: datasetItemPublicId,
          table: 'dataset_items',
        }),
        storedJsonbBytes({
          column: 'input',
          publicId: evalResultPublicId,
          table: 'eval_results',
        }),
        storedJsonbBytes({
          column: 'scores',
          publicId: evalResultPublicId,
          table: 'eval_results',
        }),
      ]);
    return itemInput + itemMetadata + resultInput + resultScores;
  };

  test('a stored vector is the dominant term, and is what it claims to be', async () => {
    const vectorBytes = await storedVectorBytes();

    // A float per dimension dominates any header, so the two must agree
    // closely — while a pointer to the value (18 bytes) would not.
    expect(vectorBytes).toBeGreaterThan(4 * DIMENSIONS);
    expect(vectorBytes).toBeLessThan(4 * DIMENSIONS + 64);

    // The premise the issue rests on: the vector outweighs the text it encodes.
    expect(vectorBytes).toBeGreaterThan(4 * EMBEDDED_CHUNK_CHARS);
  });

  test('a stored JSONB payload is measured at its stored width', async () => {
    const itemInput = await storedJsonbBytes({
      column: 'input',
      publicId: datasetItemPublicId,
      table: 'dataset_items',
    });

    // The message text plus its JSON envelope and jsonb's own encoding — never
    // a pointer to the value (18 bytes), and never nothing.
    expect(itemInput).toBeGreaterThan(ITEM_INPUT_CHARS);
    expect(itemInput).toBeLessThan(ITEM_INPUT_CHARS + 128);
  });

  test('counts files, chunks, memories and the evaluations corpus', async () => {
    const vectorBytes = await storedVectorBytes();
    const jsonbBytes = await seededJsonbBytes();

    const expected =
      FILE_BYTES +
      EMBEDDED_CHUNK_CHARS +
      UNEMBEDDED_CHUNK_CHARS +
      EMBEDDED_ENTRY_CHARS +
      UNEMBEDDED_ENTRY_CHARS +
      // One per embedded row; the two unembedded rows store no vector.
      2 * vectorBytes +
      // The item's reference answer and the result's frozen copy of it.
      2 * ITEM_EXPECTED_CHARS +
      RESULT_OUTPUT_CHARS +
      jsonbBytes;

    const bytes = await meteredBytes(new Date('2026-08-11T00:00:00.000Z'));

    expect(bytes).toBe(expected);
  });

  /**
   * The count is rows, not bytes: an un-embedded row still occupies a heap
   * tuple and still joins the HNSW graph the moment it is embedded, and the
   * whole point of the component is that it does not move with chunk size.
   */
  test('counts document chunks and memory entries as one chunk_count', async () => {
    const components = await meteredComponents(
      new Date('2026-08-12T00:00:00.000Z')
    );

    expect(components.chunk_count).toEqual({
      // Two chunks and two entries, embedded or not. A dataset item and an eval
      // result carry no vector, so neither joins the index this prices.
      quantity: 4,
      unit: 'count',
      billable: true,
    });
  });

  /**
   * The corpus grows with runs, not with the dataset: re-running one item
   * stores a second frozen copy of it, and the meter must see that (#1247).
   */
  test('a re-run of the same item adds its own frozen copy', async () => {
    const before = await meteredBytes(new Date('2026-08-13T00:00:00.000Z'));

    await seedRunWithResult();

    const after = await meteredBytes(new Date('2026-08-14T00:00:00.000Z'));

    const resultInput = await storedJsonbBytes({
      column: 'input',
      publicId: evalResultPublicId,
      table: 'eval_results',
    });
    const resultScores = await storedJsonbBytes({
      column: 'scores',
      publicId: evalResultPublicId,
      table: 'eval_results',
    });

    expect(after - before).toBe(
      resultInput + resultScores + ITEM_EXPECTED_CHARS + RESULT_OUTPUT_CHARS
    );
  });
});
