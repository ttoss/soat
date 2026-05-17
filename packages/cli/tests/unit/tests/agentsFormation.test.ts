import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createCliTestClient } from '../testClient';

let tmpDir = '';
let templatePath = '';
let envFilePath = '';
const cliTestClient = createCliTestClient();

describe('formation wrapper endpoint integration', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-cli-test-'));
    templatePath = path.join(tmpDir, 'formation.yaml');
    envFilePath = path.join(tmpDir, '.env.local');

    fs.writeFileSync(
      templatePath,
      [
        'resources:',
        '  assistant:',
        '    type: agent',
        '    properties: {}',
      ].join('\n')
    );
    fs.writeFileSync(envFilePath, 'APP_URL=https://from-env-file.test\n');
  });

  afterAll(() => {
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    cliTestClient.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('validate-agent-formation hits validate endpoint', async () => {
    const requests = await cliTestClient.call([
      'validate-agent-formation',
      '--template-path',
      templatePath,
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/api/v1/agent-formations/validate');

    const body = requests[0]?.body as { template?: { resources?: unknown } };
    expect(body.template).toBeDefined();
    expect(body.template?.resources).toBeDefined();
  });

  test('plan-agent-formation hits plan endpoint and resolves env-backed parameter', async () => {
    const requests = await cliTestClient.call([
      'plan-agent-formation',
      '--project-id',
      'proj_test',
      '--template-path',
      templatePath,
      '--env-file',
      envFilePath,
      '--parameter',
      'appUrl=$APP_URL',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/api/v1/agent-formations/plan');

    const body = requests[0]?.body as {
      project_id?: string;
      parameters?: Record<string, string>;
    };
    expect(body.project_id).toBe('proj_test');
    expect(body.parameters?.appUrl).toBe('https://from-env-file.test');
  });

  test('create-agent-formation hits create endpoint with parameters from repeated --parameter', async () => {
    const requests = await cliTestClient.call([
      'create-agent-formation',
      '--project-id',
      'proj_test',
      '--name',
      'my-stack',
      '--template-path',
      templatePath,
      '--parameter',
      'toolsApiKey=abc123',
      '--parameter',
      'xaiSecretId=sec_001',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/api/v1/agent-formations');

    const body = requests[0]?.body as {
      project_id?: string;
      name?: string;
      parameters?: Record<string, string>;
    };
    expect(body.project_id).toBe('proj_test');
    expect(body.name).toBe('my-stack');
    expect(body.parameters?.toolsApiKey).toBe('abc123');
    expect(body.parameters?.xaiSecretId).toBe('sec_001');
  });

  test('update-agent-formation hits update endpoint', async () => {
    const requests = await cliTestClient.call([
      'update-agent-formation',
      '--formation-id',
      'af_existing',
      '--template-path',
      templatePath,
      '--parameter',
      'toolsApiKey=updated-key',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.path).toBe('/api/v1/agent-formations/af_existing');

    const body = requests[0]?.body as {
      parameters?: Record<string, string>;
      template?: unknown;
    };
    expect(body.parameters?.toolsApiKey).toBe('updated-key');
    expect(body.template).toBeDefined();
  });
});
