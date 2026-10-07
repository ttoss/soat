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

  test('validate-formation hits validate endpoint', async () => {
    const requests = await cliTestClient.call([
      'validate-formation',
      '--template-path',
      templatePath,
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/api/v1/formations/validate');

    const body = requests[0]?.body as { template?: { resources?: unknown } };
    expect(body.template).toBeDefined();
    expect(body.template?.resources).toBeDefined();
  });

  test('validate-formation forwards --parameter values in the request body', async () => {
    const requests = await cliTestClient.call([
      'validate-formation',
      '--template-path',
      templatePath,
      '--parameter',
      'appUrl=https://example.com',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.path).toBe('/api/v1/formations/validate');

    const body = requests[0]?.body as {
      template?: { resources?: unknown };
      parameters?: Record<string, string>;
    };
    expect(body.template?.resources).toBeDefined();
    expect(body.parameters?.appUrl).toBe('https://example.com');
  });

  test('plan-formation hits plan endpoint and resolves env-backed parameter', async () => {
    const requests = await cliTestClient.call([
      'plan-formation',
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
    expect(requests[0]?.path).toBe('/api/v1/formations/plan');

    const body = requests[0]?.body as {
      project_id?: string;
      parameters?: Record<string, string>;
    };
    expect(body.project_id).toBe('proj_test');
    expect(body.parameters?.appUrl).toBe('https://from-env-file.test');
  });

  test('create-formation hits create endpoint with parameters from repeated --parameter', async () => {
    const requests = await cliTestClient.call([
      'create-formation',
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
    expect(requests[0]?.path).toBe('/api/v1/formations');

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

  test('update-formation hits update endpoint', async () => {
    const requests = await cliTestClient.call([
      'update-formation',
      '--formation-id',
      'form_existing',
      '--template-path',
      templatePath,
      '--parameter',
      'toolsApiKey=updated-key',
    ]);

    expect(cliTestClient.fetchMock).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.path).toBe('/api/v1/formations/form_existing');

    const body = requests[0]?.body as {
      parameters?: Record<string, string>;
      template?: unknown;
    };
    expect(body.parameters?.toolsApiKey).toBe('updated-key');
    expect(body.template).toBeDefined();
  });

  test('--parameter Key=@ENV_VAR_NAME reads value from env file (shell-safe)', async () => {
    const requests = await cliTestClient.call([
      'create-formation',
      '--project-id',
      'proj_test',
      '--name',
      'at-ref-stack',
      '--template-path',
      templatePath,
      '--env-file',
      envFilePath,
      '--parameter',
      'appUrl=@APP_URL',
    ]);

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as {
      parameters?: Record<string, string>;
    };
    expect(body.parameters?.appUrl).toBe('https://from-env-file.test');
  });

  test('--parameter KEY (no =) reads value from env file using key as var name', async () => {
    const requests = await cliTestClient.call([
      'create-formation',
      '--project-id',
      'proj_test',
      '--name',
      'no-eq-stack',
      '--template-path',
      templatePath,
      '--env-file',
      envFilePath,
      '--parameter',
      'APP_URL',
    ]);

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as {
      parameters?: Record<string, string>;
    };
    expect(body.parameters?.APP_URL).toBe('https://from-env-file.test');
  });

  test('--parameter KEY (no =) reads value from process.env when not in env file', async () => {
    const originalValue = process.env['SOAT_TEST_PROCESS_ENV_VAR'];
    process.env['SOAT_TEST_PROCESS_ENV_VAR'] = 'from-process-env';
    try {
      const requests = await cliTestClient.call([
        'create-formation',
        '--project-id',
        'proj_test',
        '--name',
        'process-env-stack',
        '--template-path',
        templatePath,
        '--parameter',
        'SOAT_TEST_PROCESS_ENV_VAR',
      ]);

      expect(requests).toHaveLength(1);
      const body = requests[0]?.body as {
        parameters?: Record<string, string>;
      };
      expect(body.parameters?.SOAT_TEST_PROCESS_ENV_VAR).toBe(
        'from-process-env'
      );
    } finally {
      if (originalValue === undefined) {
        delete process.env['SOAT_TEST_PROCESS_ENV_VAR'];
      } else {
        process.env['SOAT_TEST_PROCESS_ENV_VAR'] = originalValue;
      }
    }
  });

  test('--parameter KEY (no =) omits the parameter when env var is missing, deferring to the server (use-previous-value or error)', async () => {
    const requests = await cliTestClient.call([
      'create-formation',
      '--project-id',
      'proj_test',
      '--name',
      'missing-env-stack',
      '--template-path',
      templatePath,
      '--parameter',
      'MISSING_VAR',
    ]);

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as {
      parameters?: Record<string, string>;
    };
    expect(body.parameters?.['MISSING_VAR']).toBeUndefined();
    expect(
      body.parameters ? Object.hasOwn(body.parameters, 'MISSING_VAR') : false
    ).toBe(false);
  });

  test('--parameter Key=@ENV_VAR_NAME omits the parameter when env var is missing, deferring to the server (use-previous-value or error)', async () => {
    const requests = await cliTestClient.call([
      'create-formation',
      '--project-id',
      'proj_test',
      '--name',
      'missing-at-ref-stack',
      '--template-path',
      templatePath,
      '--parameter',
      'apiKey=@MISSING_SECRET',
    ]);

    expect(requests).toHaveLength(1);
    const body = requests[0]?.body as {
      parameters?: Record<string, string>;
    };
    expect(
      body.parameters ? Object.hasOwn(body.parameters, 'apiKey') : false
    ).toBe(false);
  });

  test('--parameter Key=$ENV_VAR_NAME (simple substitution) still throws when env var is missing', async () => {
    await expect(
      cliTestClient.call([
        'create-formation',
        '--project-id',
        'proj_test',
        '--name',
        'missing-simple-ref-stack',
        '--template-path',
        templatePath,
        '--parameter',
        'apiKey=$MISSING_SECRET',
      ])
    ).rejects.toThrow('Missing environment variable: MISSING_SECRET');
  });

  describe('file references in --template-path', () => {
    let refDir = '';

    beforeAll(() => {
      refDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soat-cli-files-'));
      fs.mkdirSync(path.join(refDir, 'docs', 'guide'), { recursive: true });
      fs.writeFileSync(path.join(refDir, 'docs', 'faq.md'), 'Questions.');
      fs.writeFileSync(
        path.join(refDir, 'docs', 'guide', 'start.md'),
        'Start here.'
      );
      fs.writeFileSync(path.join(refDir, 'docs', 'skip.txt'), 'Not markdown.');
      fs.writeFileSync(path.join(refDir, 'intro.md'), 'Intro.');
    });

    afterAll(() => {
      fs.rmSync(refDir, { recursive: true, force: true });
    });

    const writeTemplate = (lines: string[]) => {
      const file = path.join(refDir, 'stack', 'formation.yaml');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, lines.join('\n'));
      return file;
    };

    const sentTemplate = async (file: string) => {
      const requests = await cliTestClient.call([
        'validate-formation',
        '--template-path',
        file,
      ]);
      return (requests[0]?.body as { template: Record<string, unknown> })
        .template;
    };

    test('{ files: glob } becomes a map of each match, keyed below the fixed prefix', async () => {
      const template = await sentTemplate(
        writeTemplate([
          'resources:',
          '  Docs:',
          '    type: document',
          "    for_each: { files: '../docs/**/*.md' }",
          '    properties:',
          "      path: { sub: '/kb/${each.key}' }",
          '      content: { each: value }',
        ])
      );

      expect(template).toEqual({
        resources: {
          Docs: {
            type: 'document',
            for_each: {
              'faq.md': 'Questions.',
              'guide/start.md': 'Start here.',
            },
            properties: {
              path: { sub: '/kb/${each.key}' },
              content: { each: 'value' },
            },
          },
        },
      });
    });

    test("{ file: path } becomes that file's text, relative to the template", async () => {
      const template = await sentTemplate(
        writeTemplate([
          'resources:',
          '  Intro:',
          '    type: document',
          '    properties:',
          "      content: { file: '../intro.md' }",
        ])
      );

      expect(template).toEqual({
        resources: {
          Intro: { type: 'document', properties: { content: 'Intro.' } },
        },
      });
    });

    test('an object with other keys beside `file` is left alone', async () => {
      const template = await sentTemplate(
        writeTemplate([
          'resources:',
          '  Tool:',
          '    type: tool',
          '    properties:',
          "      schema: { file: 'x', type: string }",
        ])
      );

      expect(
        (template.resources as Record<string, { properties: unknown }>).Tool
          .properties
      ).toEqual({ schema: { file: 'x', type: 'string' } });
    });

    test('a glob that matches nothing is refused before any request', async () => {
      await expect(
        sentTemplate(
          writeTemplate([
            'resources:',
            '  Docs:',
            '    type: document',
            "    for_each: { files: '../nowhere/*.md' }",
            '    properties: { content: { each: value } }',
          ])
        )
      ).rejects.toThrow('matched no files');
      expect(cliTestClient.fetchMock).not.toHaveBeenCalled();
    });

    test('a missing file is refused before any request', async () => {
      await expect(
        sentTemplate(
          writeTemplate([
            'resources:',
            '  Intro:',
            '    type: document',
            "    properties: { content: { file: '../missing.md' } }",
          ])
        )
      ).rejects.toThrow('Unable to read file');
      expect(cliTestClient.fetchMock).not.toHaveBeenCalled();
    });
  });
});
