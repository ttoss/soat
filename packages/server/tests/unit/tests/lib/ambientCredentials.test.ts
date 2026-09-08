import { DomainError } from 'src/errors';
import {
  assertAiProviderCarriesCredential,
  assertAmbientCredentialsAllowed,
} from 'src/lib/ambientCredentials';

const withFlag = (value: string | undefined, run: () => void) => {
  const previous = process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS;
  if (value === undefined) {
    delete process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS;
  } else {
    process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS = value;
  }
  try {
    run();
  } finally {
    if (previous === undefined) {
      delete process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS;
    } else {
      process.env.AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS = previous;
    }
  }
};

describe('assertAmbientCredentialsAllowed', () => {
  test.each(['bedrock', 'vertex'] as const)(
    'refuses %s by default',
    (provider) => {
      withFlag(undefined, () => {
        expect(() => {
          return assertAmbientCredentialsAllowed({ provider });
        }).toThrow(
          expect.objectContaining({ code: 'AI_PROVIDER_MISCONFIGURED' })
        );
      });
    }
  );

  test('names the deployment credential the record would have used', () => {
    withFlag(undefined, () => {
      expect(() => {
        return assertAmbientCredentialsAllowed({ provider: 'vertex' });
      }).toThrow(/Application Default Credentials/);
      expect(() => {
        return assertAmbientCredentialsAllowed({ provider: 'bedrock' });
      }).toThrow(/AWS default credential chain/);
    });
  });

  test('names the setting that would allow it', () => {
    withFlag(undefined, () => {
      expect(() => {
        return assertAmbientCredentialsAllowed({ provider: 'bedrock' });
      }).toThrow(/AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS/);
    });
  });

  test('allows it when the operator opted in', () => {
    withFlag('true', () => {
      expect(() => {
        return assertAmbientCredentialsAllowed({ provider: 'bedrock' });
      }).not.toThrow();
    });
  });

  // Anything but the literal opt-in leaves the refusal in place: an operator
  // who meant to enable it and typed something else gets the refusal, not a
  // silent grant of the deployment's own credentials.
  test.each(['false', '1', 'yes', 'TRUE', ''])(
    'stays refused for the value %p',
    (value) => {
      withFlag(value, () => {
        expect(() => {
          return assertAmbientCredentialsAllowed({ provider: 'vertex' });
        }).toThrow(DomainError);
      });
    }
  );
});

describe('assertAiProviderCarriesCredential', () => {
  test.each(['bedrock', 'vertex'] as const)(
    'refuses a %s record that links no secret and configures no key',
    (provider) => {
      withFlag(undefined, () => {
        expect(() => {
          return assertAiProviderCarriesCredential({ provider });
        }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
      });
    }
  );

  test('names secret_id as the field to fix', () => {
    withFlag(undefined, () => {
      try {
        assertAiProviderCarriesCredential({ provider: 'bedrock' });
        throw new Error('expected a refusal');
      } catch (error) {
        expect(error).toBeInstanceOf(DomainError);
        expect((error as DomainError).meta).toEqual({ field: 'secret_id' });
      }
    });
  });

  test.each(['bedrock', 'vertex'] as const)(
    'accepts a %s record that links a secret',
    (provider) => {
      withFlag(undefined, () => {
        expect(() => {
          return assertAiProviderCarriesCredential({ provider, secretId: 7 });
        }).not.toThrow();
      });
    }
  );

  // `config.apiKey` is a documented credential fallback for both providers, so
  // a record carrying one is not reaching for the deployment's.
  test.each(['bedrock', 'vertex'] as const)(
    'accepts a %s record carrying config.apiKey',
    (provider) => {
      withFlag(undefined, () => {
        expect(() => {
          return assertAiProviderCarriesCredential({
            provider,
            config: { apiKey: 'ABSKexample' },
          });
        }).not.toThrow();
      });
    }
  );

  test('accepts a credential-less record once the operator opted in', () => {
    withFlag('true', () => {
      expect(() => {
        return assertAiProviderCarriesCredential({ provider: 'vertex' });
      }).not.toThrow();
    });
  });

  // Every other slug either carries its key in the record or takes none at
  // all; none of them reaches for a credential the deployment holds.
  test.each(['openai', 'anthropic', 'azure', 'ollama', 'gateway'] as const)(
    'leaves a %s record alone',
    (provider) => {
      withFlag(undefined, () => {
        expect(() => {
          return assertAiProviderCarriesCredential({ provider });
        }).not.toThrow();
      });
    }
  );
});
