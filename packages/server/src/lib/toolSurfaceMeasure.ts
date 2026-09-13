/**
 * What a turn's tool definitions cost to send.
 *
 * The one thing about a generation's prompt that no provider reports and no
 * caller can derive: usage comes back as totals, and the tool block is a
 * constant inside them, identical on every step of a turn, so it cannot be
 * recovered by differencing steps either. Measured here because this is the
 * only place that holds the resolved surface before it is serialized.
 *
 * A diagnostic, never a meter: the figure is an estimate, it is never priced,
 * and nothing here may fail the turn it measures.
 */
import { asSchema, type Tool } from 'ai';
import createDebug from 'debug';

const log = createDebug('soat:generation');

/**
 * Bytes per token, measured rather than assumed: 152,161 bytes of tool
 * definitions arrived as 45,148 prompt tokens on a Bedrock Anthropic turn.
 *
 * One ratio, not one per provider. A second provider's ratio would have to be
 * invented, and an invented number reported to three significant figures is
 * worse than one honest one — the figure exists to answer "is this surface
 * large", which it does at this precision for every tokenizer in use.
 */
export const BYTES_PER_TOKEN = 152161 / 45148;

export type ToolSurface = {
  tools: number;
  bytes: number;
  estimated_tokens: number;
};

/**
 * The canonical form, not the provider's wire form: each provider wraps tool
 * definitions differently (Bedrock Converse nests them under `toolSpec`), so
 * exact per-provider bytes would mean reimplementing the AI SDK's conversion.
 * Measuring one shape is what makes two agents' surfaces comparable, which is
 * the question the figure is for.
 */
const describeTool = async (
  name: string,
  boundTool: Tool
): Promise<Record<string, unknown>> => {
  return {
    name,
    description: boundTool.description,
    inputSchema: await asSchema(boundTool.inputSchema).jsonSchema,
  };
};

export const measureToolSurface = async (args: {
  tools: Record<string, Tool>;
}): Promise<ToolSurface> => {
  const entries = Object.entries(args.tools);
  if (entries.length === 0) {
    return { tools: 0, bytes: 0, estimated_tokens: 0 };
  }

  const described = await Promise.all(
    entries.map(async ([name, boundTool]) => {
      try {
        return await describeTool(name, boundTool);
      } catch (error) {
        // A schema that will not resolve is still a bound tool the provider is
        // told about, so it keeps its place in the count and its name in the
        // bytes rather than vanishing from the measurement.
        log(
          'measureToolSurface: unreadable schema tool=%s error=%s',
          name,
          error instanceof Error ? error.message : String(error)
        );
        return { name, description: boundTool.description };
      }
    })
  );

  const bytes = Buffer.byteLength(JSON.stringify(described), 'utf8');
  return {
    tools: entries.length,
    bytes,
    estimated_tokens: Math.round(bytes / BYTES_PER_TOKEN),
  };
};
