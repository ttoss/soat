import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  assertAdmitted,
  initAdmission,
  isAdmissionDeclared,
  parseAdmissionRegistration,
  REFUSAL_CODE_PATTERN,
  registerAdmission,
} from 'src/lib/admission';
import { IAM_REGISTRATIONS_CONFIG_ENV } from 'src/lib/iamRegistrations';
import { getMergedOpenApiSpec } from 'src/lib/openapiSpec';
import { PROTOCOL_ANSWER_MAX_BYTES } from 'src/lib/requestBounds';

import {
  type AdmissionService,
  startAdmissionService,
} from '../../fixtures/admissionService';

const ENV = { ADMISSION_SECRET: 'shh' };

const parse = (admission: unknown, env: Record<string, string> = ENV) => {
  return parseAdmissionRegistration({
    config: { modules: [], admission },
    source: 'test',
    env,
  });
};

const handler = {
  url: 'https://svc.example/admit',
  secret_env: 'ADMISSION_SECRET',
};

describe('parseAdmissionRegistration', () => {
  test('reads the service and the runtime writes it is asked about', () => {
    const registration = parse({
      handler: { ...handler, timeout_seconds: 2 },
      actions: ['triggers:CreateTrigger', 'triggers:UpdateTrigger'],
    });

    expect(registration?.handler).toEqual({
      url: 'https://svc.example/admit',
      secret: 'shh',
      timeoutMs: 2000,
    });
    expect([...(registration?.actions ?? [])]).toEqual([
      'triggers:CreateTrigger',
      'triggers:UpdateTrigger',
    ]);
  });

  test('declares nothing when absent', () => {
    expect(parse(undefined)).toBeNull();
  });

  test('fails on an action that is not a runtime write', () => {
    expect(() => {
      return parse({ handler, actions: ['triggers:GetTrigger'] });
    }).toThrow(/'triggers:GetTrigger' is not a runtime write action/);
    expect(() => {
      return parse({ handler, actions: ['billing:ChargeCard'] });
    }).toThrow(/'billing:ChargeCard' is not a runtime write action/);
  });

  test('fails on an empty action list or a missing secret', () => {
    expect(() => {
      return parse({ handler, actions: [] });
    }).toThrow(/`admission.actions` must be a non-empty array/);
    expect(() => {
      return parse({ handler, actions: ['triggers:CreateTrigger'] }, {});
    }).toThrow(
      /Invalid IAM registrations config \(test\): admission: environment variable `ADMISSION_SECRET` is not set/
    );
  });
});

describe('initAdmission', () => {
  afterEach(() => {
    delete process.env[IAM_REGISTRATIONS_CONFIG_ENV];
    delete process.env.ADMISSION_SECRET;
    registerAdmission({ registration: null });
  });

  test('declares nothing when no file is named', () => {
    initAdmission();
    expect(isAdmissionDeclared('triggers:CreateTrigger')).toBe(false);
  });

  test('declares the actions the IAM registrations file names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'admission-reg-'));
    const file = path.join(dir, 'iam.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        modules: [],
        admission: { handler, actions: ['triggers:CreateTrigger'] },
      })
    );
    process.env[IAM_REGISTRATIONS_CONFIG_ENV] = file;
    process.env.ADMISSION_SECRET = 'shh';

    initAdmission();

    expect(isAdmissionDeclared('triggers:CreateTrigger')).toBe(true);
    expect(isAdmissionDeclared('triggers:UpdateTrigger')).toBe(false);
  });
});

describe('the published protocol', () => {
  test('a relayed refusal code follows the grammar AdmissionRefusal publishes', () => {
    expect(
      getMergedOpenApiSpec().components.schemas.AdmissionRefusal
    ).toMatchObject({
      properties: {
        error: {
          properties: {
            code: { pattern: REFUSAL_CODE_PATTERN.source },
          },
        },
      },
    });
  });
});

describe('assertAdmitted', () => {
  let service: AdmissionService;

  beforeAll(async () => {
    service = await startAdmissionService();
  });

  afterAll(async () => {
    service.undeclare();
    await service.close();
  });

  test('an answer over PROTOCOL_ANSWER_MAX_BYTES is unavailable, never a pass', async () => {
    service.declare({ actions: ['triggers:CreateTrigger'] });
    service.reply = {
      status: 200,
      body: { padding: 'x'.repeat(PROTOCOL_ANSWER_MAX_BYTES) },
    };

    await expect(
      assertAdmitted({
        action: 'triggers:CreateTrigger',
        projectPublicId: null,
        resourceType: 'trigger',
        targetId: null,
        body: {},
        principal: {
          principalType: 'user',
          principalId: 'usr_1',
          actsFor: null,
        },
      })
    ).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
      message:
        'The admission service did not answer for triggers:CreateTrigger: answer too large',
    });
  });

  test('an answer body that stalls past the timeout is unavailable, never a pass', async () => {
    service.declare({ actions: ['triggers:CreateTrigger'], timeoutMs: 100 });
    service.reply = { status: 200, body: { admitted: true }, stall: true };

    await expect(
      assertAdmitted({
        action: 'triggers:CreateTrigger',
        projectPublicId: null,
        resourceType: 'trigger',
        targetId: null,
        body: {},
        principal: {
          principalType: 'user',
          principalId: 'usr_1',
          actsFor: null,
        },
      })
    ).rejects.toMatchObject({
      code: 'ADMISSION_UNAVAILABLE',
      message:
        'The admission service did not answer for triggers:CreateTrigger: timed out after 100ms',
    });
  });
});
