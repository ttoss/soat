/**
 * Generates packages/website/docs/sdk/services.md from OpenAPI YAML specs.
 * Run with: pnpm tsx scripts/generateSdkServicesDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const OUTPUT_FILE = path.resolve(__dirname, '../docs/sdk/services.md');
const API_PREFIX = '/api/v1';

interface OpenApiSpec {
  tags?: Array<{ name: string }>;
  paths?: Record<string, Record<string, OperationSpec>>;
}

interface OperationSpec {
  operationId?: string;
  summary?: string;
  description?: string;
}

interface ServiceMethod {
  methodName: string;
  httpMethod: string;
  path: string;
  description: string;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete']);

const toTitleCase = (kebab: string): string => {
  return kebab
    .split('-')
    .map((w) => {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join('');
};

interface ModuleConfig {
  file: string;
  className: string;
  label: string;
}

const loadModules = (): ModuleConfig[] => {
  return fs
    .readdirSync(SPECS_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort()
    .map((f) => {
      const file = f.replace(/\.yaml$/, '');
      const spec = yaml.load(
        fs.readFileSync(path.join(SPECS_DIR, f), 'utf-8')
      ) as OpenApiSpec;
      const label = spec.tags?.[0]?.name ?? toTitleCase(file);
      // HeyAPI generates the class name from the tag, which is already PascalCase
      const className = label.replace(/\s+/g, '');
      return { file, className, label };
    });
};

const loadMethods = (moduleName: string): ServiceMethod[] => {
  const specPath = path.join(SPECS_DIR, `${moduleName}.yaml`);
  if (!fs.existsSync(specPath)) return [];

  const spec = yaml.load(fs.readFileSync(specPath, 'utf-8')) as OpenApiSpec;
  const methods: ServiceMethod[] = [];

  for (const [specPath, pathItem] of Object.entries(spec.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!HTTP_METHODS.has(method) || !operation.operationId) continue;
      methods.push({
        methodName: operation.operationId,
        httpMethod: method.toUpperCase(),
        path: `${API_PREFIX}${specPath}`,
        description: operation.summary ?? operation.description ?? '',
      });
    }
  }

  return methods;
};

const renderTable = (className: string, methods: ServiceMethod[]): string => {
  const header = [
    '| Method | HTTP | Path | Description |',
    '| ------ | ---- | ---- | ----------- |',
  ];
  const rows = methods.map((m) => {
    const desc = m.description.replace(/\n/g, ' ').replace(/\|/g, '\\|');
    return `| \`${className}.${m.methodName}()\` | \`${m.httpMethod}\` | \`${m.path}\` | ${desc} |`;
  });
  return [...header, ...rows].join('\n');
};

const main = () => {
  const sections: string[] = [
    '---',
    'sidebar_position: 3',
    '---',
    '',
    '# Services Reference',
    '',
    'Complete list of all SDK service classes and their methods, grouped by module. Each method corresponds to one REST endpoint.',
    '',
    ':::note',
    'This file is auto-generated. Run `pnpm generate-sdk-services-docs` to update it.',
    ':::',
  ];

  for (const mod of loadModules()) {
    const methods = loadMethods(mod.file);
    if (methods.length === 0) continue;

    sections.push('');
    sections.push(`## ${mod.label}`);
    sections.push('');
    sections.push(
      `See [${mod.label} module docs](../modules/${mod.file}) for permissions and data model.`
    );
    sections.push('');
    sections.push(renderTable(mod.className, methods));
  }

  sections.push('');

  fs.writeFileSync(OUTPUT_FILE, sections.join('\n'), 'utf-8');
  console.log(`SDK services docs written to: ${OUTPUT_FILE}`);
};

main();
