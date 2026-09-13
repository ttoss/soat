import { jsonSchema, tool } from 'ai';
import {
  BYTES_PER_TOKEN,
  measureToolSurface,
} from 'src/lib/toolSurfaceMeasure';

const weatherTool = () => {
  return tool({
    description: 'Returns the weather for a city.',
    inputSchema: jsonSchema({
      type: 'object',
      properties: { cityName: { type: 'string' } },
      required: ['cityName'],
    }),
    execute: async () => {
      return { tempC: 18 };
    },
  });
};

describe('measureToolSurface', () => {
  test('an agent with no tools measures zero, which is not "unmeasured"', async () => {
    expect(await measureToolSurface({ tools: {} })).toEqual({
      tools: 0,
      bytes: 0,
      estimated_tokens: 0,
    });
  });

  test('counts the tools and the bytes the definitions serialize to', async () => {
    const measured = await measureToolSurface({
      tools: { get_weather: weatherTool() },
    });

    expect(measured.tools).toBe(1);
    // Name, description and the full input schema — the three things the
    // provider is sent — and nothing else.
    expect(measured.bytes).toBe(
      Buffer.byteLength(
        JSON.stringify([
          {
            name: 'get_weather',
            description: 'Returns the weather for a city.',
            inputSchema: {
              type: 'object',
              properties: { cityName: { type: 'string' } },
              required: ['cityName'],
            },
          },
        ]),
        'utf8'
      )
    );
    expect(measured.estimated_tokens).toBe(
      Math.round(measured.bytes / BYTES_PER_TOKEN)
    );
  });

  test('grows with the catalogue', async () => {
    const one = await measureToolSurface({ tools: { a: weatherTool() } });
    const two = await measureToolSurface({
      tools: { a: weatherTool(), b: weatherTool() },
    });

    expect(two.tools).toBe(2);
    expect(two.bytes).toBeGreaterThan(one.bytes);
  });

  test('a tool whose schema cannot be read still counts, and costs its name', async () => {
    const broken = tool({
      description: 'Unreadable.',
      // A schema that rejects when resolved is still a bound tool; the measure
      // is a diagnostic and must never fail the turn that takes it.
      inputSchema: jsonSchema(Promise.reject(new Error('nope'))),
      execute: async () => {
        return null;
      },
    });

    const measured = await measureToolSurface({ tools: { broken } });
    expect(measured.tools).toBe(1);
    expect(measured.bytes).toBeGreaterThan(0);
  });

  test('the ratio is the one measured against a real trace', () => {
    // 152,161 bytes of tool definitions arrived as 45,148 prompt tokens on a
    // Bedrock Anthropic turn. Pinned so a casual edit has to argue with a
    // measurement rather than a guess.
    expect(BYTES_PER_TOKEN).toBeCloseTo(152161 / 45148, 2);
  });
});
