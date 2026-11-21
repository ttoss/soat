import { isObjectRecord } from './openapiSchemaFields';

/**
 * Whether the deployment leaves `project_id` out of every route's query
 * (`PROJECT_ID_QUERY_DISABLED=true`): a platform that issues only
 * project-bound credentials selects the project by the credential alone.
 * Read per call.
 */
export const projectIdQueryDisabled = (): boolean => {
  return process.env.PROJECT_ID_QUERY_DISABLED === 'true';
};

const isProjectIdQueryParameter = (parameter: unknown): boolean => {
  return (
    isObjectRecord(parameter) &&
    parameter.in === 'query' &&
    parameter.name === 'project_id'
  );
};

const withoutProjectIdQueryParameter = (
  item: Record<string, unknown>
): Record<string, unknown> => {
  if (!Array.isArray(item.parameters)) return item;
  return {
    ...item,
    parameters: item.parameters.filter((parameter: unknown) => {
      return !isProjectIdQueryParameter(parameter);
    }),
  };
};

/**
 * `paths` with every inline `project_id` query parameter removed, from path
 * items and operations alike.
 */
export const stripProjectIdQuery = (
  paths: Record<string, unknown>
): Record<string, unknown> => {
  return Object.fromEntries(
    Object.entries(paths).map(([template, pathItem]) => {
      if (!isObjectRecord(pathItem)) return [template, pathItem];
      const stripped = Object.fromEntries(
        Object.entries(withoutProjectIdQueryParameter(pathItem)).map(
          ([key, operation]) => {
            return [
              key,
              isObjectRecord(operation)
                ? withoutProjectIdQueryParameter(operation)
                : operation,
            ];
          }
        )
      );
      return [template, stripped];
    })
  );
};
