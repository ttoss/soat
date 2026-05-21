/**
 * Generates docs/modules/formation-resource-types/ from the formations
 * OpenAPI YAML spec (packages/server/src/rest/openapi/v1/formations.yaml).
 *
 * Produces one page per resource type plus an index page.
 * Run with: pnpm tsx scripts/generateFormationsResourceDocs.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const FORMATIONS_YAML = path.resolve(
  __dirname,
  '../../server/src/rest/openapi/v1/formations.yaml'
);

const OUTPUT_DIR = path.resolve(__dirname, '../docs/formations-types');

// ── Types ──────────────────────────────────────────────────────────────────

interface OpenApiSchema {
  type?: string;
  description?: string;
  nullable?: boolean;
  enum?: string[];
  items?: OpenApiSchema;
  properties?: Record<string, OpenApiSchema>;
  required?: string[];
  additionalProperties?: boolean | OpenApiSchema;
}

interface OpenApiSpec {
  components?: {
    schemas?: Record<string, OpenApiSchema>;
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Convert a snake_case string to PascalCase. */
const toPascalCase = (snake: string): string =>
  snake
    .split(/[_-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');

/** Convert a snake_case string to a kebab-case filename slug. */
const toSlug = (snake: string): string => snake.replace(/_/g, '-');

/** Human-readable title for a resource type. */
const toTitle = (resourceType: string): string =>
  resourceType
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** Escape MDX-special characters in description strings so Docusaurus doesn't treat { } as JSX. */
const escapeMdx = (text: string): string =>
  text.replace(/\{/g, '&#123;').replace(/\}/g, '&#125;');

// ── Type name helpers ─────────────────────────────────────────────────────

/** Capitalize the first letter of a string. */
const capitalize = (s: string): string =>
  s.charAt(0).toUpperCase() + s.slice(1);

/** Map an OpenAPI schema to a simple YAML placeholder type name. */
const getSimpleTypeName = (prop: OpenApiSchema): string => {
  switch (prop.type) {
    case 'integer':
      return 'Integer';
    case 'number':
      return 'Number';
    case 'boolean':
      return 'Boolean';
    case 'string':
      return 'String';
    case 'object':
      return 'Object';
    default:
      return capitalize(prop.type ?? 'any');
  }
};

/** Map an OpenAPI property to a display type string for the Properties section. */
const renderDisplayType = (name: string, prop: OpenApiSchema): string => {
  if (prop.type === 'array') {
    if (
      prop.items?.properties &&
      Object.keys(prop.items.properties).length > 0
    ) {
      const typeName = toPascalCase(name);
      return `Array of [${typeName}](#${typeName.toLowerCase()})`;
    }
    return `Array of ${capitalize(prop.items?.type ?? 'any')}`;
  }
  if (
    prop.type === 'object' &&
    prop.properties &&
    Object.keys(prop.properties).length > 0
  ) {
    const typeName = toPascalCase(name);
    return `[${typeName}](#${typeName.toLowerCase()})`;
  }
  return getSimpleTypeName(prop);
};

// ── YAML syntax block ─────────────────────────────────────────────────────

const ind = (n: number): string => '  '.repeat(n);

/**
 * Render YAML syntax lines for a properties map.
 * - Simple types          → `name: Type`
 * - Arrays of scalars     → `name:\n  - Type`  (YAML list syntax)
 * - Arrays of objects     → `name: TypeName[]`
 * - Objects with props    → `name: TypeName`
 */
const renderYamlSyntaxLines = (
  properties: Record<string, OpenApiSchema>,
  baseIndent: number
): string[] => {
  const lines: string[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    if (prop.type === 'array') {
      if (
        prop.items?.properties &&
        Object.keys(prop.items.properties).length > 0
      ) {
        // Array of objects → TypeName[]
        lines.push(`${ind(baseIndent)}${name}: ${toPascalCase(name)}[]`);
      } else {
        // Array of simple types → Type[]
        const itemType = capitalize(prop.items?.type ?? 'any');
        lines.push(`${ind(baseIndent)}${name}: ${itemType}[]`);
      }
    } else if (
      prop.type === 'object' &&
      prop.properties &&
      Object.keys(prop.properties).length > 0
    ) {
      // Object with known sub-properties → TypeName
      lines.push(`${ind(baseIndent)}${name}: ${toPascalCase(name)}`);
    } else {
      lines.push(`${ind(baseIndent)}${name}: ${getSimpleTypeName(prop)}`);
    }
  }

  return lines;
};

/**
 * Build the Syntax section: a fenced YAML code block (preserves Docusaurus
 * styling) followed by a _Types:_ line of links to any sub-type sections.
 */
const renderSyntaxBlock = (
  resourceType: string,
  schema: OpenApiSchema
): string => {
  const props = schema.properties ?? {};
  const lines = [
    `type: ${resourceType}`,
    `properties:`,
    ...renderYamlSyntaxLines(props, 1),
  ];
  const codeBlock = ['```yaml', ...lines, '```'].join('\n');

  // Collect links for types that have a sub-type section
  const typeLinks: string[] = [];
  for (const [name, prop] of Object.entries(props)) {
    if (
      prop.type === 'array' &&
      prop.items?.properties &&
      Object.keys(prop.items.properties).length > 0
    ) {
      const typeName = toPascalCase(name);
      typeLinks.push(`[${typeName}[]](#${typeName.toLowerCase()})`);
    } else if (
      prop.type === 'object' &&
      prop.properties &&
      Object.keys(prop.properties).length > 0
    ) {
      const typeName = toPascalCase(name);
      typeLinks.push(`[${typeName}](#${typeName.toLowerCase()})`);
    }
  }

  if (typeLinks.length === 0) {
    return codeBlock;
  }

  return codeBlock + '\n\n_Types: ' + typeLinks.join(' · ') + '_';
};

// ── Properties section ────────────────────────────────────────────────────

/** Render a single property in CloudFormation definition-list style. */
const renderPropertyEntry = (
  name: string,
  prop: OpenApiSchema,
  required: Set<string>
): string => {
  const description = escapeMdx(prop.description ?? '');
  const parts: string[] = [
    `**\`${name}\`**`,
    '',
    description,
    '',
    `_Required_: ${required.has(name) ? 'Yes' : 'No'}`,
    `_Type_: ${renderDisplayType(name, prop)}`,
  ];
  if (prop.nullable) {
    parts.push(`_Nullable_: Yes`);
  }
  parts.push('', '---', '');
  return parts.join('\n');
};

// ── Sub-type collection ───────────────────────────────────────────────────

interface SubType {
  typeName: string;
  description: string;
  schema: OpenApiSchema;
}

/**
 * Walk a properties map and collect every nested object / array-item type
 * that has its own properties defined (depth-first order).
 */
const collectSubTypes = (
  properties: Record<string, OpenApiSchema>
): SubType[] => {
  const result: SubType[] = [];

  for (const [name, prop] of Object.entries(properties)) {
    if (
      prop.type === 'object' &&
      prop.properties &&
      Object.keys(prop.properties).length > 0
    ) {
      const typeName = toPascalCase(name);
      result.push({
        typeName,
        description: `Properties of the \`${name}\` object.`,
        schema: prop,
      });
      result.push(...collectSubTypes(prop.properties));
    }
    if (
      prop.type === 'array' &&
      prop.items?.properties &&
      Object.keys(prop.items.properties).length > 0
    ) {
      const typeName = toPascalCase(name);
      result.push({
        typeName,
        description: `Properties of each item in \`${name}\`.`,
        schema: prop.items,
      });
      result.push(...collectSubTypes(prop.items.properties));
    }
  }

  return result;
};

/** Render a sub-type section (### TypeName). */
const renderSubTypeSection = (subType: SubType): string => {
  const required = new Set(subType.schema.required ?? []);
  const properties = subType.schema.properties ?? {};

  const lines: string[] = [
    `### ${subType.typeName}`,
    '',
    subType.description,
    '',
  ];

  for (const [name, prop] of Object.entries(properties)) {
    lines.push(renderPropertyEntry(name, prop, required));
  }

  return lines.join('\n');
};

/** Operations note for resource types with non-standard lifecycle support. */
const OPERATION_NOTES: Record<string, string> = {
  document:
    'Supports **create** and **delete** only. Updates are not applied — ' +
    'to replace content, delete and re-create the resource.',
};

// ── Page generators ────────────────────────────────────────────────────────

/** Generate the content for a single resource-type page. */
const renderResourcePage = (args: {
  resourceType: string;
  schema: OpenApiSchema;
  position: number;
}): string => {
  const { resourceType, schema, position } = args;
  const title = toTitle(resourceType);
  const description =
    schema.description ??
    `Properties for the \`${resourceType}\` resource type.`;
  const operationNote = OPERATION_NOTES[resourceType];

  const lines: string[] = [
    '---',
    `sidebar_label: ${title}`,
    `sidebar_position: ${position}`,
    '---',
    '',
    `# ${title}`,
    '',
    '> This page is auto-generated from the formations OpenAPI spec.',
    '> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.',
    '',
    description,
    '',
  ];

  if (operationNote) {
    lines.push(`:::note`);
    lines.push(operationNote);
    lines.push(':::');
    lines.push('');
  }

  // Syntax section
  lines.push('## Syntax');
  lines.push('');
  lines.push(renderSyntaxBlock(resourceType, schema));
  lines.push('');

  // Output section
  lines.push('## Output');
  lines.push('');
  lines.push(
    'The physical resource ID is the **public ID** of the created resource. ' +
      'Reference it from other resources with a `ref` expression:'
  );
  lines.push('');
  lines.push('```yaml');
  lines.push(`      some_field:`);
  lines.push(`        ref: My${toPascalCase(resourceType)}`);
  lines.push('```');
  lines.push('');

  // Properties section
  const required = new Set(schema.required ?? []);
  const properties = schema.properties ?? {};

  lines.push('## Properties');
  lines.push('');

  if (Object.keys(properties).length === 0) {
    lines.push('_No properties defined._');
    lines.push('');
  } else {
    for (const [name, prop] of Object.entries(properties)) {
      lines.push(renderPropertyEntry(name, prop, required));
    }
  }

  // Sub-type sections
  const subTypes = collectSubTypes(properties);
  if (subTypes.length > 0) {
    lines.push('## Sub-types');
    lines.push('');
    for (const subType of subTypes) {
      lines.push(renderSubTypeSection(subType));
    }
  }

  return lines.join('\n');
};

/** Generate the index page that lists all resource types. */
const renderIndexPage = (
  resourceTypes: Array<{ resourceType: string; description: string }>
): string => {
  const lines: string[] = [
    '---',
    'sidebar_label: Resource Types',
    'sidebar_position: 1',
    '---',
    '',
    '# Formation Resource Types',
    '',
    '> This page is auto-generated from the formations OpenAPI spec.',
    '> Do not edit manually — run `pnpm generate-formations-resource-docs` to regenerate.',
    '',
    'Each resource type that can be declared in a Formation template is listed below.',
    'Click a type to see its full properties reference.',
    '',
    '## Output',
    '',
    'All resource types return the **public ID** of the created resource as their output.',
    'You can reference this ID in other resource properties with a `ref` expression:',
    '',
    '```yaml',
    'resources:',
    '  MyMemory:',
    '    type: memory',
    '    properties:',
    '      name: My Memory',
    '',
    '  MyEntry:',
    '    type: memory_entry',
    '    properties:',
    '      memory_id:',
    '        ref: MyMemory   # resolves to the public ID of MyMemory',
    '      content: Hello, world',
    '```',
    '',
    '## Types',
    '',
    '| Type | Description |',
    '| ---- | ----------- |',
  ];

  for (const { resourceType, description } of resourceTypes) {
    const title = toTitle(resourceType);
    const slug = toSlug(resourceType);
    lines.push(`| [\`${resourceType}\`](./${slug}) | ${description} |`);
  }

  lines.push('');

  return lines.join('\n');
};

// ── Main ───────────────────────────────────────────────────────────────────

const main = () => {
  const raw = fs.readFileSync(FORMATIONS_YAML, 'utf-8');
  const spec = yaml.load(raw) as OpenApiSpec;
  const schemas = spec.components?.schemas ?? {};

  // Canonical order from the ResourceDeclaration enum
  const resourceTypeOrder: string[] =
    (schemas['ResourceDeclaration']?.properties?.['type']?.enum as string[]) ??
    [];

  // Clean up old locations if they still exist
  const legacyPaths = [
    path.resolve(__dirname, '../docs/modules/formation-resource-types.md'),
    path.resolve(__dirname, '../docs/modules/formation-resource-types'),
  ];
  for (const legacy of legacyPaths) {
    if (fs.existsSync(legacy)) {
      fs.rmSync(legacy, { recursive: true });
      console.log(`✓ Removed legacy ${legacy}`);
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  // Write _category_.json for Docusaurus sidebar
  const categoryJson = {
    label: 'Formations Types',
    position: 6,
    link: { type: 'doc', id: 'formations-types/index' },
  };
  fs.writeFileSync(
    path.join(OUTPUT_DIR, '_category_.json'),
    JSON.stringify(categoryJson, null, 2) + '\n',
    'utf-8'
  );

  // Collect per-type metadata for the index page
  const indexEntries: Array<{ resourceType: string; description: string }> = [];

  // Write one page per resource type
  resourceTypeOrder.forEach((resourceType, idx) => {
    const schemaName = `${toPascalCase(resourceType)}ResourceProperties`;
    const schema = schemas[schemaName];

    const description =
      schema?.description ??
      `Properties for the \`${resourceType}\` resource type.`;
    indexEntries.push({ resourceType, description });

    if (!schema) {
      console.warn(`⚠  No schema found for ${schemaName} — skipping page`);
      return;
    }

    const content = renderResourcePage({
      resourceType,
      schema,
      position: idx + 2, // index is position 1
    });

    const filePath = path.join(OUTPUT_DIR, `${toSlug(resourceType)}.md`);
    fs.writeFileSync(filePath, content, 'utf-8');
    console.log(`✓ Generated ${filePath}`);
  });

  // Write index page
  const indexContent = renderIndexPage(indexEntries);
  const indexPath = path.join(OUTPUT_DIR, 'index.md');
  fs.writeFileSync(indexPath, indexContent, 'utf-8');
  console.log(`✓ Generated ${indexPath}`);
};

main();
