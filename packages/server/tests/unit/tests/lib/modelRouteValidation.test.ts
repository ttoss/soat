import {
  MAX_MODEL_ROUTE_ATTEMPTS,
  type ModelRouteTarget,
  modelRouteTotalAttempts,
  validateModelRouteBreakerConfig,
  validateModelRouteExclusivity,
  validateModelRouteRetryOn,
  validateModelRouteTargets,
} from 'src/lib/modelRouteValidation';

/**
 * Pure validators with a large input space, reused verbatim by the REST handlers
 * and the formation module (keep-list case 1 in `.claude/rules/tests.md`).
 * Reaching a single branch through HTTP would need a full project + provider +
 * route per case, and the failure signal (a bare `400`) would not say which rule
 * fired.
 */

const target = (
  overrides: Partial<ModelRouteTarget> = {}
): ModelRouteTarget => {
  return { ai_provider_id: 'aip_1', model: 'gpt-4o-mini', ...overrides };
};

describe('validateModelRouteTargets', () => {
  test('accepts a minimal ordered list', () => {
    expect(validateModelRouteTargets([target(), target()])).toBeNull();
  });

  test('accepts optional per-target timeout and retries', () => {
    expect(
      validateModelRouteTargets([
        target({ timeout_seconds: 30, max_retries: 0 }),
      ])
    ).toBeNull();
  });

  test.each([
    [undefined, /non-empty array/],
    [null, /non-empty array/],
    ['nope', /non-empty array/],
    [[], /non-empty array/],
    [['nope'], /targets\[0\] must be an object/],
    [[null], /targets\[0\] must be an object/],
    [[[]], /targets\[0\] must be an object/],
  ] as Array<[unknown, RegExp]>)('rejects %p', (targets, expected) => {
    expect(validateModelRouteTargets(targets)).toMatch(expected);
  });

  test('rejects an unknown field, naming it', () => {
    expect(validateModelRouteTargets([{ ...target(), weight: 2 }])).toMatch(
      /targets\[0\] has unknown field 'weight'/
    );
  });

  test('requires a non-empty string ai_provider_id', () => {
    expect(validateModelRouteTargets([{ model: 'm' }])).toMatch(
      /targets\[0\]\.ai_provider_id is required/
    );
    expect(
      validateModelRouteTargets([{ ai_provider_id: '', model: 'm' }])
    ).toMatch(/ai_provider_id is required/);
    expect(
      validateModelRouteTargets([{ ai_provider_id: 7, model: 'm' }])
    ).toMatch(/ai_provider_id is required/);
  });

  test('requires a non-empty string model', () => {
    expect(validateModelRouteTargets([{ ai_provider_id: 'aip_1' }])).toMatch(
      /targets\[0\]\.model is required/
    );
    expect(
      validateModelRouteTargets([{ ai_provider_id: 'aip_1', model: '' }])
    ).toMatch(/model is required/);
    expect(
      validateModelRouteTargets([{ ai_provider_id: 'aip_1', model: 12 }])
    ).toMatch(/model is required/);
  });

  test.each([0, -1, 1.5, '30', null])(
    'rejects timeout_seconds %p',
    (timeout) => {
      expect(
        validateModelRouteTargets([{ ...target(), timeout_seconds: timeout }])
      ).toMatch(/timeout_seconds must be a positive integer/);
    }
  );

  test.each([-1, 0.5, '1', null])('rejects max_retries %p', (retries) => {
    expect(
      validateModelRouteTargets([{ ...target(), max_retries: retries }])
    ).toMatch(/max_retries must be an integer greater than or equal to 0/);
  });

  test('reports the first problem, in target order', () => {
    expect(
      validateModelRouteTargets([target(), { ...target(), max_retries: -1 }])
    ).toMatch(/targets\[1\]\.max_retries/);
  });

  test('rejects an attempt budget over the cap, naming the computed total', () => {
    const message = validateModelRouteTargets([
      target({ max_retries: 5 }),
      target({ max_retries: 5 }),
    ]);
    expect(message).toContain('12 total attempts');
    expect(message).toContain(`maximum is ${MAX_MODEL_ROUTE_ATTEMPTS}`);
  });

  test('accepts a budget sitting exactly on the cap', () => {
    expect(
      validateModelRouteTargets([
        target({ max_retries: 4 }),
        target({ max_retries: 4 }),
      ])
    ).toBeNull();
  });
});

