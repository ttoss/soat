import { parseAdmissionRegistration } from 'src/lib/admission';

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
