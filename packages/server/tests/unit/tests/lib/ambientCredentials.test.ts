import { DomainError } from 'src/errors';
import {
  assertAiProviderCarriesCredential,
  assertAmbientCredentialsAllowed,
} from 'src/lib/ambientCredentials';

const TENANT_PROJECT = 'proj_tenant';

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
          return assertAmbientCredentialsAllowed({
            project: TENANT_PROJECT,
            provider,
          });
        }).toThrow(
          expect.objectContaining({ code: 'AI_PROVIDER_MISCONFIGURED' })
        );
      });
    }
  );

  test('names the deployment credential the record would have used', () => {
    withFlag(undefined, () => {
      expect(() => {
        return assertAmbientCredentialsAllowed({
          project: TENANT_PROJECT,
          provider: 'vertex',
        });
      }).toThrow(/Application Default Credentials/);
      expect(() => {
        return assertAmbientCredentialsAllowed({
          project: TENANT_PROJECT,
          provider: 'bedrock',
        });
      }).toThrow(/AWS default credential chain/);
      expect(() => {
        return assertAmbientCredentialsAllowed({
          project: TENANT_PROJECT,
          provider: 'anthropic',
        });
      }).toThrow(/Anthropic workload identity federation/);
    });
  });

  test('names the setting that would allow it', () => {
    withFlag(undefined, () => {
      expect(() => {
        return assertAmbientCredentialsAllowed({
          project: TENANT_PROJECT,
          provider: 'bedrock',
        });
      }).toThrow(/AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS/);
    });
  });

  test('allows it when the operator opted in', () => {
    withFlag('true', () => {
      expect(() => {
        return assertAmbientCredentialsAllowed({
          project: TENANT_PROJECT,
          provider: 'bedrock',
        });
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
          return assertAmbientCredentialsAllowed({
            project: TENANT_PROJECT,
            provider: 'vertex',
          });
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
          return assertAiProviderCarriesCredential({
            project: TENANT_PROJECT,
            provider,
          });
        }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
      });
    }
  );

  test('names secret_id as the field to fix', () => {
    withFlag(undefined, () => {
      try {
        assertAiProviderCarriesCredential({
          project: TENANT_PROJECT,
          provider: 'bedrock',
        });
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
          return assertAiProviderCarriesCredential({
            project: TENANT_PROJECT,
            provider,
            secretId: 7,
          });
        }).not.toThrow();
      });
    }
  );

  test('accepts a credential-less record once the operator opted in', () => {
    withFlag('true', () => {
      expect(() => {
        return assertAiProviderCarriesCredential({
          project: TENANT_PROJECT,
          provider: 'vertex',
        });
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
          return assertAiProviderCarriesCredential({
            project: TENANT_PROJECT,
            provider,
          });
        }).not.toThrow();
      });
    }
  );
});

describe('AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS', () => {
  const withProjects = (value: string | undefined, run: () => void) => {
    const previous = process.env.AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS;
    if (value === undefined) {
      delete process.env.AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS;
    } else {
      process.env.AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS = value;
    }
    try {
      run();
    } finally {
      if (previous === undefined) {
        delete process.env.AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS;
      } else {
        process.env.AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS = previous;
      }
    }
  };

  test.each([undefined, '', ' , '])(
    'covers every project when it is %p',
    (value) => {
      withFlag('true', () => {
        withProjects(value, () => {
          expect(() => {
            return assertAmbientCredentialsAllowed({
              project: 'proj_any',
              provider: 'bedrock',
            });
          }).not.toThrow();
        });
      });
    }
  );

  test('allows a named project at build and at write', () => {
    withFlag('true', () => {
      withProjects('proj_other, proj_tenant', () => {
        expect(() => {
          return assertAmbientCredentialsAllowed({
            project: TENANT_PROJECT,
            provider: 'vertex',
          });
        }).not.toThrow();
        expect(() => {
          return assertAiProviderCarriesCredential({
            project: TENANT_PROJECT,
            provider: 'vertex',
          });
        }).not.toThrow();
      });
    });
  });

  test('refuses any other project at build and at write', () => {
    withFlag('true', () => {
      withProjects('proj_other', () => {
        expect(() => {
          return assertAmbientCredentialsAllowed({
            project: TENANT_PROJECT,
            provider: 'anthropic',
          });
        }).toThrow(/AI_PROVIDER_AMBIENT_CREDENTIAL_PROJECTS does not name/);
        expect(() => {
          return assertAiProviderCarriesCredential({
            project: TENANT_PROJECT,
            provider: 'bedrock',
          });
        }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
      });
    });
  });

  test('grants nothing without the opt-in', () => {
    withFlag(undefined, () => {
      withProjects(TENANT_PROJECT, () => {
        expect(() => {
          return assertAmbientCredentialsAllowed({
            project: TENANT_PROJECT,
            provider: 'bedrock',
          });
        }).toThrow(/AI_PROVIDER_ALLOW_AMBIENT_CREDENTIALS/);
      });
    });
  });
});
