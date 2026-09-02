import { APICallError } from 'ai';
import { resetModelRouteBreakers } from 'src/lib/modelRouteBreaker';
import { classifyModelRouteError } from 'src/lib/modelRouteErrors';
import {
  createRoutedModel,
  isRoutedModel,
  readRoutingMetadata,
  routedAiProviderId,
  routedMaxRetries,
  type RoutedTarget,
} from 'src/lib/modelRouteExecutor';

/**
 * The composite executor is a pure algorithm over a large input space: the
 * ordered-fallback loop, the retry budget, the error classification, and the
 * circuit breaker each have branches that a single HTTP-level failure ("the
 * generation 502'd") cannot distinguish. Driving it directly with fake inner
 * models is the only way to assert *which* branch fired — the keep-list case 1
 * in `.claude/rules/tests.md`. No owned module is mocked: the inner models here
 * are plain inputs, exactly what a provider builder would hand the composite.
 */

type InnerModel = RoutedTarget['model'];
type CallOptions = Parameters<InnerModel['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<InnerModel['doGenerate']>>;
type StreamResult = Awaited<ReturnType<InnerModel['doStream']>>;

const CALL_OPTIONS: CallOptions = {
  prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};

const okResult = (text: string): GenerateResult => {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: {
      inputTokens: {
        total: 1,
        noCache: 1,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 1, text: 1, reasoning: undefined },
    },
    warnings: [],
  };
};

const okStream = (): StreamResult => {
  return {
    stream: new ReadableStream({
      start: (controller) => {
        controller.close();
      },
    }),
  };
};

type FakeTarget = {
  target: RoutedTarget;
  calls: () => number;
  signals: () => Array<AbortSignal | undefined>;
};

/**
 * A target whose inner model replays `behaviors` call by call (the last entry
 * repeats), counting calls so a retry budget can be asserted exactly.
 */
const fakeTarget = (args: {
  index: number;
  aiProviderDbId?: number;
  modelName?: string;
  maxRetries?: number;
  timeoutMs?: number | null;
  behaviors: Array<'ok' | Error>;
}): FakeTarget => {
  let calls = 0;
  const signals: Array<AbortSignal | undefined> = [];
  const modelName = args.modelName ?? `model-${args.index}`;

  const run = <T>(options: CallOptions, onOk: () => T): PromiseLike<T> => {
    const behavior = args.behaviors[Math.min(calls, args.behaviors.length - 1)];
    calls += 1;
    signals.push(options.abortSignal);
    return behavior === 'ok'
      ? Promise.resolve(onOk())
      : Promise.reject(behavior);
  };

  return {
    calls: () => {
      return calls;
    },
    signals: () => {
      return signals;
    },
    target: {
      index: args.index,
      aiProviderId: `aip_fake_${args.index}`,
      aiProviderDbId: args.aiProviderDbId ?? args.index + 1,
      modelName,
      timeoutMs: args.timeoutMs ?? null,
      maxRetries: args.maxRetries ?? 0,
      model: {
        specificationVersion: 'v4',
        provider: 'fake',
        modelId: modelName,
        supportedUrls: {},
        doGenerate: (options) => {
          return run(options, () => {
            return okResult(`served by ${modelName}`);
          });
        },
        doStream: (options) => {
          return run(options, okStream);
        },
      },
    },
  };
};

const apiError = (args: {
  statusCode?: number;
  isRetryable?: boolean;
}): APICallError => {
  return new APICallError({
    message: `provider said ${args.statusCode ?? 'nothing'}`,
    url: 'http://fake.invalid/v1/chat/completions',
    requestBodyValues: {},
    statusCode: args.statusCode,
    isRetryable: args.isRetryable,
  });
};

const abortError = (name: 'AbortError' | 'TimeoutError'): Error => {
  const error = new Error(name);
  error.name = name;
  return error;
};

const buildRoute = (args: {
  targets: RoutedTarget[];
  retryOn?: Array<'provider_error' | 'timeout' | 'rate_limited'>;
  failureThreshold?: number;
  cooldownSeconds?: number;
  routeId?: string;
}) => {
  return createRoutedModel({
    routeId: args.routeId ?? 'route_test0000000000',
    retryOn: args.retryOn ?? ['provider_error', 'timeout', 'rate_limited'],
    failureThreshold: args.failureThreshold ?? 3,
    cooldownSeconds: args.cooldownSeconds ?? 60,
    targets: args.targets,
  });
};

