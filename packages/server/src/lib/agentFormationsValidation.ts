import yaml from 'js-yaml';

import {
  buildDependencyGraph,
  collectParamRefs,
  collectRefs,
  topologicalSort,
} from './agentFormationsHelpers';
import type {
  FormationTemplate,
  ParameterDeclaration,
  ValidationError,
  ValidationResult,
} from './agentFormationsTypes';
import { SUPPORTED_RESOURCE_TYPES } from './agentFormationsTypes';

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

  if (
    !decl.properties ||
    typeof decl.properties !== 'object' ||
    Array.isArray(decl.properties)
  ) {
    errors.push({
      path: `${basePath}.properties`,
      message: '`properties` is required and must be an object',
    });
  }

  const refs = collectRefs(decl.properties);
  for (const ref of refs) {
    if (!logicalIds.has(ref)) {
      errors.push({
        path: `${basePath}.properties`,
        message: `Referenced resource '${ref}' does not exist in template`,
      });
    }
  }

  const paramRefs = collectParamRefs(decl.properties);
  for (const ref of paramRefs) {
    if (!paramNames.has(ref)) {
      errors.push({
        path: `${basePath}.properties`,
        message: `Parameter '${ref}' is not defined in the parameters section`,
      });
    }
  }

  if (decl.depends_on !== undefined) {
    errors.push(
      ...validateDependsOn({ dependsOn: decl.depends_on, logicalIds, basePath })
    );
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
    for (const ref of collectParamRefs(outputValue)) {
      if (!paramNames.has(ref)) {
        errors.push({
          path: `outputs.${outputName}`,
          message: `Parameter '${ref}' is not defined in the parameters section`,
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

export const validateFormationTemplate = (
  template: unknown
): ValidationResult => {
  const warnings: ValidationError[] = [];

  const tmpl = parseTemplateObject(template);
  if (!tmpl) {
    return {
      valid: false,
      errors: [{ path: '', message: 'Template must be an object' }],
      warnings,
    };
  }

  const resources = parseResourcesObject(tmpl);
  if (!resources) {
    return {
      valid: false,
      errors: [{ path: 'resources', message: '`resources` must be an object' }],
      warnings,
    };
  }

  const logicalIds = new Set(Object.keys(resources));
  const errors: ValidationError[] = [];

  // ── Validate parameters section ──────────────────────────────────────────
  const paramNames = new Set<string>();
  const paramDecls: Record<string, ParameterDeclaration> = {};

  if (tmpl.parameters !== undefined) {
    if (
      typeof tmpl.parameters !== 'object' ||
      Array.isArray(tmpl.parameters) ||
      tmpl.parameters === null
    ) {
      errors.push({
        path: 'parameters',
        message: '`parameters` must be an object',
      });
    } else {
      const params = tmpl.parameters as Record<string, unknown>;
      errors.push(...validateParametersSection(params));
      for (const [name, decl] of Object.entries(params)) {
        paramNames.add(name);
        if (typeof decl === 'object' && decl !== null) {
          paramDecls[name] = decl as ParameterDeclaration;
        }
      }
    }
  }

  // ── Warn about required parameters (no default) ──────────────────────────
  for (const [name, decl] of Object.entries(paramDecls)) {
    if (decl.default === undefined) {
      warnings.push({
        path: `parameters.${name}`,
        message: `Parameter '${name}' has no default value and must be provided at deploy time`,
      });
    }
  }

  // ── Validate resources ───────────────────────────────────────────────────
  for (const [logicalId, declRaw] of Object.entries(resources)) {
    errors.push(
      ...validateResourceDeclaration({ logicalId, declRaw, logicalIds, paramNames })
    );
  }

  const outputs = getOutputsObject(tmpl);
  if (outputs) {
    errors.push(...validateOutputRefs(outputs, logicalIds, paramNames));
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  const castTemplate = template as FormationTemplate;
  const graph = buildDependencyGraph(castTemplate);
  const sorted = topologicalSort(graph);
  if (!sorted) {
    return {
      valid: false,
      errors: [
        {
          path: 'resources',
          message: 'Circular dependency detected in resources',
        },
      ],
      warnings,
    };
  }

  return { valid: true, errors, warnings };
};
