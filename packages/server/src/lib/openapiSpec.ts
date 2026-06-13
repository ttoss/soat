import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

type SpecFile = {
  paths?: Record<string, unknown>;
  components?: {
    schemas?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
};

type MergedSpec = {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, unknown>;
  components: {
    schemas: Record<string, unknown>;
    securitySchemes: Record<string, unknown>;
  };
};

const getSpecDir = (): string => {
  const candidate1 = path.resolve(__dirname, '../rest/openapi/v1');
  const candidate2 = path.resolve(__dirname, 'rest/openapi/v1');
  return fs.existsSync(candidate1) ? candidate1 : candidate2;
};

const loadSpecFile = (filePath: string): SpecFile | null => {
  try {
    return yaml.load(fs.readFileSync(filePath, 'utf-8')) as SpecFile;
  } catch {
    return null;
  }
};

export const loadMergedOpenApiSpec = (): MergedSpec => {
  const specDir = getSpecDir();
  const merged: MergedSpec = {
    openapi: '3.0.3',
    info: { title: 'SOAT API', version: '1.0.0' },
    paths: {},
    components: { schemas: {}, securitySchemes: {} },
  };

  if (!fs.existsSync(specDir)) return merged;

  const files = fs
    .readdirSync(specDir)
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  for (const file of files) {
    const spec = loadSpecFile(path.join(specDir, file));
    if (!spec) continue;
    Object.assign(merged.paths, spec.paths ?? {});
    Object.assign(merged.components.schemas, spec.components?.schemas ?? {});
    Object.assign(
      merged.components.securitySchemes,
      spec.components?.securitySchemes ?? {}
    );
  }

  return merged;
};

let cachedSpec: MergedSpec | null = null;

export const getMergedOpenApiSpec = (): MergedSpec => {
  if (!cachedSpec) {
    cachedSpec = loadMergedOpenApiSpec();
  }
  return cachedSpec;
};
