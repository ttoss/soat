/**
 * Generates MCP tool registration files directly from OpenAPI YAML specs.
 * Run with: pnpm tsx scripts/generateSoatTools.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

import yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../src/rest/openapi/v1');
const OUTPUT_DIR = path.resolve(__dirname, '../src/mcp/tools/generated');

interface OpenApiSpec {
  paths?: Record<string, Record<string, unknown>>;
  components?: {
    schemas?: Record<string, unknown>;
  };
}

interface OperationSpec {
  operationId?: string;
  description?: string;
  parameters?: Array<{
    name: string;
    in: string;
    required?: boolean;
    description?: string;
    schema?: {
      type?: string;
      items?: { type?: string };
    };
  }>;
  requestBody?: {
    required?: boolean;
    content?: {
      'application/json'?: {
        schema?: {
          type?: string;
          required?: string[];
          properties?: Record<string, unknown>;
        };
      };
    };
  };
  'x-iam-action'?: string;
}

const snakeToCamel = (str: string): string => {
  return str.replace(/[_-]([a-z])/g, (_, letter) => {
    return letter.toUpperCase();
  });
};

const getJsonSchemaType = (schemaType: string | undefined): string => {
  if (schemaType === 'integer' || schemaType === 'number') return 'number';
  if (schemaType === 'boolean') return 'boolean';
  if (schemaType === 'array') return 'array';
  return 'string';
};

/**
 * Builds the apiCall path expression (a string literal or template literal).
 * Returns the expression as a TypeScript source string.
 */
const buildPathExpr = (
  pathTemplate: string,
  pathParams: Array<{ name: string; camelName: string }>,
  queryParams: Array<{ name: string; camelName: string; required: boolean }>
): { lines: string[]; pathExpr: string } => {
  const lines: string[] = [];

  if (pathParams.length === 0 && queryParams.length === 0) {
    return { lines, pathExpr: `'${pathTemplate}'` };
  }

  let resolvedTemplate = pathTemplate;
  for (const { camelName } of pathParams) {
    resolvedTemplate = resolvedTemplate.replace(
      `{${camelName}}`,
      `\${args.${camelName}}`
    );
  }

  if (queryParams.length > 0) {
    lines.push(`const params = new URLSearchParams();`);
    for (const { camelName } of queryParams) {
      lines.push(
        `if (args.${camelName} !== undefined) params.set('${camelName}', String(args.${camelName}));`
      );
    }
    lines.push(`const qs = params.toString();`);
    const base =
      pathParams.length > 0 ? `\`${resolvedTemplate}\`` : `'${pathTemplate}'`;
    return { lines, pathExpr: `qs ? ${base} + '?' + qs : ${base}` };
  }

  return { lines, pathExpr: `\`${resolvedTemplate}\`` };
};

