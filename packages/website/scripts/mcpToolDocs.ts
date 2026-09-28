/**
 * The tools and arguments the MCP tools reference documents, one entry per
 * tool, read from the same OpenAPI specs the server derives its tools from.
 */

import {
  deriveToolDefinitions,
  type ToolDefinition as DerivedTool,
} from '../../server/src/lib/soatToolsDerivation';
import {
  type BodyProp,
  getBodyProps,
  getOperationParams,
  loadOperations,
  mcpToolName,
  type ModuleConfig,
  type OperationEntry,
  type OperationParam,
} from './openapiReferenceHelpers';

export interface ToolArgument {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface ToolEntry {
  name: string;
  description: string;
  args: ToolArgument[];
}

/** The tool the server derives for each operation, keyed by operationId. */
export type ToolSurface = Map<string, DerivedTool>;

/**
 * The tool surface the server exposes, from the derivation it runs itself, so
 * the reference documents exactly the arguments a tool accepts.
 */
export const loadToolSurface = (modules: ModuleConfig[]): ToolSurface => {
  const tools = deriveToolDefinitions({
    specs: modules.map((mod) => {
      return { file: `${mod.file}.yaml`, spec: mod.spec };
    }),
  });
  return new Map(
    tools.map((tool) => {
      return [tool.operationId, tool];
    })
  );
};

/**
 * What the spec says about each field an operation declares: its type label
 * and description, which keep the names a `$ref` gives and the derived tool
 * schema flattens away.
 */
const fieldDocs = (args: {
  entry: OperationEntry;
  mod: ModuleConfig;
}): Map<string, ToolArgument> => {
  const { entry, mod } = args;
  const params = getOperationParams({
    operation: entry.operation,
    spec: mod.spec,
  }).map((param: OperationParam) => {
    return {
      name: param.name,
      type: param.type,
      required: param.required,
      description: param.description,
    };
  });
  const bodyProps = getBodyProps({
    operation: entry.operation,
    spec: mod.spec,
  }).map((prop: BodyProp) => {
    return {
      name: prop.snakeName,
      type: prop.type,
      required: prop.required,
      description: prop.description,
    };
  });
  return new Map(
    [...params, ...bodyProps].map((field) => {
      return [field.name, field];
    })
  );
};

/**
 * A field of a derived tool's property schema as text: a string as is, a list
 * of strings (a JSON Schema union type) joined the way the type labels write a
 * union, anything else empty.
 */
const derivedField = (args: { schema: unknown; key: string }): string => {
  const { schema, key } = args;
  if (typeof schema !== 'object' || schema === null) return '';
  const value: unknown = Reflect.get(schema, key);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => {
        return typeof item === 'string';
      })
      .join(' | ');
  }
  return '';
};

const buildTool = (args: {
  entry: OperationEntry;
  mod: ModuleConfig;
  surface: ToolSurface;
}): ToolEntry | null => {
  const { entry, mod, surface } = args;
  const tool = surface.get(entry.operationId);
  if (!tool) return null;

  const docs = fieldDocs({ entry, mod });
  const required = new Set(tool.inputSchema.required ?? []);
  const properties = tool.inputSchema.properties ?? {};

  return {
    name: mcpToolName(entry.operationId),
    description: entry.description,
    args: Object.entries(properties).map(([name, schema]) => {
      const doc = docs.get(name);
      return {
        name,
        type: doc?.type ?? derivedField({ schema, key: 'type' }),
        required: required.has(name),
        description:
          doc?.description || derivedField({ schema, key: 'description' }),
      };
    }),
  };
};

export const loadTools = (args: {
  mod: ModuleConfig;
  surface: ToolSurface;
}): ToolEntry[] => {
  const { mod, surface } = args;
  return loadOperations(mod.spec)
    .map((entry) => {
      return buildTool({ entry, mod, surface });
    })
    .filter((tool): tool is ToolEntry => {
      return tool !== null;
    });
};
