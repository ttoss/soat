import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const modelsDir = path.join(repoRoot, 'packages/postgresdb/src/models');
const iamDoc = path.join(repoRoot, 'packages/website/docs/modules/iam.md');

const HEADING = '### Which resources carry which bag';

/**
 * Which bag a resource carries decides what a caller can do with a field:
 * only `tags` reach a policy condition, only `metadata` keeps its types. The
 * choice is made once per resource and read by every caller, so it is
 * written in `iam.md` beside the rule that makes it, and a model that adds a
 * bag without a row there has made the choice where nobody can read it.
 */
const bagsByModel = () => {
  const bags = new Map();
  for (const file of fs.readdirSync(modelsDir)) {
    if (!file.endsWith('.ts')) continue;
    const source = fs.readFileSync(path.join(modelsDir, file), 'utf-8');
    const declared = ['tags', 'metadata'].filter((bag) => {
      return new RegExp(`declare ${bag}\\b`).test(source);
    });
    if (declared.length > 0) bags.set(file.replace(/\.ts$/, ''), declared);
  }
  return bags;
};

/** Rows of the table under {@link HEADING}: resource → bags marked `✓`. */
const bagsByDocRow = () => {
  const doc = fs.readFileSync(iamDoc, 'utf-8');
  const start = doc.indexOf(HEADING);
  assert.notEqual(start, -1, `iam.md has no "${HEADING}" section`);
  const rows = new Map();
  for (const line of doc.slice(start).split('\n').slice(1)) {
    if (/^#{1,3} /.test(line)) break;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => {
        return cell.trim();
      });
    if (
      cells.length !== 3 ||
      /^-+$/.test(cells[0]) ||
      cells[0] === 'Resource'
    ) {
      continue;
    }
    const bags = [];
    if (cells[1] === '✓') bags.push('tags');
    if (cells[2] === '✓') bags.push('metadata');
    rows.set(cells[0].replace(/\s+/g, '').toLowerCase(), {
      label: cells[0],
      bags,
    });
  }
  return rows;
};

describe('annotation bags', () => {
  const models = bagsByModel();
  const rows = bagsByDocRow();

  test('finds the models that carry a bag', () => {
    assert.ok(models.has('Document'));
    assert.deepEqual(models.get('Document'), ['tags', 'metadata']);
  });

  test('every model with a bag has a row in iam.md naming exactly its bags', () => {
    for (const [model, bags] of models) {
      const row = rows.get(model.toLowerCase());
      assert.ok(row, `${model} carries ${bags.join(' and ')} but has no row`);
      assert.deepEqual(
        row.bags,
        bags,
        `${row.label} row disagrees with ${model}.ts`
      );
    }
  });

  test('every row names a model that carries a bag', () => {
    const known = new Set(
      [...models.keys()].map((model) => {
        return model.toLowerCase();
      })
    );
    for (const [key, row] of rows) {
      assert.ok(known.has(key), `${row.label} names no model with a bag`);
    }
  });
});
