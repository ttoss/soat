import type { ModuleInfo } from './types';

// Finds the modules whose list operation is nested under the parent's detail
// path (e.g. an agent's sessions), so the detail view can show them as tabs.
export const findSubResources = (
  parent: ModuleInfo,
  modules: ModuleInfo[]
): ModuleInfo[] => {
  if (!parent.getOp) return [];
  const parentPath = parent.getOp.pathTemplate;
  return modules.filter((m) => {
    return (
      m !== parent &&
      Boolean(m.listOp?.pathTemplate.startsWith(parentPath + '/'))
    );
  });
};
