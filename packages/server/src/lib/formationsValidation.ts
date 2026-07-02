import yaml from 'js-yaml';

import {
  buildDependencyGraph,
  collectParamRefs,
  collectRefAttrs,
  collectRefs,
  parseRefAttr,
  topologicalSort,
} from './formationsHelpers';
import { getFormationModule } from './formationsRegistry';
import type {
  FormationTemplate,
  ParameterDeclaration,
  ValidationError,
  ValidationResult,
} from './formationsTypes';
import { SUPPORTED_RESOURCE_TYPES } from './formationsTypes';

// ── Template Input Parsing ────────────────────────────────────────────────

/**
 * Parses a formation template from either a JSON/YAML string or a plain
 * object. Returns the parsed value, or the original input unchanged if it
 * is neither a string nor an object (so that validation can report the
 * appropriate error).
 */
export const parseFormationTemplateInput = (input: unknown): unknown => {
  if (typeof input !== 'string') return input;
  try {
    return yaml.load(input);
  } catch {
    // Return the raw string so validateFormationTemplate reports a useful error
    return input;
  }
};

// ── Resource Declaration Validation ──────────────────────────────────────

const validateResourceType = (args: {
  type: unknown;
  basePath: string;
}): ValidationError[] => {
  const { type, basePath } = args;
  if (!type || typeof type !== 'string') {
    return [
      {
        path: `${basePath}.type`,
        message: '`type` is required and must be a string',
      },
    ];
  }
  if (!SUPPORTED_RESOURCE_TYPES.has(type)) {
    return [
      {
        path: `${basePath}.type`,
        message: `Unsupported resource type: ${type}. Supported: ${[...SUPPORTED_RESOURCE_TYPES].join(', ')}`,
      },
    ];
  }
  return [];
};

const validateDependsOn = (args: {
  dependsOn: unknown;
  logicalIds: Set<string>;
  basePath: string;
}): ValidationError[] => {
  const { dependsOn, logicalIds, basePath } = args;
  const errors: ValidationError[] = [];
  if (!Array.isArray(dependsOn)) {
    return [
      {
        path: `${basePath}.depends_on`,
        message: '`depends_on` must be an array',
      },
    ];
  }
  for (const dep of dependsOn as unknown[]) {
    if (typeof dep !== 'string') {
      errors.push({
        path: `${basePath}.depends_on`,
        message: 'Each depends_on entry must be a string',
      });
    } else if (!logicalIds.has(dep)) {
      errors.push({
        path: `${basePath}.depends_on`,
        message: `depends_on references unknown resource '${dep}'`,
      });
    }
  }
  return errors;
};

// ── Resource Properties Validation ───────────────────────────────────────

const validateResourceProperties = (args: {
  properties: unknown;
  logicalIds: Set<string>;
  paramNames: Set<string>;
  basePath: string;
}): ValidationError[] => {
  const { properties, logicalIds, paramNames, basePath } = args;
  const errors: ValidationError[] = [];

  if (
    !properties ||
    typeof properties !== 'object' ||
    Array.isArray(properties)
  ) {
    errors.push({
      path: `${basePath}.properties`,
      message: '`properties` is required and must be an object',
    });
    return errors;
  }

  for (const ref of collectRefs(properties)) {
    if (!logicalIds.has(ref)) {
      errors.push({
        path: `${basePath}.properties`,
        message: `Referenced resource '${ref}' does not exist in template`,
      });
    }
  }

  for (const ref of collectParamRefs(properties)) {
    // body.xxx refs are runtime tool-argument interpolations, not formation params
    if (ref.startsWith('body.')) continue;
    // A sub token may also name a resource logical id (resolved to the
    // physical id at apply time).
    if (logicalIds.has(ref)) continue;
    if (!paramNames.has(ref)) {
      errors.push({
        path: `${basePath}.properties`,
        message: `'${ref}' is neither a parameter nor a resource logical id`,
      });
    }
  }

  return errors;
};