// The composite is only ever handed a v4 model object, so narrowing back to one
// in the test is a type assertion the executor itself already guarantees.
const generate = (model: ReturnType<typeof buildRoute>) => {
  if (typeof model === 'string' || model.specificationVersion !== 'v4') {
    throw new Error('createRoutedModel must produce a v4 model');
  }
  return model.doGenerate(CALL_OPTIONS);
};

const stream = (model: ReturnType<typeof buildRoute>) => {
  if (typeof model === 'string' || model.specificationVersion !== 'v4') {
    throw new Error('createRoutedModel must produce a v4 model');
  }
  return model.doStream(CALL_OPTIONS);
};

describe('classifyModelRouteError', () => {
  test('maps 429 to rate_limited', () => {
    expect(
      classifyModelRouteError({ error: apiError({ statusCode: 429 }) })
    ).toBe('rate_limited');
  });

  test('maps 5xx, a retryable flag, and a missing status to provider_error', () => {
    expect(
      classifyModelRouteError({ error: apiError({ statusCode: 503 }) })
    ).toBe('provider_error');
    expect(
      classifyModelRouteError({
        error: apiError({ statusCode: 418, isRetryable: true }),
      })
    ).toBe('provider_error');
    expect(classifyModelRouteError({ error: apiError({}) })).toBe(
      'provider_error'
    );
  });

  test('maps aborts and timeouts to timeout', () => {
    expect(classifyModelRouteError({ error: abortError('AbortError') })).toBe(
      'timeout'
    );
    expect(classifyModelRouteError({ error: abortError('TimeoutError') })).toBe(
      'timeout'
    );
  });

  test('maps a connection-level fetch failure to provider_error', () => {
    const failure = new TypeError('fetch failed');
    expect(classifyModelRouteError({ error: failure })).toBe('provider_error');
  });

  test('treats deterministic rejections as non-failover', () => {
    expect(
      classifyModelRouteError({ error: apiError({ statusCode: 400 }) })
    ).toBeNull();
    expect(
      classifyModelRouteError({ error: apiError({ statusCode: 401 }) })
    ).toBeNull();
    expect(classifyModelRouteError({ error: new Error('boom') })).toBeNull();
  });

  test('a caller-initiated abort is never a failover', () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      classifyModelRouteError({
        error: abortError('AbortError'),
        callerSignal: controller.signal,
      })
    ).toBeNull();
  });
});

