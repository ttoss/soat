import createDebug from 'debug';
import { db } from 'src/db';

import { sensitiveOutputNames } from './formationsSensitive';
import type { FormationTemplate } from './formationsTypes';

const log = createDebug('soat:formations');

export type FormationSecretPurgeResult = {
  scanned: number;
  cleared: number;
  removedOutputs: number;
};

/**
 * Clears formation outputs that resolved a credential attribute.
 *
 * Such an output cannot be written any more — the template validator refuses it
 * and the resolver skips it — but a row written before that rule still holds the
 * plaintext, and the read-side redaction does not reach a database dump or a
 * direct query. So this is the operator-run half (audit decision D5): run it
 * once at deploy, then rotate every trigger and webhook secret a formation
 * published, since the value was readable for as long as the row existed.
 *
 * Which outputs to clear is read from the formation's own stored template rather
 * than from the values, because an output value is a bare string that says
 * nothing about where it came from — the same derivation the read path uses, so
 * the two cannot disagree about what counts.
 */
export const purgeFormationSecretOutputs = async (args?: {
  dryRun?: boolean;
}): Promise<FormationSecretPurgeResult> => {
  const formations = await db.Formation.findAll({
    attributes: ['id', 'publicId', 'template', 'outputs'],
  });

  let cleared = 0;
  let removedOutputs = 0;

  for (const formation of formations) {
    const template = formation.template as FormationTemplate | null;
    const outputs = formation.outputs;
    if (!template || !outputs) continue;

    const names = sensitiveOutputNames({ template }).filter((name) => {
      return name in outputs;
    });
    if (names.length === 0) continue;

    cleared += 1;
    removedOutputs += names.length;
    log(
      'purgeFormationSecretOutputs: formationId=%s outputs=%o dryRun=%s',
      formation.publicId,
      names,
      !!args?.dryRun
    );
    if (args?.dryRun) continue;

    const kept: Record<string, string> = {};
    for (const [name, value] of Object.entries(outputs)) {
      if (!names.includes(name)) kept[name] = value;
    }
    await formation.update({ outputs: kept });
  }

  return { scanned: formations.length, cleared, removedOutputs };
};
