import { createCliTestClient } from '../testClient';

// A body property the spec declares with *no* `type` accepts more than one
// shape — `tool_choice` takes a string ("auto", "required") or an object
// ({ type: "tool", tool_name: "…" }). OpenAPI 3.0 has no union `type`, so the
// schema simply omits it, and the manifest generator used to default a missing
// type to `"string"`.
//
// That default is what broke forcing: a string-typed flag is (correctly) never
// JSON-coerced, so the object form reached the server as the *text*
// `{"type":"tool",...}`, and `normalizeToolChoice` maps an unrecognized string
// to `undefined`. The agent was created, `get-agent` echoed the value back, and
// the model was never actually forced — silently, at every layer (#955).
describe('union-typed flags (no `type` in the spec) accept both shapes', () => {
  const cli = createCliTestClient();

  beforeEach(() => {
    cli.reset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  test('an object tool_choice reaches the server as an object', async () => {
    const requests = await cli.call([
      'create-agent',
      '--project_id',
      'proj_1',
      '--ai_provider_id',
      'aip_1',
      '--name',
      'forcer',
      '--tool_choice',
      '{"type":"tool","tool_name":"record_order"}',
    ]);

    const body = requests[0]?.body as { tool_choice?: unknown };
    expect(body.tool_choice).toEqual({
      type: 'tool',
      tool_name: 'record_order',
    });
  });

  test('a string tool_choice still reaches the server as a string', async () => {
    const requests = await cli.call([
      'create-agent',
      '--project_id',
      'proj_1',
      '--ai_provider_id',
      'aip_1',
      '--name',
      'auto-picker',
      '--tool_choice',
      'auto',
    ]);

    const body = requests[0]?.body as { tool_choice?: unknown };
    expect(body.tool_choice).toBe('auto');
  });

  test('update-agent carries the object form too', async () => {
    const requests = await cli.call([
      'update-agent',
      '--agent_id',
      'agent_1',
      '--tool_choice',
      '{"type":"tool","tool_name":"record_order"}',
    ]);

    const body = requests[0]?.body as { tool_choice?: unknown };
    expect(body.tool_choice).toEqual({
      type: 'tool',
      tool_name: 'record_order',
    });
  });

  // The fix widens *only* properties the spec leaves typeless. A property the
  // spec really does declare `type: string` must keep the verbatim behavior
  // that `stringFlags.test.ts` pins — a JSON document passed to `--value` is a
  // string, not an object (a GCP key file used to be sent as an object and
  // answered 500).
  test('a genuinely string-typed flag is still not JSON-coerced', async () => {
    const keyFile = '{"type":"service_account","project_id":"p"}';

    const requests = await cli.call([
      'create-secret',
      '--project_id',
      'proj_1',
      '--name',
      'gcp-key',
      '--value',
      keyFile,
    ]);

    const body = requests[0]?.body as { value?: unknown };
    expect(body.value).toBe(keyFile);
  });
});
