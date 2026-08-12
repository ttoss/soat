import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DomainError } from 'src/errors';
import {
  buildAwsExternalAccountAuthClient,
  createAwsSecurityCredentialsSupplier,
  isAwsExternalAccountConfig,
  loadAwsExternalAccountAuthClient,
  resetAwsExternalAccountAuthClientCache,
} from 'src/lib/vertexAwsCredentials';

// A credential configuration exactly as `gcloud iam workload-identity-pools
// create-cred-config --aws` emits one. It carries no secret material: the
// pool/provider path and the impersonation URL are all it names.
const AWS_WIF_CONFIG = {
  universe_domain: 'googleapis.com',
  type: 'external_account' as const,
  audience:
    '//iam.googleapis.com/projects/634579095029/locations/global/workloadIdentityPools/example-pool/providers/example-provider',
  subject_token_type: 'urn:ietf:params:aws:token-type:aws4_request',
  token_url: 'https://sts.googleapis.com/v1/token',
  credential_source: {
    environment_id: 'aws1',
    region_url:
      'http://169.254.169.254/latest/meta-data/placement/availability-zone',
    url: 'http://169.254.169.254/latest/meta-data/iam/security-credentials',
    regional_cred_verification_url:
      'https://sts.{region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15',
  },
  service_account_impersonation_url:
    'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/example@example.iam.gserviceaccount.com:generateAccessToken',
};

const staticCredentialProvider = () => {
  return Promise.resolve({
    accessKeyId: 'ASIAEXAMPLE',
    secretAccessKey: 'secret-example',
    sessionToken: 'session-example',
  });
};

describe('isAwsExternalAccountConfig', () => {
  test('accepts an AWS-sourced external account configuration', () => {
    expect(isAwsExternalAccountConfig(AWS_WIF_CONFIG)).toBe(true);
  });

  test('rejects a service-account key file', () => {
    expect(
      isAwsExternalAccountConfig({
        type: 'service_account',
        project_id: 'sa-project',
        client_email: 'vertex@sa-project.iam.gserviceaccount.com',
      })
    ).toBe(false);
  });

  test('rejects an external account sourced from something other than AWS', () => {
    // Azure and file-sourced configurations are external_account too, but the
    // ECS provider chain has nothing to say about their credentials.
    expect(
      isAwsExternalAccountConfig({
        ...AWS_WIF_CONFIG,
        credential_source: { file: '/var/run/secrets/token' },
      })
    ).toBe(false);
  });

  test('rejects values that are not objects', () => {
    expect(isAwsExternalAccountConfig(null)).toBe(false);
    expect(isAwsExternalAccountConfig('external_account')).toBe(false);
    expect(isAwsExternalAccountConfig([AWS_WIF_CONFIG])).toBe(false);
  });
});

describe('createAwsSecurityCredentialsSupplier', () => {
  test('maps the AWS provider chain onto the supplier shape google expects', async () => {
    const supplier = createAwsSecurityCredentialsSupplier({
      credentialProvider: staticCredentialProvider,
      region: 'us-east-2',
    });

    await expect(supplier.getAwsRegion()).resolves.toBe('us-east-2');
    // `token` is google's name for what AWS calls `sessionToken`; getting this
    // mapping wrong yields a signature that STS rejects with no useful detail.
    await expect(supplier.getAwsSecurityCredentials()).resolves.toEqual({
      accessKeyId: 'ASIAEXAMPLE',
      secretAccessKey: 'secret-example',
      token: 'session-example',
    });
  });

  test('omits token entirely for long-lived credentials', async () => {
    const supplier = createAwsSecurityCredentialsSupplier({
      credentialProvider: () => {
        return Promise.resolve({
          accessKeyId: 'AKIAEXAMPLE',
          secretAccessKey: 'secret-example',
        });
      },
      region: 'us-east-2',
    });

    await expect(supplier.getAwsSecurityCredentials()).resolves.toEqual({
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example',
    });
  });

  test('reads the region from the environment when none is given', async () => {
    const previous = process.env.AWS_REGION;
    process.env.AWS_REGION = 'sa-east-1';
    try {
      const supplier = createAwsSecurityCredentialsSupplier({
        credentialProvider: staticCredentialProvider,
      });
      await expect(supplier.getAwsRegion()).resolves.toBe('sa-east-1');
    } finally {
      if (previous === undefined) {
        delete process.env.AWS_REGION;
      } else {
        process.env.AWS_REGION = previous;
      }
    }
  });

  test('fails with a misconfiguration error when no region can be resolved', async () => {
    const region = process.env.AWS_REGION;
    const defaultRegion = process.env.AWS_DEFAULT_REGION;
    delete process.env.AWS_REGION;
    delete process.env.AWS_DEFAULT_REGION;
    try {
      const supplier = createAwsSecurityCredentialsSupplier({
        credentialProvider: staticCredentialProvider,
      });
      await expect(supplier.getAwsRegion()).rejects.toThrow(DomainError);
    } finally {
      if (region !== undefined) process.env.AWS_REGION = region;
      if (defaultRegion !== undefined) {
        process.env.AWS_DEFAULT_REGION = defaultRegion;
      }
    }
  });
});