const validateResourceDeclaration = (args: {
  logicalId: string;
  declRaw: unknown;
  logicalIds: Set<string>;
  paramNames: Set<string>;
}): ValidationError[] => {
  const { logicalId, declRaw, logicalIds, paramNames } = args;
  const errors: ValidationError[] = [];
  const basePath = `resources.${logicalId}`;

  if (
    typeof declRaw !== 'object' ||
    declRaw === null ||
    Array.isArray(declRaw)
  ) {
    return [
      { path: basePath, message: 'Resource declaration must be an object' },
    ];
  }

  const decl = declRaw as Record<string, unknown>;

  errors.push(...validateResourceType({ type: decl.type, basePath }));
  errors.push(
    ...validateResourceProperties({
      properties: decl.properties,
      logicalIds,
      paramNames,
      basePath,
    })
  );

  if (typeof decl.type === 'string') {
    const formationModule = getFormationModule({
      resourceType: decl.type,
    });
    if (formationModule?.validateProperties) {
      errors.push(
        ...formationModule.validateProperties({
          properties: decl.properties,
          basePath: `${basePath}.properties`,
        })
      );
    }
  }

  if (decl.depends_on !== undefined) {
    errors.push(
      ...validateDependsOn({ dependsOn: decl.depends_on, logicalIds, basePath })
    );
  }

  if (decl.deletion_policy !== undefined) {
    if (!['delete', 'retain'].includes(decl.deletion_policy as string)) {
      errors.push({
        path: `${basePath}.deletion_policy`,
        message: '`deletion_policy` must be one of: delete, retain',
      });
    }
  }

  return errors;
};

// ── Output Refs Validation ────────────────────────────────────────────────

const validateOutputRefs = (
  outputs: Record<string, unknown>,
  logicalIds: Set<string>,
  paramNames: Set<string>
): ValidationError[] => {
  const errors: ValidationError[] = [];
  for (const [outputName, outputValue] of Object.entries(outputs)) {
    for (const ref of collectRefs(outputValue)) {
      if (!logicalIds.has(ref)) {
        errors.push({
          path: `outputs.${outputName}`,
          message: `Referenced resource '${ref}' does not exist in template`,
        });
      }
    }
    for (const refAttr of collectRefAttrs(outputValue)) {
      const parsed = parseRefAttr(refAttr);
      if (!parsed) {
        errors.push({
          path: `outputs.${outputName}`,
          message: `ref_attr '${refAttr}' must be in the form '<ResourceName>.<attribute>'`,
        });
        continue;
      }
      if (!logicalIds.has(parsed.logicalId)) {
        errors.push({
          path: `outputs.${outputName}`,
          message: `Referenced resource '${parsed.logicalId}' does not exist in template`,
        });
      }
    }
    for (const ref of collectParamRefs(outputValue)) {
      if (logicalIds.has(ref)) continue;
      if (!paramNames.has(ref)) {
        errors.push({
          path: `outputs.${outputName}`,
          message: `'${ref}' is neither a parameter nor a resource logical id`,
        });
      }
    }
  }
  return errors;
};

// ── Parameters Section Validation ─────────────────────────────────────────

const validateParametersSection = (
  parameters: Record<string, unknown>
): ValidationError[] => {
  const errors: ValidationError[] = [];
  for (const [name, decl] of Object.entries(parameters)) {
    if (typeof decl !== 'object' || decl === null || Array.isArray(decl)) {
      errors.push({
        path: `parameters.${name}`,
        message: 'Parameter declaration must be an object',
      });
      continue;
    }
    const declObj = decl as Record<string, unknown>;
    if (declObj.type !== undefined && typeof declObj.type !== 'string') {
      errors.push({
        path: `parameters.${name}.type`,
        message: '`type` must be a string',
      });
    }
  }
  return errors;
};

// ── Public API ────────────────────────────────────────────────────────────

