import type { ModuleOp } from './types';

// A multipart POST with a `format: binary` field wins over a plain JSON POST at
// the collection path: only it can carry file bytes, and the form engine
// renders a file picker for such fields.
const hasBinaryField = (op: ModuleOp): boolean => {
  const properties =
    op.operation.requestBody?.content?.['multipart/form-data']?.schema
      ?.properties ?? {};
  return Object.values(properties).some((schema) => {
    return schema.format === 'binary';
  });
};

const isUploadSibling = (op: ModuleOp, collection: string): boolean => {
  const lastSegment = op.pathTemplate.split('/').pop() ?? '';
  return (
    op.method === 'post' &&
    op.pathTemplate !== collection &&
    op.pathTemplate.startsWith(`${collection}/`) &&
    !lastSegment.startsWith('{') &&
    hasBinaryField(op)
  );
};

export const findUploadCreatePath = (
  sorted: ModuleOp[],
  collection: string | undefined
): string | undefined => {
  if (!collection) return undefined;
  return sorted.find((op) => {
    return isUploadSibling(op, collection);
  })?.pathTemplate;
};
