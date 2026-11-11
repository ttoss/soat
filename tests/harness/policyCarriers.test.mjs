import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const srcDir = path.join(repoRoot, 'packages/server/src');
const modelsDir = path.join(repoRoot, 'packages/postgresdb/src/models');
const registryFile = path.join(srcDir, 'lib/policyCarriers.ts');

/** Source with comments dropped, so prose naming a symbol is not a hit. */
const code = (file) => {
  return fs
    .readFileSync(file, 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => {
      return !/^\s*\/\//.test(line);
    })
    .join('\n');
};

/** Each `POLICY_CARRIERS` entry: its name, models and attach check. */
const registry = () => {
  const source = code(registryFile);
  const body = source.slice(source.indexOf('export const POLICY_CARRIERS'));
  const entries = [
    ...body.matchAll(/^ {2}(\w+): ([\s\S]*?)(?=^ {2}\w+: |^\})/gm),
  ];
  return entries.map(([, name, entry]) => {
    const listed = /models: \[([^\]]*)\]/.exec(entry);
    const single = /projectJsonbCarrier\(\{ model: '(\w+)'/.exec(entry);
    const models = listed
      ? [...listed[1].matchAll(/'(\w+)'/g)].map((m) => {
          return m[1];
        })
      : [single[1]];
    const attach = single
      ? 'writer_holds_grants'
      : /attach: '(\w+)'/.exec(entry)[1];
    return { name, models, attach };
  });
};

const serverFiles = fs
  .readdirSync(srcDir, { recursive: true })
  .filter((entry) => {
    return entry.endsWith('.ts');
  });

/**
 * A policy's grant is checked on attach and on edit only for the carriers
 * `POLICY_CARRIERS` names, so every model naming policies must be one.
 */
describe('policy carriers', () => {
  test('every model with policy_ids is a registered carrier', () => {
    const declaring = fs
      .readdirSync(modelsDir)
      .filter((file) => {
        return /\bdeclare policyIds\b/.test(code(path.join(modelsDir, file)));
      })
      .map((file) => {
        return file.replace(/\.ts$/, '');
      })
      .sort();
    const registered = registry().flatMap((carrier) => {
      return carrier.models;
    });
    assert.ok(declaring.length > 0);
    for (const model of declaring) {
      assert.ok(
        registered.includes(model),
        `${model} declares policyIds but is not in POLICY_CARRIERS (lib/policyCarriers.ts)`
      );
    }
    for (const model of registered) {
      assert.ok(
        fs.existsSync(path.join(modelsDir, `${model}.ts`)),
        `POLICY_CARRIERS names a model that does not exist: ${model}`
      );
    }
  });

  test('every carrier whose writer must hold the grant has an attach site', () => {
    const sites = serverFiles
      .filter((entry) => {
        return !entry.endsWith('policyCarriers.ts');
      })
      .map((entry) => {
        return code(path.join(srcDir, entry));
      })
      .join('\n');
    for (const carrier of registry()) {
      if (carrier.attach !== 'writer_holds_grants') continue;
      assert.match(
        sites,
        new RegExp(`carrier: '${carrier.name}'`),
        `no attach of a ${carrier.name} policy goes through assertWriterMayAttach`
      );
    }
  });

  test('only the registry queries carriers by policy', () => {
    const querying = serverFiles
      .filter((entry) => {
        return /policy_ids['")]*\s*@>|ANY\(\w+\.policy_ids\)/.test(
          code(path.join(srcDir, entry))
        );
      })
      .sort();
    assert.deepEqual(querying, ['lib/policyCarriers.ts']);
  });

  // A `JSONB` `policyIds` names public ids a resource acts under, so a policy
  // it names cannot be deleted; key and user ids only lose the grant.
  test('every carrier of policy public ids refuses the policy delete', () => {
    const jsonbCarriers = fs
      .readdirSync(modelsDir)
      .filter((file) => {
        return /DataType\.JSONB[^)]*\)\s*\n\s*declare policyIds/.test(
          fs.readFileSync(path.join(modelsDir, file), 'utf-8')
        );
      })
      .map((file) => {
        return file.replace(/\.ts$/, '');
      })
      .sort();
    const refusing = [
      ...code(path.join(srcDir, 'lib/attachedPolicies.ts')).matchAll(
        /db\.(\w+)\.count\(/g
      ),
    ]
      .map((match) => {
        return match[1];
      })
      .sort();
    assert.deepEqual(jsonbCarriers, refusing);
  });
});
