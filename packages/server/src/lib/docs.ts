import createDebug from 'debug';

import { DomainError } from '../errors';

const log = createDebug('soat:docs');

const getDocsBaseUrl = () => {
  return process.env.SOAT_DOCS_BASE_URL ?? 'https://soat.ttoss.dev';
};

export const getDocsIndex = async (): Promise<string> => {
  const url = `${getDocsBaseUrl()}/llms.txt`;
  log('getDocsIndex: url=%s', url);
  const res = await fetch(url);
  if (!res.ok) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      'Documentation index unavailable'
    );
  }
  return res.text();
};

export const getDocPage = async (args: { url: string }): Promise<string> => {
  log('getDocPage: url=%s', args.url);

  const baseHostname = new URL(getDocsBaseUrl()).hostname;
  let requestedUrl: URL;
  try {
    requestedUrl = new URL(args.url);
  } catch {
    throw new DomainError('RESOURCE_NOT_FOUND', `Invalid URL: ${args.url}`);
  }

  if (requestedUrl.hostname !== baseHostname) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `URL must be from ${baseHostname}`
    );
  }

  const res = await fetch(args.url);
  if (!res.ok) {
    throw new DomainError(
      'RESOURCE_NOT_FOUND',
      `Documentation page not found: ${args.url}`
    );
  }
  return res.text();
};
