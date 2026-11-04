import type { Context } from 'src/Context';
import { DomainError } from 'src/errors';

import { type PinViolation, resourcePins } from './resourcePins';

/** The pins `listDocuments` declares, confining every create and by-id route. */
export const documentPins = resourcePins({ listOperation: 'listDocuments' });

const documentNotFound = (): DomainError => {
  return new DomainError('RESOURCE_NOT_FOUND', 'Document not found');
};

/** A write that would file the document outside the call's `path_prefix`. */
const refuseDocumentFiling = (violation: PinViolation): DomainError => {
  return new DomainError(
    'DOCUMENT_PATH_OUTSIDE_PREFIX',
    `The document would be filed at ${String(violation.value ?? 'no path')}, outside '${violation.pin}'.`,
    { [violation.field]: violation.value, [violation.param]: violation.pin }
  );
};

/** Refuses a write whose fields would file the document outside the call's pins. */
export const assertDocumentFiling = (ctx: Context) => {
  return (values: Record<string, unknown>): void => {
    documentPins.assertWrite({
      ctx,
      values,
      refuseWrite: refuseDocumentFiling,
    });
  };
};

/** Answers `404` for a document outside the call's pins. */
export const assertDocumentReachable = (ctx: Context) => {
  return (document: Record<string, unknown>): void => {
    documentPins.assertItem({
      ctx,
      item: document,
      notFound: documentNotFound,
    });
  };
};
