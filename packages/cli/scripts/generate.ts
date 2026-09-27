/**
 * Reads all OpenAPI YAML specs and generates src/generated/routes.ts —
 * a typed manifest mapping kebab-case CLI command names to their SDK
 * service class, operationId, and parameter lists.
 *
 * Run via: pnpm generate
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import {
  generateCliRouteManifest,
  renderCliRoutesSource,
} from '@ttoss/openapi-codegen';
import * as yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const OUT_FILE = path.resolve(__dirname, '../src/generated/routes.ts');
const TAG_BAG_OUT_FILE = path.resolve(
  __dirname,
  '../src/generated/tagBagCommands.ts'
);
const MODULE_DOCS_BASE_URL = 'https://soat.ttoss.dev/docs/modules';

/**
 * The prefix every REST operation shares.
 *
 * `oauth.yaml` also describes the OAuth 2.1 protocol endpoints, which
 * `@ttoss/auth-core` mounts at the root with paths the RFCs fix. They are in a
 * spec so a client can find the flow without a live host to probe; a CLI
 * command for them would be actively wrong — `/authorize` is a browser
 * redirect, `/token` takes a form-encoded body the manifest cannot send, and
 * `soat register` reads as a SOAT sign-up. The SDK generator and the MCP tool
 * surface apply the same rule.
 */
const REST_PATH_PREFIX = '/api/v1/';

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/**
 * The `operationId`s of every operation the specs mount outside the REST API.
 * The manifest is keyed by command and carries no path, so the exclusion is
 * resolved from the specs by id.
 */
const nonRestOperationIds = (specsDir: string): Set<string> => {
  const ids = new Set<string>();

  const specFiles = fs.readdirSync(specsDir).filter((file) => {
    return file.endsWith('.yaml') || file.endsWith('.yml');
  });

  for (const file of specFiles) {
    const doc: unknown = yaml.load(
      fs.readFileSync(path.join(specsDir, file), 'utf8')
    );
    if (!isRecord(doc) || !isRecord(doc.paths)) continue;

    for (const [specPath, pathItem] of Object.entries(doc.paths)) {
      if (specPath.startsWith(REST_PATH_PREFIX) || !isRecord(pathItem))
        continue;

      for (const operation of Object.values(pathItem)) {
        if (isRecord(operation) && typeof operation.operationId === 'string') {
          ids.add(operation.operationId);
        }
      }
    }
  }

  return ids;
};

const TAG_BAG_REF = /(^|\/)tags\.yaml#\/components\/schemas\/TagBag$/;

/** Every operation object in one spec file. */
const operationsOf = (doc: unknown): Record<string, unknown>[] => {
  if (!isRecord(doc) || !isRecord(doc.paths)) return [];
  return Object.values(doc.paths)
    .filter(isRecord)
    .flatMap((pathItem) => {
      return Object.values(pathItem).filter(isRecord);
    });
};

const isTagBagBody = (operation: Record<string, unknown>): boolean => {
  const body = operation.requestBody;
  const content = isRecord(body) ? body.content : undefined;
  const json = isRecord(content) ? content['application/json'] : undefined;
  const schema = isRecord(json) ? json.schema : undefined;
  return (
    isRecord(schema) &&
    typeof schema.$ref === 'string' &&
    TAG_BAG_REF.test(schema.$ref)
  );
};

/**
 * The `operationId`s whose whole JSON body is a tag bag. The manifest derives
 * one flag per body property, and a bag names none, so these get their
 * `--tags` flag from the `tagBags` wrapper instead.
 */
const tagBagOperationIds = (specsDir: string): Set<string> => {
  const ids = new Set<string>();
  for (const file of fs.readdirSync(specsDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
    const doc: unknown = yaml.load(
      fs.readFileSync(path.join(specsDir, file), 'utf8')
    );
    for (const operation of operationsOf(doc)) {
      if (
        typeof operation.operationId === 'string' &&
        isTagBagBody(operation)
      ) {
        ids.add(operation.operationId);
      }
    }
  }
  return ids;
};

const routes = generateCliRouteManifest({
  specsDir: SPECS_DIR,
  moduleDocsUrl: (moduleSlug) => {
    return `${MODULE_DOCS_BASE_URL}/${moduleSlug}`;
  },
});

const excluded = nonRestOperationIds(SPECS_DIR);
const dropped: string[] = [];

for (const [command, route] of Object.entries(routes)) {
  if (excluded.has(route.operationId)) {
    delete routes[command];
    dropped.push(command);
  }
}

if (dropped.length > 0) {
  // eslint-disable-next-line no-console
  console.log(
    `Dropped ${dropped.length} non-REST command(s): ${dropped.join(', ')}`
  );
}

fs.writeFileSync(OUT_FILE, renderCliRoutesSource(routes));

const tagBagIds = tagBagOperationIds(SPECS_DIR);
const tagBagCommands = Object.entries(routes)
  .filter(([, route]) => {
    return tagBagIds.has(route.operationId);
  })
  .map(([command]) => {
    return command;
  })
  .sort();
fs.writeFileSync(
  TAG_BAG_OUT_FILE,
  [
    '// AUTO-GENERATED by scripts/generate.ts — do not edit.',
    '',
    '/** Commands whose whole request body is a tag bag. */',
    `export const TAG_BAG_COMMANDS: readonly string[] = ${JSON.stringify(tagBagCommands, null, 2)};`,
    '',
  ].join('\n')
);
// eslint-disable-next-line no-console
console.log(`Generated ${Object.keys(routes).length} routes → ${OUT_FILE}`);
