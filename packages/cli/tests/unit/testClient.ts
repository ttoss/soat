type CapturedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
};

/** Overrides the canned `{}` JSON reply, so a test can drive a non-JSON
 * response (e.g. the NDJSON audit export) through the real client. */
type ResponseOverride = { body: string; contentType: string };

type CliTestClient = {
  call: (args: string[]) => Promise<CapturedRequest[]>;
  setResponse: (override: ResponseOverride | null) => void;
  fetchMock: jest.Mock;
  getRequests: () => CapturedRequest[];
  reset: () => void;
};

const loadCliModule = async () => {
  return import('../../src/index');
};

const DEFAULT_RESPONSE_HEADERS = {
  'Content-Type': 'application/json',
};

export const createCliTestClient = (): CliTestClient => {
  let requests: CapturedRequest[] = [];
  let responseOverride: ResponseOverride | null = null;

  const fetchMock = jest.fn(async (request: Request): Promise<Response> => {
    const bodyText = await request.text();
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : undefined;
    const url = new URL(request.url);

    requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body,
    });

    if (responseOverride) {
      return new Response(responseOverride.body, {
        status: 200,
        headers: { 'Content-Type': responseOverride.contentType },
      });
    }

    return new Response('{}', {
      status: 200,
      headers: DEFAULT_RESPONSE_HEADERS,
    });
  });

  const clearRequests = () => {
    requests = [];
    fetchMock.mockClear();
  };

  // Clears captured requests *and* any response override — the per-test reset.
  const reset = () => {
    clearRequests();
    responseOverride = null;
  };

  const call = async (args: string[]) => {
    // Only the captured requests are cleared here: a response override set
    // before the call must survive into it.
    clearRequests();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    jest.resetModules();
    const { runCli } = await loadCliModule();
    await runCli(['node', 'soat', ...args]);

    return requests;
  };

  return {
    call,
    setResponse: (override: ResponseOverride | null) => {
      responseOverride = override;
    },
    fetchMock,
    getRequests: () => {
      return requests;
    },
    reset,
  };
};

export type { CapturedRequest, CliTestClient };
