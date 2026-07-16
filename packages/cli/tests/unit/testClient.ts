type CapturedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
};

type CliTestClient = {
  call: (args: string[]) => Promise<CapturedRequest[]>;
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

    return new Response('{}', {
      status: 200,
      headers: DEFAULT_RESPONSE_HEADERS,
    });
  });

  const reset = () => {
    requests = [];
    fetchMock.mockClear();
  };

  const call = async (args: string[]) => {
    reset();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    jest.resetModules();
    const { runCli } = await loadCliModule();
    await runCli(['node', 'soat', ...args]);

    return requests;
  };

  return {
    call,
    fetchMock,
    getRequests: () => {
      return requests;
    },
    reset,
  };
};

export type { CapturedRequest, CliTestClient };