describe('modelRouteTotalAttempts', () => {
  test('counts one attempt per target plus its retries', () => {
    expect(modelRouteTotalAttempts([target()])).toBe(1);
    expect(
      modelRouteTotalAttempts([target({ max_retries: 2 }), target()])
    ).toBe(4);
  });
});

describe('validateModelRouteRetryOn', () => {
  test('accepts any non-empty subset of the known classes', () => {
    expect(validateModelRouteRetryOn(['timeout'])).toBeNull();
    expect(
      validateModelRouteRetryOn(['provider_error', 'timeout', 'rate_limited'])
    ).toBeNull();
  });

  test.each([undefined, null, [], 'timeout', {}] as unknown[])(
    'rejects %p',
    (value) => {
      expect(validateModelRouteRetryOn(value)).toMatch(/non-empty array/);
    }
  );

  test('rejects an unknown class, naming it and the allowed set', () => {
    const message = validateModelRouteRetryOn(['timeout', 'meltdown']);
    expect(message).toContain("unknown class 'meltdown'");
    expect(message).toContain('provider_error');
  });
});

describe('validateModelRouteBreakerConfig', () => {
  test('accepts positive integers', () => {
    expect(
      validateModelRouteBreakerConfig({
        failureThreshold: 1,
        cooldownSeconds: 1,
      })
    ).toBeNull();
  });

  test.each([0, -1, 1.5, '3', null, undefined] as unknown[])(
    'rejects failure_threshold %p',
    (failureThreshold) => {
      expect(
        validateModelRouteBreakerConfig({
          failureThreshold,
          cooldownSeconds: 60,
        })
      ).toMatch(/failure_threshold must be a positive integer/);
    }
  );

  test.each([0, -5, 0.5, '60', null, undefined] as unknown[])(
    'rejects cooldown_seconds %p',
    (cooldownSeconds) => {
      expect(
        validateModelRouteBreakerConfig({
          failureThreshold: 3,
          cooldownSeconds,
        })
      ).toMatch(/cooldown_seconds must be a positive integer/);
    }
  );
});

describe('validateModelRouteExclusivity', () => {
  test('accepts a pinned provider, with or without a model', () => {
    expect(
      validateModelRouteExclusivity({
        modelRouteId: null,
        aiProviderId: 'aip_1',
        model: null,
      })
    ).toBeNull();
    expect(
      validateModelRouteExclusivity({
        modelRouteId: undefined,
        aiProviderId: 'aip_1',
        model: 'gpt-4o-mini',
      })
    ).toBeNull();
  });

  test('accepts a route on its own', () => {
    expect(
      validateModelRouteExclusivity({
        modelRouteId: 'route_1',
        aiProviderId: null,
        model: null,
      })
    ).toBeNull();
    // An empty string is "not set" on either side — the wire form of a cleared
    // field in a form-driven client.
    expect(
      validateModelRouteExclusivity({
        modelRouteId: 'route_1',
        aiProviderId: '',
        model: '',
      })
    ).toBeNull();
  });

  test('rejects both, and says how to switch', () => {
    const message = validateModelRouteExclusivity({
      modelRouteId: 'route_1',
      aiProviderId: 'aip_1',
      model: null,
    });
    expect(message).toMatch(/mutually exclusive/);
    expect(message).toMatch(/set ai_provider_id to null/);
  });

  test('rejects neither', () => {
    expect(
      validateModelRouteExclusivity({
        modelRouteId: null,
        aiProviderId: undefined,
        model: 'gpt-4o-mini',
      })
    ).toMatch(/exactly one of ai_provider_id or model_route_id/);
  });

  test('rejects a model alongside a route', () => {
    expect(
      validateModelRouteExclusivity({
        modelRouteId: 'route_1',
        aiProviderId: null,
        model: 'gpt-4o-mini',
      })
    ).toMatch(/each route target names its own model/);
  });
});
