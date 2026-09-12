/**
 * Inlines the shared spec components on the way into `@ttoss/openapi-codegen`.
 *
 * That generator resolves a `$ref` only within the file it appears in, and
 * never through `allOf`. A cross-file reference therefore reaches it
 * unresolved, and both failures are silent: a `$ref`'d query parameter is
 * dropped from the manifest entirely, and a `$ref`'d body property loses its
 * type and falls back to `string`. The manifest still generates; the flag
 * simply stops working.
 *
 * The specs are cross-file on purpose — the tag bag every tagged resource
 * carries is declared once in `tags.yaml` rather than inlined thirty times — so
 * the accommodation belongs here rather than in the specs.
 *
 * Only components declared by a **shared** spec (one with no paths of its own)
 * are inlined. A reference between two module specs is left exactly as the
 * generator sees it today, so this changes nothing but the components it could
 * not reach.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as yaml from 'js-yaml';

const COMPONENT_SECTIONS = ['schemas', 'parameters', 'responses'] as const;

type Components = Record<string, Record<string, unknown>>;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

/** The component a `$ref` names, when a shared spec declares it. */
const sharedTarget = (
  ref: unknown,
  shared: Components
): Record<string, unknown> | undefined => {
  if (typeof ref !== 'string') return undefined;
  const match = /#\/components\/(\w+)\/(\w+)$/.exec(ref);
  if (!match) return undefined;
  const found = shared[match[1]]?.[match[2]];
  return isRecord(found) ? found : undefined;
};

/**
 * Replaces every reference to a shared component with the component itself.
 *
 * Two shapes carry one: the bare `{ $ref }`, and `{ description, allOf: [{ $ref }] }`
 * — the form a site uses to keep its own wording over the shared shape. Sibling
 * keys win over the component's, which is what makes the second shape mean what
 * it reads as.
 */
export const inlineSharedComponents = (
  value: unknown,
  shared: Components
): unknown => {
  if (Array.isArray(value)) {
    return value.map((item) => {
      return inlineSharedComponents(item, shared);
    });
  }
  if (!isRecord(value)) return value;

  const direct = sharedTarget(value.$ref, shared);
  if (direct) return structuredClone(direct);

  const { allOf, ...rest } = value;
  if (Array.isArray(allOf) && allOf.length === 1 && isRecord(allOf[0])) {
    const composed = sharedTarget(allOf[0].$ref, shared);
    if (composed) {
      return {
        ...structuredClone(composed),
        ...(inlineSharedComponents(rest, shared) as Record<string, unknown>),
      };
    }
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      return [key, inlineSharedComponents(entry, shared)];
    })
  );
};

/** The components declared by specs that carry no paths of their own. */
export const collectSharedComponents = (specs: unknown[]): Components => {
  const shared: Components = {};

  for (const spec of specs) {
    if (!isRecord(spec) || !isRecord(spec.components)) continue;
    if (isRecord(spec.paths) && Object.keys(spec.paths).length > 0) continue;
    for (const section of COMPONENT_SECTIONS) {
      const incoming = spec.components[section];
      if (!isRecord(incoming)) continue;
      shared[section] = { ...shared[section], ...incoming };
    }
  }

  return shared;
};

/**
 * Writes every module spec into `outDir` with the shared components inlined. A
 * shared spec is not written: it declares no operations, so a generator reading
 * the directory would otherwise take it for an empty module.
 */
export const localizeSpecs = (args: {
  specsDir: string;
  outDir: string;
}): string[] => {
  const files = fs
    .readdirSync(args.specsDir)
    .filter((file) => {
      return file.endsWith('.yaml') || file.endsWith('.yml');
    })
    .sort();

  const loaded = files.map((file) => {
    return {
      file,
      spec: yaml.load(
        fs.readFileSync(path.join(args.specsDir, file), 'utf8')
      ) as unknown,
    };
  });

  const shared = collectSharedComponents(
    loaded.map(({ spec }) => {
      return spec;
    })
  );

  fs.mkdirSync(args.outDir, { recursive: true });

  const written: string[] = [];
  for (const { file, spec } of loaded) {
    if (!isRecord(spec)) continue;
    if (!isRecord(spec.paths) || Object.keys(spec.paths).length === 0) continue;

    fs.writeFileSync(
      path.join(args.outDir, file),
      yaml.dump(inlineSharedComponents(spec, shared), {
        lineWidth: -1,
        noRefs: true,
      })
    );
    written.push(file);
  }

  return written;
};
