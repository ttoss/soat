/**
 * Generates the SDK Services reference from the OpenAPI YAML specs:
 *
 *   docs/sdk/services.md            — index page linking to one page per module
 *   docs/sdk/services/<module>.md   — per-module method list with call
 *                                     signatures and a link to the full REST
 *                                     request/response schema
 *
 * The SDK is a typed wrapper over the REST API, so this reference intentionally
 * does NOT repeat per-field argument tables — the generated TypeScript types and
 * the REST API reference are the source of truth for field shapes. Each method
 * links to its REST operation page for the full schema.
 *
 * Method arguments are passed as `{ path, query, body }`; `path`/`query` keys
 * are snake_case to match the REST URL templates.
 *
 * Run with: pnpm tsx scripts/generateSdkServicesDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import {
  getBodyProps,
  getOperationParams,
  hasRequestBody,
  loadModules,
  loadOperations,
  type ModuleConfig,
  type OperationEntry,
  restPageSlug,
  sanitizeInline,
} from './openapiReferenceHelpers';

const scriptsDir = path.dirname(url.fileURLToPath(import.meta.url));
const SDK_DOCS_DIR = path.resolve(scriptsDir, '../docs/sdk');
const INDEX_OUTPUT_FILE = path.join(SDK_DOCS_DIR, 'services.md');
const SERVICES_OUTPUT_DIR = path.join(SDK_DOCS_DIR, 'services');

const renderSignature = (args: {
  accessor: string;
  entry: OperationEntry;
  mod: ModuleConfig;
}): string => {
  const { accessor, entry, mod } = args;
  const params = getOperationParams({
    operation: entry.operation,
    spec: mod.spec,
  });
  const pathParams = params.filter((p) => {
    return p.in === 'path';
  });
  const queryParams = params.filter((p) => {
    return p.in === 'query';
  });
  const bodyProps = hasRequestBody(entry.operation)
    ? getBodyProps({ operation: entry.operation, spec: mod.spec })
    : [];

  const argLines: string[] = [];

  if (pathParams.length > 0) {
    const names = pathParams.map((p) => {
      return p.name;
    });
    argLines.push(`  path: { ${names.join(', ')} },`);
  }

  if (queryParams.length > 0) {
    const required = queryParams
      .filter((p) => {
        return p.required;
      })
      .map((p) => {
        return p.name;
      });
    const hasOptional = queryParams.length > required.length;
    const inner = [...required, ...(hasOptional ? ['/* + optional */'] : [])];
    argLines.push(`  query: { ${inner.join(', ')} },`);
  }

  if (bodyProps.length > 0) {
    const required = bodyProps
      .filter((p) => {
        return p.required;
      })
      .map((p) => {
        return p.snakeName;
      });
    const hasOptional = bodyProps.length > required.length;
    const inner = [...required, ...(hasOptional ? ['/* + optional */'] : [])];
    argLines.push(`  body: { ${inner.join(', ')} },`);
  } else if (hasRequestBody(entry.operation)) {
    // Non-JSON body (e.g. multipart file upload) — no enumerable properties.
    argLines.push('  body,');
  }

  const call = `soat.${accessor}.${entry.operationId}`;
  const body =
    argLines.length > 0 ? `${call}({\n${argLines.join('\n')}\n})` : `${call}()`;

  return ['```ts', `await ${body};`, '```'].join('\n');
};

const renderMethodSection = (args: {
  accessor: string;
  entry: OperationEntry;
  mod: ModuleConfig;
}): string => {
  const { accessor, entry, mod } = args;
  const description = entry.description
    ? sanitizeInline(entry.description)
    : '—';
  const restLink = `/docs/api/${mod.file}/${restPageSlug(entry.operationId)}`;

  return [
    `### \`soat.${accessor}.${entry.operationId}()\``,
    '',
    description,
    '',
    `- Method: \`${entry.httpMethod}\``,
    `- Path: \`${entry.apiPath}\``,
    '',
    renderSignature({ accessor, entry, mod }),
    '',
    `→ [Request & response schema](${restLink})`,
  ].join('\n');
};

const writeModulePage = (args: {
  mod: ModuleConfig;
  entries: OperationEntry[];
  outputFile: string;
}): void => {
  const { mod, entries, outputFile } = args;
  const sections: string[] = [
    '---',
    `title: ${mod.label}`,
    // Explicit slug (relative to the `/docs` base) for deterministic routing,
    // matching the MCP tools pages.
    `slug: /sdk/services/${mod.file}`,
    '---',
    '',
    `# ${mod.label}`,
    '',
    `SDK methods for the ${mod.label} module, accessed via \`soat.${mod.accessor}\`. See the [${mod.label} module docs](/docs/modules/${mod.docFile}) for permissions and data model, and each method's REST page for the full request/response schema.`,
  ];

  for (const entry of entries) {
    sections.push('');
    sections.push(renderMethodSection({ accessor: mod.accessor, entry, mod }));
  }

  sections.push('');
  fs.writeFileSync(outputFile, sections.join('\n'), 'utf-8');
};

const cleanGeneratedModulePages = (): void => {
  if (!fs.existsSync(SERVICES_OUTPUT_DIR)) {
    fs.mkdirSync(SERVICES_OUTPUT_DIR, { recursive: true });
    return;
  }
  for (const file of fs.readdirSync(SERVICES_OUTPUT_DIR)) {
    if (file.endsWith('.md')) {
      fs.unlinkSync(path.join(SERVICES_OUTPUT_DIR, file));
    }
  }
};

const main = (): void => {
  cleanGeneratedModulePages();

  const moduleLinks: string[] = [];

  for (const mod of loadModules()) {
    const entries = loadOperations(mod.spec);
    if (entries.length === 0) continue;

    const outputFile = path.join(SERVICES_OUTPUT_DIR, `${mod.file}.md`);
    writeModulePage({ mod, entries, outputFile });
    // Absolute site paths for consistency with the MCP index and to avoid any
    // trailing-slash relative-link ambiguity on the index page.
    moduleLinks.push(
      `- [${mod.label}](/docs/sdk/services/${mod.file}) — \`soat.${mod.accessor}\` (${
        entries.length
      } method${entries.length === 1 ? '' : 's'})`
    );
  }

  const sections: string[] = [
    '---',
    'sidebar_position: 3',
    '---',
    '',
    '# Services Reference',
    '',
    'Every SDK service and method, grouped by module. Each service is reached from the client as `soat.<service>`, and each method corresponds to one REST endpoint.',
    '',
    "Method arguments are passed as `{ path, query, body }`. Field shapes are fully typed by `@soat/sdk`; follow each method's **Request & response schema** link for the complete REST reference.",
    '',
    '## Modules',
    '',
    ...moduleLinks,
    '',
  ];

  fs.writeFileSync(INDEX_OUTPUT_FILE, sections.join('\n'), 'utf-8');
  // eslint-disable-next-line no-console
  console.log(`SDK services index written to: ${INDEX_OUTPUT_FILE}`);
  // eslint-disable-next-line no-console
  console.log(`SDK per-module service docs written to: ${SERVICES_OUTPUT_DIR}`);
};

main();
