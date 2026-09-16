import { db } from 'src/db';

/**
 * The principal to record on a formation-door assertion.
 *
 * A formation module is handed the acting user's **internal** id, and an
 * assertion names principals the way `Generation.startedByPrincipal*` does — by
 * public id. The row is certain to exist: the apply authorized this operation
 * against that user before any module ran.
 */
export const resolveFormationPrincipal = async (args: {
  actingUserId: number;
}): Promise<{ principalType: string; principalId: string }> => {
  const user = await db.User.findByPk(args.actingUserId, {
    attributes: ['publicId'],
  });
  return { principalType: 'user', principalId: user!.publicId };
};
