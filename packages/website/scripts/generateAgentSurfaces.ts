/**
 * Generates the machine-readable surfaces this site publishes for agents:
 *
 *   static/openapi.json      the whole REST API in one OpenAPI 3.0 document
 *   static/openapi.yaml      the same document in YAML
 *   static/api/openapi.yaml  the same document at the conventional /api path
 *   static/errors.json       the error-code catalog agents parse errors with
 *   static/404.md            the Markdown recovery map also served with the 404
 *   static/agents.md         when to use SOAT, how to call it, how to get access
 *
 * Run with: pnpm tsx scripts/generateAgentSurfaces.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import { dump, load } from 'js-yaml';

import { ERROR_CODES } from '../../server/src/errors/codes';
import { docsUrlFor, resolutionFor } from '../../server/src/errors/resolutions';
import { buildAgentInstructionsMarkdown } from '../src/data/agentInstructions';
import { buildNotFoundMarkdown } from '../src/data/agentResources';
import type { ErrorCodes, ModuleSpec } from './openApiBundle';
import {
  buildErrorCatalog,
  buildOpenApiBundle,
  findDanglingRefs,
} from './openApiBundle';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');

const STATIC_DIR = path.resolve(__dirname, '../static');

const LERNA_JSON = path.resolve(__dirname, '../../../lerna.json');

const readVersion = (): string => {
  const parsed: unknown = JSON.parse(fs.readFileSync(LERNA_JSON, 'utf-8'));
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'version' in parsed &&
    typeof parsed.version === 'string'
  ) {
    return parsed.version;
  }
  throw new Error(`No version found in ${LERNA_JSON}`);
};

const readSpecs = (): { name: string; spec: ModuleSpec }[] => {
  return fs
    .readdirSync(SPECS_DIR)
    .filter((file) => {
      return file.endsWith('.yaml');
    })
    .sort()
    .map((file) => {
      const spec = load(fs.readFileSync(path.join(SPECS_DIR, file), 'utf-8'));
      return { name: path.basename(file, '.yaml'), spec: spec as ModuleSpec };
    });
};

const writeFile = (relativePath: string, contents: string) => {
  const target = path.join(STATIC_DIR, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents, 'utf-8');
};

const generate = () => {
  const version = readVersion();
  const errorCodes: ErrorCodes = ERROR_CODES;

  const errorHints = { resolutionFor, docsUrlFor };

  const bundle = buildOpenApiBundle({
    specs: readSpecs(),
    version,
    errorCodes,
    errorHints,
  });

  const dangling = findDanglingRefs({ bundle });
  if (dangling.length > 0) {
    throw new Error(
      `The merged OpenAPI bundle has unresolvable references:\n  ${dangling.join('\n  ')}\n` +
        'Declare the missing component in packages/server/src/rest/openapi/v1/, ' +
        'or fix the $ref that points at it.'
    );
  }

  const yaml = dump(bundle, { lineWidth: 120, noRefs: true });

  writeFile('openapi.json', `${JSON.stringify(bundle, null, 2)}\n`);
  writeFile('openapi.yaml', yaml);
  writeFile(path.join('api', 'openapi.yaml'), yaml);
  writeFile(
    'errors.json',
    `${JSON.stringify(buildErrorCatalog({ errorCodes, version, errorHints }), null, 2)}\n`
  );
  writeFile('404.md', buildNotFoundMarkdown({}));
  writeFile('agents.md', buildAgentInstructionsMarkdown());
};

generate();
