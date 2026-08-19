/**
 * The project delete lists are checked against the live schema, not against
 * memory.
 *
 * `deleteProject` decides between `409 PROJECT_HAS_DEPENDENTS`, a bare
 * `project.destroy()` and the force cascade from two hand-listed sets of
 * models. #1079 is what happens when a module lands a project-scoped table and
 * neither list learns about it: `countProjectDependents` returned `0`, the bare
 * destroy tripped the foreign key, and every delete of a project holding a
 * dataset — with or without `force` — answered `500`.
 *
 * So the lists are derived here from `information_schema`: every foreign key
 * pointing at `projects` decides, by its own delete rule, which list its model
 * belongs in, and every blocking foreign key pointing at something the cascade
 * removes must come from a row the cascade removes too.
 */

import { db } from 'src/db';
import {
  PROJECT_CASCADE_ORDER,
  PROJECT_COUNTED_MODELS,
  PROJECT_PARENT_SCOPED_MODELS,
} from 'src/lib/projectDependents';

type ForeignKey = {
  childTable: string;
  parentTable: string;
  deleteRule: string;
};

/** Delete rules that leave the child row in place, pointing at a parent that is
 * about to disappear — i.e. the ones that make `DELETE` fail. */
const BLOCKING_DELETE_RULES = new Set(['NO ACTION', 'RESTRICT']);

const PROJECTS_TABLE = 'projects';

let foreignKeys: ForeignKey[] = [];
const tableByModel = new Map<string, string>();
const modelByTable = new Map<string, string>();

const tableOf = (model: string): string => {
  const table = tableByModel.get(model);
  if (!table) throw new Error(`No model named '${model}' is registered.`);
  return table;
};

beforeAll(async () => {
  for (const [name, model] of Object.entries(db.sequelize.models)) {
    const table = String(model.getTableName());
    tableByModel.set(name, table);
    modelByTable.set(table, name);
  }

  const [rows] = await db.sequelize.query(`
    SELECT DISTINCT
      tc.table_name AS child_table,
      ccu.table_name AS parent_table,
      rc.delete_rule AS delete_rule
    FROM information_schema.table_constraints tc
    JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
    JOIN information_schema.referential_constraints rc
      ON rc.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
  `);

  foreignKeys = rows.map((row) => {
    const { child_table, parent_table, delete_rule } = Object(row);
    return {
      childTable: String(child_table),
      parentTable: String(parent_table),
      deleteRule: String(delete_rule),
    };
  });

  // A schema query that returns nothing would make every assertion below pass
  // vacuously, which is the one way this contract could stop protecting
  // anything without failing.
  expect(
    foreignKeys.filter((fk) => {
      return fk.parentTable === PROJECTS_TABLE;
    }).length
  ).toBeGreaterThan(20);
});

describe('project delete lists vs the schema', () => {
  test('every model listed is a real model with a foreign key to projects', () => {
    const listed = [...PROJECT_CASCADE_ORDER, ...PROJECT_COUNTED_MODELS];

    for (const model of listed) {
      const references = foreignKeys.some((fk) => {
        return (
          fk.childTable === tableOf(model) && fk.parentTable === PROJECTS_TABLE
        );
      });
      expect({ model, references }).toEqual({ model, references: true });
    }

    for (const model of PROJECT_PARENT_SCOPED_MODELS) {
      expect(tableByModel.has(model)).toBe(true);
    }
  });

  test('every model whose projectId FK blocks the delete is counted', () => {
    for (const fk of foreignKeys) {
      if (fk.parentTable !== PROJECTS_TABLE) continue;
      if (!BLOCKING_DELETE_RULES.has(fk.deleteRule)) continue;

      const model = modelByTable.get(fk.childTable);
      expect(PROJECT_COUNTED_MODELS).toContain(model);
    }
  });

  test('every model the project delete must remove is in the cascade order', () => {
    for (const fk of foreignKeys) {
      if (fk.parentTable !== PROJECTS_TABLE) continue;
      // SET NULL is the deliberate "outlives the project" rule (AuditEntry):
      // the row stays, so the cascade must leave it alone.
      if (fk.deleteRule === 'SET NULL') continue;

      const model = modelByTable.get(fk.childTable);
      expect(PROJECT_CASCADE_ORDER).toContain(model);
    }
  });

  test('a SET NULL dependent is neither counted nor destroyed', () => {
    for (const fk of foreignKeys) {
      if (fk.parentTable !== PROJECTS_TABLE) continue;
      if (fk.deleteRule !== 'SET NULL') continue;

      const model = modelByTable.get(fk.childTable);
      expect(PROJECT_CASCADE_ORDER).not.toContain(model);
      expect(PROJECT_COUNTED_MODELS).not.toContain(model);
    }
  });

  test('every counted model is also destroyed by the cascade', () => {
    for (const model of PROJECT_COUNTED_MODELS) {
      expect(PROJECT_CASCADE_ORDER).toContain(model);
    }
  });

  test('the cascade order destroys a child before the row it points at', () => {
    const position = new Map(
      PROJECT_CASCADE_ORDER.map((model, index) => {
        return [tableOf(model), index];
      })
    );

    for (const fk of foreignKeys) {
      if (!BLOCKING_DELETE_RULES.has(fk.deleteRule)) continue;
      // Self-references are broken by `nullifyProjectSelfReferences`, not by
      // ordering — nothing can come before itself.
      if (fk.childTable === fk.parentTable) continue;

      const child = position.get(fk.childTable);
      const parent = position.get(fk.parentTable);
      if (child === undefined || parent === undefined) continue;

      expect({ fk, ordered: child < parent }).toEqual({ fk, ordered: true });
    }
  });

  test('nothing the cascade leaves behind can block a row it removes', () => {
    // Everything the force delete removes: the models it destroys itself, the
    // ones it destroys by parent id, the project row — and, transitively, every
    // row the database takes with them.
    const removed = new Set([
      PROJECTS_TABLE,
      ...PROJECT_CASCADE_ORDER.map(tableOf),
      ...PROJECT_PARENT_SCOPED_MODELS.map(tableOf),
    ]);

    let grew = true;
    while (grew) {
      grew = false;
      for (const fk of foreignKeys) {
        if (fk.deleteRule !== 'CASCADE') continue;
        if (!removed.has(fk.parentTable) || removed.has(fk.childTable))
          continue;
        removed.add(fk.childTable);
        grew = true;
      }
    }

    for (const fk of foreignKeys) {
      if (!BLOCKING_DELETE_RULES.has(fk.deleteRule)) continue;
      if (fk.childTable === fk.parentTable) continue;
      if (!removed.has(fk.parentTable)) continue;

      // The child still exists when the parent goes: the delete fails.
      expect({ fk, removed: removed.has(fk.childTable) }).toEqual({
        fk,
        removed: true,
      });
    }
  });
});
