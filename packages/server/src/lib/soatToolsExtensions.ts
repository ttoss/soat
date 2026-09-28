import type { OpenApiSpec } from '@ttoss/http-server-mcp-openapi';

/**
 * `@ttoss/http-server-mcp-openapi` reads SOAT's three tool-surface extensions
 * as one flag and tells them apart by YAML type: a string pins that value, any
 * other truthy value only hides the field. So `x-soat-tool-forced: true` would
 * hide a field without pinning it, and `x-soat-server-managed: 'yes'` would pin
 * one. Here each extension takes the one spelling that matches its name, and a
 * pin is written as the type of the field it pins, then handed to the library
 * as the text it reads.
 */
const HIDE_ONLY = ['x-soat-server-managed', 'x-soat-tool-unsupported'];
const FORCED = 'x-soat-tool-forced';
const PINNABLE = new Set(['boolean', 'integer', 'number', 'string']);

type Node = Record<string, unknown>;

type Location = { file: string; owner: string; field: string };

const isNode = (value: unknown): value is Node => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const where = (at: Location) => {
  return `${at.file} ${at.owner} '${at.field}'`;
};

/** The JSON type a pin must have to fit a field of this schema type. */
const pinType = (schemaType: unknown) => {
  return schemaType === 'integer' ? 'number' : schemaType;
};

const schemaTypeOf = (node: Node) => {
  return isNode(node.schema) ? node.schema.type : node.type;
};

const preparePin = (node: Node, at: Location) => {
  const pin = node[FORCED];
  if (pin === undefined) return;
  const schemaType = schemaTypeOf(node);
  if (typeof schemaType !== 'string' || !PINNABLE.has(schemaType)) {
    throw new Error(
      `${where(at)}: ${FORCED} pins only a boolean, integer, number or string field; got ${String(schemaType)}`
    );
  }
  if (typeof pin !== pinType(schemaType)) {
    throw new Error(
      `${where(at)}: ${FORCED} must be a ${schemaType}, like the field it pins; got ${typeof pin}`
    );
  }
  node[FORCED] = String(pin);
};

const checkHideOnly = (node: Node, at: Location) => {
  for (const extension of HIDE_ONLY) {
    const flag = node[extension];
    if (flag !== undefined && flag !== true) {
      throw new Error(
        `${where(at)}: ${extension} must be true; got ${typeof flag}`
      );
    }
  }
};

const visitField = (node: Node, at: Location) => {
  checkHideOnly(node, at);
  preparePin(node, at);
};

/** The fields `node` declares: itself as a parameter, and its properties. */
const fieldsOf = (node: Node): Array<[string, Node]> => {
  const fields: Array<[string, Node]> = [];
  if (typeof node.in === 'string' && typeof node.name === 'string') {
    fields.push([node.name, node]);
  }
  if (isNode(node.properties)) {
    for (const [field, property] of Object.entries(node.properties)) {
      if (isNode(property)) fields.push([field, property]);
    }
  }
  return fields;
};

const walk = (node: unknown, at: Location): void => {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, at);
    return;
  }
  if (!isNode(node)) return;
  const owner =
    typeof node.operationId === 'string' ? node.operationId : at.owner;
  for (const [field, fieldNode] of fieldsOf(node)) {
    visitField(fieldNode, { ...at, owner, field });
  }
  for (const value of Object.values(node)) walk(value, { ...at, owner });
};

/**
 * A copy of `spec` with every tool-surface extension checked and every pin in
 * the library's text form. Throws on a spelling whose meaning would differ
 * from its extension's name.
 */
export const prepareToolExtensions = (args: {
  spec: OpenApiSpec;
  file: string;
}): OpenApiSpec => {
  const spec = structuredClone(args.spec);
  walk(spec.paths, { file: args.file, owner: '', field: '' });
  // A component (a shared parameter, a `$ref`d body) is named by its key.
  for (const section of Object.values(spec.components ?? {})) {
    if (!isNode(section)) continue;
    for (const [owner, component] of Object.entries(section)) {
      walk(component, { file: args.file, owner, field: '' });
    }
  }
  return spec;
};
