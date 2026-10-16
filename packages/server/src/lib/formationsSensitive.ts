import { isRefAttr, parseRefAttr } from './formationsHelpers';
import { getFormationModule } from './formationsRegistry';
import type {
  FormationTemplate,
  PlanChange,
  ResourceDeclaration,
} from './formationsTypes';
import { SENSITIVE_PLACEHOLDER } from './sensitivePlaceholder';

export { SENSITIVE_PLACEHOLDER };

const writeOnlyPropertiesFor = (resourceType: string): readonly string[] => {
  return getFormationModule({ resourceType })?.writeOnlyProperties ?? [];
};

const redactProperties = (args: {
  resourceType: string;
  properties: Record<string, unknown>;
}): Record<string, unknown> => {
  const module = getFormationModule({ resourceType: args.resourceType });
  const masked = module?.maskCredentials
    ? module.maskCredentials(args.properties)
    : args.properties;
  const names = writeOnlyPropertiesFor(args.resourceType);
  if (names.length === 0) return masked;

  const redacted: Record<string, unknown> = { ...masked };
  for (const name of names) {
    if (name in redacted) redacted[name] = SENSITIVE_PLACEHOLDER;
  }
  return redacted;
};

/**
 * Masks every credential-bearing property in a stored template.
 *
 * The template is kept verbatim in the database because a deploy that supplies
 * no new template re-applies the stored one — a redacted store would break the
 * "update only the parameters" and "retry a failed create" flows. So the read is
 * where it is masked, which is the surface the value was exposed on: a formation
 * is readable by anyone holding `formations:GetFormation`, a far wider set than
 * `secrets:GetSecret`.
 */
export const redactTemplateSecrets = (args: {
  template: FormationTemplate;
}): FormationTemplate => {
  const resources: Record<string, ResourceDeclaration> = {};
  for (const [logicalId, decl] of Object.entries(args.template.resources)) {
    resources[logicalId] = decl.properties
      ? {
          ...decl,
          properties: redactProperties({
            resourceType: decl.type,
            properties: decl.properties,
          }),
        }
      : decl;
  }
  return { ...args.template, resources };
};

/**
 * Masks the same properties in a plan diff, on both sides.
 *
 * A plan carries the *resolved* value, so it leaks a `no_echo` parameter the
 * auditable parameter record deliberately masks. The change decision is computed
 * before this runs, so masking costs the caller no signal about what will happen.
 */
export const redactPlanChanges = (args: {
  changes: PlanChange[];
}): PlanChange[] => {
  return args.changes.map((change) => {
    if (!change.diff) return change;
    const resourceType = change.resourceType;
    return {
      ...change,
      diff: {
        desired: redactProperties({
          resourceType,
          properties: change.diff.desired,
        }),
        current: change.diff.current
          ? redactProperties({
              resourceType,
              properties: change.diff.current,
            })
          : change.diff.current,
      },
    };
  });
};

export const isSensitiveAttribute = (args: {
  resourceType: string;
  attrName: string;
}): boolean => {
  const module = getFormationModule({ resourceType: args.resourceType });
  return module?.sensitiveAttributes?.includes(args.attrName) ?? false;
};

/**
 * The output names a template resolves from a sensitive attribute.
 *
 * Read from the template rather than from the stored outputs, because an output
 * value is a bare string that says nothing about where it came from. Shared by
 * the read-side redaction and the one-off purge of rows written before outputs
 * like these were refused.
 */
export const sensitiveOutputNames = (args: {
  template: FormationTemplate;
}): string[] => {
  const outputs = args.template.outputs;
  if (!outputs) return [];

  const names: string[] = [];
  for (const [outputName, outputValue] of Object.entries(outputs)) {
    if (!isRefAttr(outputValue)) continue;
    const parsed = parseRefAttr(outputValue.ref_attr);
    if (!parsed) continue;
    const resourceType = args.template.resources[parsed.logicalId]?.type;
    if (!resourceType) continue;
    if (isSensitiveAttribute({ resourceType, attrName: parsed.attrName })) {
      names.push(outputName);
    }
  }
  return names;
};

/**
 * Drops, rather than masks, the outputs that resolved a sensitive attribute: an
 * output is a value a caller reads, so a placeholder there would be a value the
 * template promised and this API answered with nonsense.
 */
export const redactSensitiveOutputs = (args: {
  template: FormationTemplate;
  outputs: Record<string, string> | null;
}): Record<string, string> | null => {
  if (!args.outputs) return args.outputs;
  const names = sensitiveOutputNames({ template: args.template });
  if (names.length === 0) return args.outputs;

  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(args.outputs)) {
    if (!names.includes(name)) kept[name] = value;
  }
  return kept;
};