describe('createRoutedModel', () => {
  beforeEach(() => {
    resetModelRouteBreakers();
  });

  test('marks the composite so the SDK retry loop is disabled', () => {
    const primary = fakeTarget({ index: 0, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target] });

    expect(isRoutedModel(model)).toBe(true);
    expect(routedMaxRetries(model)).toBe(0);
    expect(isRoutedModel(primary.target.model)).toBe(false);
    expect(routedMaxRetries(primary.target.model)).toBeUndefined();
  });

  test('serves from the first target and records the attempt', async () => {
    const primary = fakeTarget({ index: 0, behaviors: ['ok'] });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({
      targets: [primary.target, fallback.target],
    });

    await generate(model);

    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(0);
    expect(readRoutingMetadata(model)).toEqual({
      route_id: 'route_test0000000000',
      target_index: 0,
      attempts: [
        { target_index: 0, ai_provider_id: 'aip_fake_0', model: 'model-0' },
      ],
      fallbacks: 0,
    });
  });

  test('falls over to the next target on a retryable failure', async () => {
    const primary = fakeTarget({
      index: 0,
      behaviors: [apiError({ statusCode: 500 })],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target, fallback.target] });

    await generate(model);

    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(1);
    const routing = readRoutingMetadata(model);
    expect(routing?.target_index).toBe(1);
    expect(routing?.fallbacks).toBe(1);
    expect(routing?.attempts).toEqual([
      {
        target_index: 0,
        ai_provider_id: 'aip_fake_0',
        model: 'model-0',
        error_class: 'provider_error',
      },
      { target_index: 1, ai_provider_id: 'aip_fake_1', model: 'model-1' },
    ]);
  });

  test('retries the same target up to max_retries before falling through', async () => {
    const primary = fakeTarget({
      index: 0,
      maxRetries: 1,
      behaviors: [apiError({ statusCode: 500 })],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target, fallback.target] });

    await generate(model);

    // 1 initial attempt + 1 retry — never the SDK's own multiplication.
    expect(primary.calls()).toBe(2);
    expect(fallback.calls()).toBe(1);
    expect(readRoutingMetadata(model)?.attempts).toHaveLength(3);
  });

  test('a retry that succeeds does not fall through', async () => {
    const primary = fakeTarget({
      index: 0,
      maxRetries: 2,
      behaviors: [apiError({ statusCode: 503 }), 'ok'],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target, fallback.target] });

    await generate(model);

    expect(primary.calls()).toBe(2);
    expect(fallback.calls()).toBe(0);
    expect(readRoutingMetadata(model)?.target_index).toBe(0);
    expect(readRoutingMetadata(model)?.fallbacks).toBe(0);
  });

  test('a deterministic rejection fails fast without touching the next target', async () => {
    const primary = fakeTarget({
      index: 0,
      maxRetries: 3,
      behaviors: [apiError({ statusCode: 400 })],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target, fallback.target] });

    await expect(generate(model)).rejects.toThrow(/provider said 400/);
    expect(primary.calls()).toBe(1);
    expect(fallback.calls()).toBe(0);
    expect(readRoutingMetadata(model)?.attempts[0].error_class).toBeUndefined();
  });

  test('a class outside retry_on is terminal', async () => {
    const primary = fakeTarget({
      index: 0,
      behaviors: [apiError({ statusCode: 429 })],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({
      targets: [primary.target, fallback.target],
      retryOn: ['provider_error'],
    });

    await expect(generate(model)).rejects.toThrow(/provider said 429/);
    expect(fallback.calls()).toBe(0);
    expect(readRoutingMetadata(model)?.attempts[0].error_class).toBe(
      'rate_limited'
    );
  });

  test('rethrows the last error when every target fails', async () => {
    const primary = fakeTarget({
      index: 0,
      behaviors: [apiError({ statusCode: 500 })],
    });
    const fallback = fakeTarget({
      index: 1,
      behaviors: [apiError({ statusCode: 503 })],
    });
    const model = buildRoute({ targets: [primary.target, fallback.target] });

    await expect(generate(model)).rejects.toThrow(/provider said 503/);
    expect(readRoutingMetadata(model)?.target_index).toBeNull();
    expect(readRoutingMetadata(model)?.fallbacks).toBe(1);
  });

  test('a caller abort aborts the run instead of failing over', async () => {
    const controller = new AbortController();
    const primary = fakeTarget({
      index: 0,
      behaviors: [abortError('AbortError')],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target, fallback.target] });
    if (typeof model === 'string' || model.specificationVersion !== 'v4') {
      throw new Error('createRoutedModel must produce a v4 model');
    }

    controller.abort();
    await expect(
      model.doGenerate({ ...CALL_OPTIONS, abortSignal: controller.signal })
    ).rejects.toThrow('AbortError');
    expect(fallback.calls()).toBe(0);
  });

  test('composes a per-target timeout with the caller signal', async () => {
    const controller = new AbortController();
    const primary = fakeTarget({
      index: 0,
      timeoutMs: 50_000,
      behaviors: ['ok'],
    });
    const model = buildRoute({ targets: [primary.target] });
    if (typeof model === 'string' || model.specificationVersion !== 'v4') {
      throw new Error('createRoutedModel must produce a v4 model');
    }

    await model.doGenerate({
      ...CALL_OPTIONS,
      abortSignal: controller.signal,
    });

    const [seen] = primary.signals();
    // A composed signal, not the caller's own — it must also carry the deadline.
    expect(seen).toBeDefined();
    expect(seen).not.toBe(controller.signal);
    expect(seen?.aborted).toBe(false);
  });

  test('passes the caller signal through untouched when no timeout is set', async () => {
    const controller = new AbortController();
    const primary = fakeTarget({ index: 0, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target] });
    if (typeof model === 'string' || model.specificationVersion !== 'v4') {
      throw new Error('createRoutedModel must produce a v4 model');
    }

    await model.doGenerate({
      ...CALL_OPTIONS,
      abortSignal: controller.signal,
    });

    expect(primary.signals()[0]).toBe(controller.signal);
  });

  test('streaming fails over before the first token', async () => {
    const primary = fakeTarget({
      index: 0,
      behaviors: [apiError({ statusCode: 500 })],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target, fallback.target] });

    const result = await stream(model);

    expect(result.stream).toBeInstanceOf(ReadableStream);
    expect(fallback.calls()).toBe(1);
    expect(readRoutingMetadata(model)?.target_index).toBe(1);
  });
});

