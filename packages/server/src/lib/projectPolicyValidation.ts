import type { PolicyDocument } from './iam';
import { validatePolicyActions } from './iam';
import { validatePolicyDocument } from './policyDocumentValidation';
import {
  findAllowResourcesOutsideEveryProject,
  findAllowResourcesOutsideProject,
} from './policyProjectIds';

/**
 * Every refusal of a project policy's document. Each one about an `Allow`
 * resource names the one form such a resource may take, so no refusal offers
 * a form another refuses. `projectPublicId: null` checks against every
 * project, for a policy whose project is not known yet.
 */
export const validateProjectPolicyDocument = (args: {
  document: unknown;
  projectPublicId: string | null;
}): string[] => {
  const project = args.projectPublicId ?? '<project_id>';
  const allowResourceForm = `srn:${project}:<type>:<id>, or omit resource for every resource of the project`;
  const structural = validatePolicyDocument(args.document, {
    allowResourceForm,
  });
  if (!structural.valid) return structural.errors;
  const document = args.document as PolicyDocument;
  const outside =
    args.projectPublicId === null
      ? findAllowResourcesOutsideEveryProject(document)
      : findAllowResourcesOutsideProject({
          document,
          projectPublicId: args.projectPublicId,
        });
  return [
    ...validatePolicyActions(document).errors,
    ...outside.map((resource) => {
      return `Allow resource '${resource}' is outside the policy's project; name ${allowResourceForm}.`;
    }),
  ];
};
