import createDebug from 'debug';

import { isRefAttr, parseRefAttr, resolveRefs } from './formationsHelpers';
import { getFormationModule } from './formationsRegistry';
import type { FormationTemplate } from './formationsTypes';

const log = createDebug('soat:formations');

const resolveRefAttrOutput = async (
  refAttrStr: string,
  template: FormationTemplate,
  resolvedIds: Map<string, string>
): Promise<string | undefined> => {
  const parsed = parseRefAttr(refAttrStr);
  if (!parsed) {
    log(
      'resolveFormationOutputs: skipping ref_attr "%s" — missing dot separator',
      refAttrStr
    );
    return undefined;
  }
  const { logicalId, attrName } = parsed;
  const physicalId = resolvedIds.get(logicalId);
  if (physicalId === undefined) {
    log(
      'resolveFormationOutputs: skipping ref_attr "%s" — no physical ID for "%s"',
      refAttrStr,
      logicalId
    );
    return undefined;
  }
  const resourceType = template.resources[logicalId]?.type;
  if (!resourceType) return undefined;
  const mod = getFormationModule({ resourceType });
  if (!mod?.getAttributes) {
    log(
      'resolveFormationOutputs: skipping ref_attr "%s" — resource type "%s" has no getAttributes',
      refAttrStr,
      resourceType
    );
    return undefined;
  }
  const attrs = await mod.getAttributes({
    physicalResourceId: physicalId,
  });
  if (typeof attrs[attrName] !== 'string') {
    log(
      'resolveFormationOutputs: skipping ref_attr "%s" — attribute "%s" not found in resource "%s"',
      refAttrStr,
      attrName,
      logicalId
    );
    return undefined;
  }
  return attrs[attrName];
};

export const resolveFormationOutputs = async (
  template: FormationTemplate,
  resolvedIds: Map<string, string>
): Promise<Record<string, string>> => {
  const outputs: Record<string, string> = {};
  if (!template.outputs) return outputs;
  for (const [outputName, outputValue] of Object.entries(template.outputs)) {
    try {
      if (isRefAttr(outputValue)) {
        const value = await resolveRefAttrOutput(
          outputValue.ref_attr,
          template,
          resolvedIds
        );
        if (value !== undefined) outputs[outputName] = value;
      } else {
        const resolved = resolveRefs(outputValue, resolvedIds);
        if (typeof resolved === 'string') outputs[outputName] = resolved;
      }
    } catch {
      // Skip unresolvable outputs
    }
  }
  return outputs;
};

/**
 * Resolves the top-level template `metadata` block against the deploy-time
 * parameters and created resources. `workingTemplate.metadata` already has
 * `param`/`sub` parameter tokens substituted; this applies `ref` (and
 * resource-`sub`) resolution to physical ids, mirroring resource properties.
 * Returns null when the template declares no metadata.
 */
export const resolveFormationMetadata = (
  workingTemplate: FormationTemplate,
  resolvedIds: Map<string, string>
): Record<string, unknown> | null => {
  if (workingTemplate.metadata === undefined) return null;
  return resolveRefs(workingTemplate.metadata, resolvedIds) as Record<
    string,
    unknown
  >;
};