describe('routedAiProviderId', () => {
  test('names the target that served, not the one that failed over', async () => {
    const primary = fakeTarget({
      index: 0,
      behaviors: [apiError({ statusCode: 500 })],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({ targets: [primary.target, fallback.target] });

    await generate(model);

    expect(routedAiProviderId(model)).toBe('aip_fake_1');
  });

  test('is null when every target failed', async () => {
    const primary = fakeTarget({
      index: 0,
      behaviors: [apiError({ statusCode: 500 })],
    });
    const fallback = fakeTarget({
      index: 1,
      behaviors: [apiError({ statusCode: 503 })],
    });
    const model = buildRoute({ targets: [primary.target, fallback.target] });

    await expect(generate(model)).rejects.toThrow(/provider said 503/);

    expect(routedAiProviderId(model)).toBeNull();
  });

  test('is null for a model no route composed', () => {
    expect(routedAiProviderId('openai/gpt-4o')).toBeNull();
  });
});

describe('createRoutedModel circuit breaker', () => {
  beforeEach(() => {
    resetModelRouteBreakers();
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-30T00:00:00Z'));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const failingRoute = (args: {
    routeId?: string;
    failureThreshold?: number;
    cooldownSeconds?: number;
  }) => {
    const primary = fakeTarget({
      index: 0,
      aiProviderDbId: 7,
      modelName: 'shared-model',
      behaviors: [apiError({ statusCode: 500 })],
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    return {
      primary,
      fallback,
      model: buildRoute({
        targets: [primary.target, fallback.target],
        ...args,
      }),
    };
  };

  test('skips a target after failure_threshold consecutive failures, then probes it again', async () => {
    const { primary, fallback, model } = failingRoute({
      failureThreshold: 2,
      cooldownSeconds: 60,
    });

    await generate(model);
    await generate(model);
    expect(primary.calls()).toBe(2);

    // Threshold reached — the next generation goes straight to target 1.
    await generate(model);
    expect(primary.calls()).toBe(2);
    expect(fallback.calls()).toBe(3);
    expect(readRoutingMetadata(model)?.attempts).toHaveLength(5);

    // ...and is probed again once the cooldown has elapsed.
    jest.setSystemTime(new Date('2026-07-30T00:02:00Z'));
    await generate(model);
    expect(primary.calls()).toBe(3);
  });

  test('a success resets the consecutive-failure counter', async () => {
    const primary = fakeTarget({
      index: 0,
      behaviors: [apiError({ statusCode: 500 }), 'ok'],
      maxRetries: 1,
    });
    const fallback = fakeTarget({ index: 1, behaviors: ['ok'] });
    const model = buildRoute({
      targets: [primary.target, fallback.target],
      failureThreshold: 1,
    });

    await generate(model);
    // The retry succeeded, so the breaker must not be holding a failure.
    await generate(model);

    expect(primary.calls()).toBe(3);
    expect(fallback.calls()).toBe(0);
  });

  test('breaker state is shared by every route pointing at the same backend', async () => {
    const routeA = failingRoute({
      routeId: 'route_a0000000000000',
      failureThreshold: 1,
    });
    const routeB = failingRoute({
      routeId: 'route_b0000000000000',
      failureThreshold: 1,
    });

    // One failure through route A trips the shared (provider, model) key...
    await generate(routeA.model);
    expect(routeA.primary.calls()).toBe(1);

    // ...so route B skips its own target 0 without ever calling it.
    await generate(routeB.model);
    expect(routeB.primary.calls()).toBe(0);
    expect(routeB.fallback.calls()).toBe(1);
    expect(readRoutingMetadata(routeB.model)?.target_index).toBe(1);
  });

  test('probes the first target rather than failing when every target is tripped', async () => {
    const primary = fakeTarget({
      index: 0,
      behaviors: [apiError({ statusCode: 500 }), 'ok'],
    });
    const model = buildRoute({
      targets: [primary.target],
      failureThreshold: 1,
      cooldownSeconds: 600,
    });

    await expect(generate(model)).rejects.toThrow(/provider said 500/);
    expect(primary.calls()).toBe(1);

    // Sole target is tripped and still inside its cooldown — a refusal here
    // would turn a transient outage into a hard 10-minute one.
    await generate(model);
    expect(primary.calls()).toBe(2);
    expect(readRoutingMetadata(model)?.target_index).toBe(0);
  });
});