describe('buildAwsExternalAccountAuthClient', () => {
  test('builds a client that carries the supplier instead of credential_source', () => {
    const client = buildAwsExternalAccountAuthClient({
      credentialConfig: AWS_WIF_CONFIG,
      credentialProvider: staticCredentialProvider,
      region: 'us-east-2',
    });

    // google-auth-library rejects a configuration carrying both a
    // credential_source and a supplier, so a client coming back at all is the
    // assertion that credential_source was dropped rather than merged.
    expect(typeof client.getAccessToken).toBe('function');
  });

  test('does not mutate the caller configuration', () => {
    const config = structuredClone(AWS_WIF_CONFIG);
    buildAwsExternalAccountAuthClient({
      credentialConfig: config,
      credentialProvider: staticCredentialProvider,
      region: 'us-east-2',
    });

    // The same parsed configuration is reused for every model build, so
    // stripping credential_source in place would work once and then leave a
    // configuration that no longer describes what is on disk.
    expect(config).toEqual(AWS_WIF_CONFIG);
  });
});

describe('loadAwsExternalAccountAuthClient', () => {
  const writeConfig = (contents: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'vertex-adc-'));
    const path = join(dir, 'credentials.json');
    writeFileSync(path, contents);
    return path;
  };

  beforeEach(() => {
    resetAwsExternalAccountAuthClientCache();
  });

  afterAll(() => {
    resetAwsExternalAccountAuthClientCache();
  });

  test('returns a client for an AWS-federated credential file', () => {
    const client = loadAwsExternalAccountAuthClient({
      credentialsPath: writeConfig(JSON.stringify(AWS_WIF_CONFIG)),
    });
    expect(client).toBeDefined();
  });

  test('declines a service-account key file so ADC stays in charge', () => {
    const path = writeConfig(
      JSON.stringify({
        type: 'service_account',
        project_id: 'sa-project',
        client_email: 'vertex@sa-project.iam.gserviceaccount.com',
      })
    );
    expect(
      loadAwsExternalAccountAuthClient({ credentialsPath: path })
    ).toBeUndefined();
  });

  test('declines a malformed file rather than failing the model build', () => {
    // A broken ADC file is the operator's problem to fix, but it must surface
    // as google-auth-library's own error at request time, not as a crash while
    // assembling an unrelated provider's model.
    const path = writeConfig('{ not json');
    expect(
      loadAwsExternalAccountAuthClient({ credentialsPath: path })
    ).toBeUndefined();
  });

  test('declines a path that does not exist', () => {
    expect(
      loadAwsExternalAccountAuthClient({
        credentialsPath: join(tmpdir(), 'definitely-absent-adc.json'),
      })
    ).toBeUndefined();
  });

  test('returns undefined when no credential file is configured', () => {
    const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    try {
      expect(loadAwsExternalAccountAuthClient()).toBeUndefined();
    } finally {
      if (previous !== undefined) {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
      }
    }
  });

  test('reads GOOGLE_APPLICATION_CREDENTIALS when no path is passed', () => {
    const previous = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    process.env.GOOGLE_APPLICATION_CREDENTIALS = writeConfig(
      JSON.stringify(AWS_WIF_CONFIG)
    );
    try {
      expect(loadAwsExternalAccountAuthClient()).toBeDefined();
    } finally {
      if (previous === undefined) {
        delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
      } else {
        process.env.GOOGLE_APPLICATION_CREDENTIALS = previous;
      }
    }
  });

  test('memoizes the client across calls, and reload re-reads the file', () => {
    const path = writeConfig(JSON.stringify(AWS_WIF_CONFIG));
    const first = loadAwsExternalAccountAuthClient({ credentialsPath: path });
    const second = loadAwsExternalAccountAuthClient({ credentialsPath: path });
    expect(second).toBe(first);

    const reloaded = loadAwsExternalAccountAuthClient({
      credentialsPath: path,
      reload: true,
    });
    expect(reloaded).not.toBe(first);
  });
});
