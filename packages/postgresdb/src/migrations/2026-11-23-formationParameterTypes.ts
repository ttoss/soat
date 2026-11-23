import { defineMigration } from '@ttoss/postgresdb';

/**
 * Every stored template declares only parameter types its own plan accepts
 * (`string`, `number`, `list`), so a template served by `GET` plans as is.
 * Another casing of an accepted type is lowercased. Any other type is removed:
 * the parameter reads as undeclared, which keeps its default as written.
 * Rewritten in JS rather than through `jsonb`, which would reorder the keys
 * the `json` column keeps.
 */
const ACCEPTED = ['string', 'number', 'list'];

const UNACCEPTED_WHERE = `json_typeof(template::json->'parameters') = 'object'
  AND EXISTS (
    SELECT 1 FROM json_each(template::json->'parameters') AS p
    WHERE json_typeof(p.value) = 'object'
      AND json_typeof(p.value->'type') = 'string'
      AND p.value->>'type' NOT IN (${ACCEPTED.map((type) => {
        return `'${type}'`;
      }).join(', ')})
  )`;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const acceptedDeclaration = (decl: unknown): unknown => {
  if (!isRecord(decl) || typeof decl.type !== 'string') return decl;
  if (ACCEPTED.includes(decl.type)) return decl;
  const lowered = decl.type.toLowerCase();
  if (ACCEPTED.includes(lowered)) return { ...decl, type: lowered };
  return Object.fromEntries(
    Object.entries(decl).filter(([key]) => {
      return key !== 'type';
    })
  );
};

const acceptedTemplate = (template: Record<string, unknown>) => {
  const { parameters } = template;
  if (!isRecord(parameters)) return template;
  return {
    ...template,
    parameters: Object.fromEntries(
      Object.entries(parameters).map(([name, decl]) => {
        return [name, acceptedDeclaration(decl)];
      })
    ),
  };
};

export const formationParameterTypes = defineMigration({
  name: '2026-11-23-formation-parameter-types',
  description:
    'Stored formation templates declare only the parameter types plan accepts: other casings lowercased, unknown types removed.',
  isApplied: async (context) => {
    if (!(await context.tableExists({ table: 'formations' }))) return true;
    const rows = await context.select({
      sql: `SELECT 1 FROM formations WHERE ${UNACCEPTED_WHERE} LIMIT 1`,
    });
    return rows.length === 0;
  },
  up: async (context) => {
    const rows = await context.select<{ id: unknown; template: string }>({
      sql: `SELECT id, template::text AS template FROM formations
        WHERE ${UNACCEPTED_WHERE}`,
    });
    context.say(`rewriting parameter types in ${rows.length} templates`);
    // Each row is rewritten on its own: a re-run finds what is left.
    for (const row of rows) {
      const template: unknown = JSON.parse(row.template);
      if (!isRecord(template)) continue;
      await context.run({
        sql: 'UPDATE formations SET template = $1 WHERE id = $2',
        values: [JSON.stringify(acceptedTemplate(template)), row.id],
      });
    }
  },
});
