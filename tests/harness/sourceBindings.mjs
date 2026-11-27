import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * A server source file's top-level bindings, and the declaration a name
 * resolves to across `import` and `export { } from`.
 */

const serverRoot = fileURLToPath(
  new URL('../../packages/server', import.meta.url)
);

const sources = new Map();
export const parse = (file) => {
  if (!sources.has(file)) {
    sources.set(
      file,
      ts.createSourceFile(
        file,
        fs.readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true
      )
    );
  }
  return sources.get(file);
};

const resolveImport = (from, specifier) => {
  const base = specifier.startsWith('src/')
    ? path.join(serverRoot, specifier)
    : specifier.startsWith('.')
      ? path.resolve(path.dirname(from), specifier)
      : undefined;
  if (!base) return undefined;
  return [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => {
    return fs.existsSync(candidate);
  });
};

export const propName = (node) => {
  return (ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node)) &&
    !ts.isComputedPropertyName(node.name)
    ? node.name.text
    : undefined;
};

export const literalProp = (node, name) => {
  if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
  const prop = node.properties.find((candidate) => {
    return propName(candidate) === name;
  });
  return prop &&
    ts.isPropertyAssignment(prop) &&
    ts.isStringLiteralLike(prop.initializer)
    ? prop.initializer.text
    : undefined;
};

export const isFunction = (node) => {
  return (
    node !== undefined &&
    (ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node))
  );
};

/** The named bindings an `import { } from` or `export { } from` carries. */
const namedClause = (statement) => {
  const named = ts.isImportDeclaration(statement)
    ? statement.importClause?.namedBindings
    : statement.exportClause;
  return named && (ts.isNamedImports(named) || ts.isNamedExports(named))
    ? named
    : undefined;
};

/** `import { a as b } from` into `imports`, `export { a as b } from` into `reexports`. */
const addImports = (bindings, file, statement) => {
  const specifier = statement.moduleSpecifier?.text;
  const target = specifier && resolveImport(file, specifier);
  const named = namedClause(statement);
  if (!target || !named) return;
  const into = ts.isImportDeclaration(statement)
    ? bindings.imports
    : bindings.reexports;
  for (const element of named.elements) {
    into.set(element.name.text, {
      file: target,
      name: (element.propertyName ?? element.name).text,
    });
  }
};

const addDeclaration = (bindings, { name, initializer }) => {
  if (!ts.isIdentifier(name) || !initializer) return;
  if (ts.isStringLiteralLike(initializer)) {
    bindings.consts.set(name.text, initializer.text);
  } else if (isFunction(initializer)) {
    bindings.functions.set(name.text, initializer);
  } else if (ts.isCallExpression(initializer)) {
    // `makeItemRouteAuthorizer({ resourceType: 'collection', … })`
    const type = literalProp(initializer.arguments[0], 'resourceType');
    if (type) bindings.typed.set(name.text, type);
  }
};

/** A file's top-level functions, string consts, imports and typed factories. */
const bindingsCache = new Map();
const bindingsOf = (file) => {
  if (bindingsCache.has(file)) return bindingsCache.get(file);
  const bindings = {
    functions: new Map(),
    consts: new Map(),
    imports: new Map(),
    reexports: new Map(),
    typed: new Map(),
  };
  bindingsCache.set(file, bindings);
  for (const statement of parse(file).statements) {
    if (
      ts.isImportDeclaration(statement) ||
      ts.isExportDeclaration(statement)
    ) {
      addImports(bindings, file, statement);
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      bindings.functions.set(statement.name.text, statement);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addDeclaration(bindings, declaration);
      }
    }
  }
  return bindings;
};

/** The file declaring what `file` exports as `name`, through `export { } from`. */
const declarationOf = (file, name, seen = new Set()) => {
  const reexport = bindingsOf(file).reexports.get(name);
  if (!reexport || seen.has(file)) return { file, name };
  seen.add(file);
  return declarationOf(reexport.file, reexport.name, seen);
};

/** The file and name declaring what `file` imports as `name`. */
export const importOf = (file, name) => {
  const imported = bindingsOf(file).imports.get(name);
  return imported && declarationOf(imported.file, imported.name);
};

/** `name` as `file` sees it: its own binding, else the one it imports. */
export const lookup = (file, name, kind) => {
  const own = bindingsOf(file);
  if (own[kind].has(name)) return { file, value: own[kind].get(name) };
  const imported = importOf(file, name);
  if (!imported) return undefined;
  const value = bindingsOf(imported.file)[kind].get(imported.name);
  return value === undefined ? undefined : { file: imported.file, value };
};