const generateInputSchema = (
  pathParams: Array<{ name: string; camelName: string }>,
  queryParams: Array<{
    name: string;
    camelName: string;
    description: string;
    required: boolean;
    type: string;
  }>,
  bodyProps: Array<{
    snakeName: string;
    camelName: string;
    description: string;
    required: boolean;
    type: string;
  }>
): string => {
  const allParams = [...pathParams, ...queryParams, ...bodyProps];

  if (allParams.length === 0) {
    return `{
      type: 'object',
    }`;
  }

  const requiredFields = [
    ...pathParams.map((p) => {
      return p.camelName;
    }),
    ...queryParams
      .filter((p) => {
        return p.required;
      })
      .map((p) => {
        return p.camelName;
      }),
    ...bodyProps
      .filter((p) => {
        return p.required;
      })
      .map((p) => {
        return p.camelName;
      }),
  ];

  let code = `{
      type: 'object',
      properties: {`;

  for (const param of allParams) {
    const jsonType = getJsonSchemaType(param.type);
    const typeStr =
      param.type === 'array'
        ? `'array', items: { type: 'string' }`
        : `'${jsonType}'`;
    const desc =
      (param.description || '')
        .replace(/'/g, "\\'")
        .replace(/\n/g, ' ')
        .trim() || '';
    code += `\n        ${param.camelName}: { type: ${typeStr}, description: '${desc}' },`;
  }

  code += `\n      },`;

  if (requiredFields.length > 0) {
    code += `\n      required: [${requiredFields
      .map((f) => {
        return `'${f}'`;
      })
      .join(', ')}],`;
  }

  code += `\n    }`;
  return code;
};

const operationIdToToolName = (operationId: string): string => {
  // Convert camelCase to kebab-case (listActors -> list-actors)
  return operationId
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
};

const generateTool = (
  method: string,
  pathTemplate: string,
  operation: OperationSpec,
  tag: string
): string | null => {
  if (!operation.operationId) return null;

  const toolName = operationIdToToolName(operation.operationId);

  // Extract path parameters
  const pathParams = (operation.parameters || [])
    .filter((p) => {
      return p.in === 'path';
    })
    .map((p) => {
      return {
        name: p.name,
        camelName: snakeToCamel(p.name),
      };
    });

  // Extract query parameters
  const queryParams = (operation.parameters || [])
    .filter((p) => {
      return p.in === 'query';
    })
    .map((p) => {
      return {
        name: p.name,
        camelName: snakeToCamel(p.name),
        description: p.description || '',
        required: p.required || false,
        type: p.schema?.type || 'string',
      };
    });

  // Extract body properties
  const bodySchema =
    operation.requestBody?.content?.['application/json']?.schema;
  const bodyProps = bodySchema?.properties
    ? Object.entries(bodySchema.properties).map(
        ([key, value]: [string, any]) => {
          return {
            snakeName: key,
            camelName: snakeToCamel(key),
            description: value.description || '',
            required: (bodySchema.required || []).includes(key),
            type: value.type || 'string',
          };
        }
      )
    : [];

  const inputSchema = generateInputSchema(pathParams, queryParams, bodyProps);
  const { lines: pathLines, pathExpr } = buildPathExpr(
    pathTemplate,
    pathParams,
    queryParams
  );

  const indent = '        ';
  const handlerLines: string[] = [];
  for (const line of pathLines) {
    handlerLines.push(`${indent}${line}`);
  }

  let bodyArg = '{}';
  if (bodyProps.length > 0) {
    const bodyEntries = bodyProps
      .map(({ snakeName, camelName }) => {
        return `${snakeName}: args.${camelName}`;
      })
      .join(', ');
    bodyArg = `{ body: { ${bodyEntries} } }`;
  }

  const desc = (operation.description || '')
    .replace(/'/g, "\\'")
    .replace(/\n/g, ' ')
    .trim();

  const handlerBody = [
    ...handlerLines,
    `${indent}const data = await apiCall('${method}', ${pathExpr}, ${bodyArg});`,
    `${indent}return { content: [{ type: 'text' as const, text: toMcpText(data) }] };`,
  ].join('\n');

  return `  registerToolFromSchema(server, {
    name: '${toolName}',
    description: '${desc}',
    inputSchema: ${inputSchema},
    handler: async (args: Record<string, unknown>) => {
${handlerBody}
    },
  });`;
};

const generateToolsFile = (
  filename: string,
  specPath: string
): string | null => {
  const spec = yaml.load(fs.readFileSync(specPath, 'utf-8')) as OpenApiSpec;

  const toolRegistrations: string[] = [];
  const paths = spec.paths || {};

  // Derive tag from filename for iamAction (not used in MCP but consistent)
  const tag =
    filename
      .replace('.yaml', '')
      .split('-')
      .map((word) => {
        return word.charAt(0).toUpperCase() + word.slice(1);
      })
      .join('') || 'Resource';

  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    const pathItemObj = pathItem as Record<string, OperationSpec>;
    for (const [method, operation] of Object.entries(pathItemObj)) {
      const httpMethod = method.toUpperCase();
      if (['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(httpMethod)) {
        const tool = generateTool(httpMethod, pathTemplate, operation, tag);
        if (tool) {
          toolRegistrations.push(tool);
        }
      }
    }
  }

  if (toolRegistrations.length === 0) return null;

  const moduleName = snakeToCamel(filename.replace('.yaml', ''));
  const exportName = `register${moduleName.charAt(0).toUpperCase() + moduleName.slice(1)}Tools`;

  const content = `// DO NOT EDIT — generated by scripts/generateSoatTools.ts
import type { McpServer } from '@ttoss/http-server-mcp';
import { apiCall, registerToolFromSchema } from '@ttoss/http-server-mcp';

import { toMcpText } from '../caseTransform';

export const ${exportName} = (server: McpServer) => {
${toolRegistrations.join('\n\n')}
};
`;

  const outputFile = path.join(
    OUTPUT_DIR,
    `${filename.replace('.yaml', '')}.ts`
  );
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(outputFile, content, 'utf-8');
  console.log(`Generated ${outputFile}`);
  return exportName;
};

const main = () => {
  const files = fs
    .readdirSync(SPECS_DIR)
    .filter((f) => {
      return f.endsWith('.yaml');
    })
    .sort();

  // Clear output directory
  if (fs.existsSync(OUTPUT_DIR)) {
    fs.rmSync(OUTPUT_DIR, { recursive: true });
  }
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const generated: Array<{ file: string; exportName: string }> = [];

  for (const file of files) {
    try {
      const exportName = generateToolsFile(file, path.join(SPECS_DIR, file));
      if (exportName) {
        generated.push({ file: file.replace('.yaml', ''), exportName });
      }
    } catch (error) {
      console.error(`Error processing ${file}:`, error);
    }
  }

  // Generate index.ts with a single registerGeneratedTools function
  const imports = generated
    .map(({ file, exportName }) => {
      return `import { ${exportName} } from './${file}';`;
    })
    .join('\n');

  const calls = generated
    .map(({ exportName }) => {
      return `  ${exportName}(server);`;
    })
    .join('\n');

  const indexContent = `// DO NOT EDIT — generated by scripts/generateSoatTools.ts
import type { McpServer } from '@ttoss/http-server-mcp';

${imports}

export const registerGeneratedTools = (server: McpServer) => {
${calls}
};
`;

  fs.writeFileSync(path.join(OUTPUT_DIR, 'index.ts'), indexContent, 'utf-8');
  console.log(`Generated ${path.join(OUTPUT_DIR, 'index.ts')}`);
};

main();