const parseTemplateObject = (
  template: unknown
): Record<string, unknown> | null => {
  if (
    typeof template !== 'object' ||
    template === null ||
    Array.isArray(template)
  )
    return null;
  return template as Record<string, unknown>;
};

const parseResourcesObject = (
  tmpl: Record<string, unknown>
): Record<string, unknown> | null => {
  if (
    !tmpl.resources ||
    typeof tmpl.resources !== 'object' ||
    Array.isArray(tmpl.resources)
  )
    return null;
  return tmpl.resources as Record<string, unknown>;
};

const getOutputsObject = (
  tmpl: Record<string, unknown>
): Record<string, unknown> | null => {
  if (
    !tmpl.outputs ||
    typeof tmpl.outputs !== 'object' ||
    Array.isArray(tmpl.outputs)
  )
    return null;
  return tmpl.outputs as Record<string, unknown>;
};

type ResolvedParams = {
  errors: ValidationError[];
  warnings: ValidationError[];
  paramNames: Set<string>;
};

const resolveTemplateParams = (
  tmpl: Record<string, unknown>
): ResolvedParams => {
  const errors: ValidationError[] = [];
  const warnings: ValidationError[] = [];
  const paramNames = new Set<string>();

  if (tmpl.parameters === undefined) {
    return { errors, warnings, paramNames };
  }

  if (
    typeof tmpl.parameters !== 'object' ||
    Array.isArray(tmpl.parameters) ||
    tmpl.parameters === null
  ) {
    errors.push({
      path: 'parameters',
      message: '`parameters` must be an object',
    });
    return { errors, warnings, paramNames };
  }

  const params = tmpl.parameters as Record<string, unknown>;
  errors.push(...validateParametersSection(params));

  for (const [name, decl] of Object.entries(params)) {
    paramNames.add(name);
    const declObj =
      typeof decl === 'object' && decl !== null
        ? (decl as ParameterDeclaration)
        : null;
    if (declObj?.default === undefined) {
      warnings.push({
        path: `parameters.${name}`,
        message: `Parameter '${name}' has no default value and must be provided at deploy time`,
      });
    }
  }

  return { errors, warnings, paramNames };
};

export const validateFormationTemplate = (
  template: unknown
): ValidationResult => {
  const tmpl = parseTemplateObject(template);
  if (!tmpl) {
    return {
      valid: false,
      errors: [{ path: '', message: 'Template must be an object' }],
      warnings: [],
    };
  }

  const resources = parseResourcesObject(tmpl);
  if (!resources) {
    return {
      valid: false,
      errors: [{ path: 'resources', message: '`resources` must be an object' }],
      warnings: [],
    };
  }

  const {
    errors: paramErrors,
    warnings,
    paramNames,
  } = resolveTemplateParams(tmpl);
  const errors: ValidationError[] = [...paramErrors];
  const logicalIds = new Set(Object.keys(resources));

  for (const [logicalId, declRaw] of Object.entries(resources)) {
    errors.push(
      ...validateResourceDeclaration({
        logicalId,
        declRaw,
        logicalIds,
        paramNames,
      })
    );
  }

  const outputs = getOutputsObject(tmpl);
  if (outputs) {
    errors.push(...validateOutputRefs(outputs, logicalIds, paramNames));
  }

  // Check for circular dependencies only when all declarations are valid
  // objects (otherwise buildDependencyGraph would crash on null/array entries).
  const allDeclsAreObjects = Object.values(resources).every((decl) => {
    return typeof decl === 'object' && decl !== null && !Array.isArray(decl);
  });
  if (allDeclsAreObjects) {
    const castTemplate = template as FormationTemplate;
    const graph = buildDependencyGraph(castTemplate);
    const sorted = topologicalSort(graph);
    if (!sorted) {
      errors.push({
        path: 'resources',
        message: 'Circular dependency detected in resources',
      });
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  return { valid: true, errors, warnings };
};
