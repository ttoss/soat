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
  type Route,
} from '@ttoss/openapi-codegen';
import * as yaml from 'js-yaml';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const SPECS_DIR = path.resolve(__dirname, '../../server/src/rest/openapi/v1');
const OUT_FILE = path.resolve(__dirname, '../src/generated/routes.ts');
const MODULE_DOCS_BASE_URL = 'https://soat.ttoss.dev/docs/modules';

/**
 * The manifest type for a property the specs leave **typeless**.
 *
 * OpenAPI 3.0 has no union `type`, so a property that genuinely accepts more
 * than one shape omits it — `tool_choice` takes the string `"auto"` *or* an
 * object `{ type: 'tool', tool_name: '…' }`. `generateCliRouteManifest`
 * defaults a missing type to `"string"` (`propSchema.type ?? 'string'`), and
 * that default is not cosmetic: `parseFlagValue` never JSON-coerces a
 * *declared-string* flag — deliberately, so a JSON key file survives
 * `create-secret --value "$(cat key.json)"` — so the object form reached the
 * server as the literal text `{"type":"tool",…}`, `normalizeToolChoice` mapped
 * the unrecognized string to `undefined`, and forcing was silently dropped at
 * every layer (#955).
 *
 * `'any'` puts these flags back on the permissive path, where a `{`/`[` value
 * is parsed as JSON and a bare word stays a string — so both shapes work. In
 * JSON Schema an absent `type` means exactly that: any type.
 */
const UNION_FLAG_TYPE = 'any';

/**
 * The prefix every REST operation shares.
 *
 * `oauth.yaml` also describes the OAuth 2.1 protocol endpoints — `/authorize`,
 * `/token`, `/register` and the two `.well-known` documents — which
 * `@ttoss/auth-core` mounts at the root with paths the RFCs fix. They are in a
 * spec so a client (or an agent reading `/openapi.json`) can find the flow
 * without a live host to probe; a CLI command for them would be actively wrong.
 * `/authorize` is a browser redirect, `/token` takes a form-encoded body the
 * manifest has no way to send, and `soat register` reads as a SOAT sign-up
 * rather than OAuth client registration.
 *
 * The SDK generator and the server's MCP tool surface apply the same rule.
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

/**
 * Keys that delegate a property's shape elsewhere. A property carrying one of
 * these is not "typeless" in the sense that matters here — its schema is
 * defined by the referenced/composed schema, not absent.
 */
const DELEGATING_KEYS = ['$ref', 'allOf', 'oneOf', 'anyOf', 'enum'];

/** Files one property under `stringTyped`, `typeless`, or neither. */
const classifyProperty = (args: {
  name: string;
  schema: unknown;
  typeless: Set<string>;
  stringTyped: Set<string>;
}): void => {
  const { name, schema, typeless, stringTyped } = args;

  if (!isRecord(schema)) return;

  if (schema.type === 'string') {
    stringTyped.add(name);
    return;
  }
  // Any other declared type: neither a union nor a string — nothing to record.
  if (typeof schema.type === 'string') return;

  const delegates = DELEGATING_KEYS.some((key) => {
    return key in schema;
  });
  if (!delegates) typeless.add(name);
};

/**
 * Walks every schema in a spec, classifying each property it finds.
 *
 * The walk is deliberately structure-blind — it recurses through the whole
 * document rather than resolving request bodies the way the codegen does.
 * Mirroring the codegen's `$ref` + `oneOf` merge would duplicate logic that
 * lives in another package and could drift from it; collecting names and
 * subtracting the string-typed ones needs no such knowledge.
 */
const collectPropertyTypes = (args: {
  node: unknown;
  typeless: Set<string>;
  stringTyped: Set<string>;
  seen: Set<object>;
}): void => {
  const { node, typeless, stringTyped, seen } = args;

  if (Array.isArray(node)) {
    for (const item of node) {
      collectPropertyTypes({ node: item, typeless, stringTyped, seen });
    }
    return;
  }

  if (!isRecord(node) || seen.has(node)) return;
  seen.add(node);

  if (isRecord(node.properties)) {
    for (const [name, schema] of Object.entries(node.properties)) {
      classifyProperty({ name, schema, typeless, stringTyped });
    }
  }

  for (const value of Object.values(node)) {
    collectPropertyTypes({ node: value, typeless, stringTyped, seen });
  }
};

/**
 * Property names some schema leaves typeless and **no** schema declares
 * `type: string`.
 *
 * Excluding string-typed names is what keeps this conservative: `value` (a
 * secret's, `type: string`) is never widened, so the behavior
 * `stringFlags.test.ts` pins is untouched — that carve-out exists because a GCP
 * key file passed to `create-secret --value` was being parsed into an object.
 *
 * A *non*-string type elsewhere does not disqualify a name, which matters
 * because the specs already disagree with themselves about this exact field:
 * a step rule's `tool_choice` is declared `type: object` (`formations.yaml`)
 * while describing the same string-or-object union the typeless declarations
 * accept. Widening is still right there — the union genuinely includes an
 * object, and only flags the manifest calls `string` are retyped anyway.
 *
 * The known gap: a name that is typeless in one schema and `type: string` in
 * another stays unwidened. No such case exists today, and the alternative —
 * resolving each request body's `$ref`/`oneOf` chain the way the codegen does —
 * would duplicate another package's logic and could drift from it silently.
 */
const findUnionPropertyNames = (specsDir: string): Set<string> => {
  const typeless = new Set<string>();
  const stringTyped = new Set<string>();
  const seen = new Set<object>();

  const specFiles = fs.readdirSync(specsDir).filter((file) => {
    return file.endsWith('.yaml') || file.endsWith('.yml');
  });

  for (const file of specFiles) {
    const doc: unknown = yaml.load(
      fs.readFileSync(path.join(specsDir, file), 'utf8')
    );
    collectPropertyTypes({ node: doc, typeless, stringTyped, seen });
  }

  return new Set(
    [...typeless].filter((name) => {
      return !stringTyped.has(name);
    })
  );
};

/** Retypes body flags whose spec property is a union. Returns what changed. */
const widenUnionBodyFlags = (args: {
  routes: Record<string, Route>;
  unionNames: Set<string>;
}): string[] => {
  const widened: string[] = [];

  for (const [command, route] of Object.entries(args.routes)) {
    for (const flag of route.flags) {
      if (
        flag.in === 'body' &&
        flag.type === 'string' &&
        args.unionNames.has(flag.name)
      ) {
        flag.type = UNION_FLAG_TYPE;
        widened.push(`${command} --${flag.name}`);
      }
    }
  }

  return widened;
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

const widened = widenUnionBodyFlags({
  routes,
  unionNames: findUnionPropertyNames(SPECS_DIR),
});

fs.writeFileSync(OUT_FILE, renderCliRoutesSource(routes));
// eslint-disable-next-line no-console
console.log(`Generated ${Object.keys(routes).length} routes → ${OUT_FILE}`);
// eslint-disable-next-line no-console
console.log(
  `Widened ${widened.length} union body flag(s) to \`${UNION_FLAG_TYPE}\`${
    widened.length > 0 ? `: ${widened.join(', ')}` : ''
  }`
);
