// Deterministic `tool_choice` shim in front of Ollama.
//
// Ollama's OpenAI-compatible endpoint does not implement `tool_choice` and drops
// it silently, so a forcing agent gets no forcing at all in CI — whether a run
// pauses on a client tool depends on whether `qwen2.5:0.5b` volunteers one. That
// is the flake behind #774, which failed a release pipeline.
//
// This implements exactly that missing field, for the tools in
// `TOOL_CHOICE_TOOLS`, and nothing else:
//
//   * forcing an allowlisted tool → a synthesized `tool_calls` response; the
//     model is never called, so the forced call is deterministic.
//   * forcing one the request does not offer → `400`. That is a wiring break,
//     and forwarding it revives the flake downstream where it no longer looks
//     like one.
//   * everything else is forwarded to Ollama verbatim.
//
// Every request asking for forcing logs its outcome, so a downstream failure can
// be attributed without guessing. The allowlist keeps the blast radius at one
// step per suite: other flows force tools whose arguments only the model can
// fill, and those keep running against the real model.
//
// Used as OLLAMA_BASE_URL by the smoke and tutorials compose stacks.
import { createServer } from 'node:http';

const CHAT_COMPLETIONS_PATH = /\/chat\/completions$/;

const readBody = (req) => {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => {
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
};

/** The text of the last user message, whatever content shape it uses. */
const lastUserText = (messages) => {
  const userMessages = (Array.isArray(messages) ? messages : []).filter(
    (message) => {
      return message?.role === 'user';
    }
  );
  const content = userMessages.at(-1)?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        return typeof part === 'string' ? part : (part?.text ?? '');
      })
      .join(' ');
  }
  return '';
};

const stripTrailingPunctuation = (value) => {
  return value.replace(/[.,!?;:]+$/, '');
};

/**
 * Picks a plausible value for one schema property from the prompt.
 *
 * The tests assert only structure and key casing, so the value is cosmetic —
 * but a value lifted from the prompt keeps the output printed in a tutorial
 * honest (`ord_1042`, not a placeholder).
 */
const inferStringArgument = (args) => {
  const { name, description, text } = args;

  const named = text.match(
    new RegExp(`${name}\\s*(?:is|=|:)?\\s*"?([\\w.\\-/]+)"?`, 'i')
  );
  if (named?.[1]) {
    return stripTrailingPunctuation(named[1]);
  }

  const example = String(description ?? '').match(/e\.g\.\s*"?([\w.\-/]+)"?/i);
  if (example?.[1]) {
    return stripTrailingPunctuation(example[1]);
  }

  const idLike = text.match(/\b[a-z][a-z0-9]*_[A-Za-z0-9-]+\b/);
  if (idLike?.[0]) {
    return idLike[0];
  }

  const quoted = text.match(/"([^"]+)"|'([^']+)'/);
  if (quoted) {
    return quoted[1] ?? quoted[2];
  }

  return 'unknown';
};

const inferArgument = (args) => {
  const { schema, name, text } = args;
  if (Array.isArray(schema?.enum) && schema.enum.length > 0) {
    return schema.enum[0];
  }
  switch (schema?.type) {
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return inferStringArgument({
        name,
        description: schema?.description,
        text,
      });
  }
};

/** Builds arguments for every required property of the forced tool. */
const buildToolArguments = (args) => {
  const { parameters, text } = args;
  const properties = parameters?.properties ?? {};
  const required = Array.isArray(parameters?.required)
    ? parameters.required
    : Object.keys(properties);

  return Object.fromEntries(
    required
      .filter((name) => {
        return name in properties;
      })
      .map((name) => {
        return [name, inferArgument({ schema: properties[name], name, text })];
      })
  );
};

/** The tool name a `tool_choice` object names, whichever spelling it uses. */
const forcedToolName = (toolChoice) => {
  if (!toolChoice || typeof toolChoice !== 'object') {
    return undefined;
  }
  // OpenAI wire shape is {type:'function', function:{name}}; accept the
  // SOAT-facing {type:'tool', tool_name} spelling too so the shim keeps
  // working if the provider layer changes how it serializes the field.
  return (
    toolChoice.function?.name ?? toolChoice.tool_name ?? toolChoice.toolName
  );
};

/**
 * Decides what to do with one chat completion, as a tagged result:
 *
 *   {kind:'force',   tool}    — synthesize the call, never touch the model
 *   {kind:'forward'}          — send it upstream unchanged
 *   {kind:'reject',  message} — 400; the request is misconfigured
 *
 * `toolNames` is an allowlist, and it is deliberately narrow. Other CI flows
 * force tools whose arguments carry meaning only the model can supply — the
 * guardrail-gated tool in the smoke suite, the per-step `step_rules` forcing in
 * the formations tutorial (document ids, the poem text). Synthesizing those
 * would be worse than the status quo, so a tool that is not listed keeps going
 * to the real model exactly as it does today.
 *
 * The `reject` case exists because this shim's only purpose is to make a forced
 * **allowlisted** call deterministic. If such a call arrives and the tool is not
 * in `tools`, something upstream is misconfigured — and forwarding would hand
 * the outcome back to the sandbox model, reviving the #774 coin flip with no
 * trace of why. Fail closed so a wiring break reads as a wiring break instead of
 * as a flaky assertion three steps later.
 */
const resolveDecision = (args) => {
  const { body, toolNames } = args;
  const toolChoice = body?.tool_choice;
  if (!toolChoice || toolChoice === 'auto' || toolChoice === 'none') {
    return { kind: 'forward' };
  }

  const offeredTools = Array.isArray(body?.tools) ? body.tools : [];
  const allowlisted = offeredTools.filter((tool) => {
    return tool?.function?.name && toolNames.has(tool.function.name);
  });

  if (toolChoice === 'required') {
    // "required" names no tool, so it is only unambiguous when the request
    // offers exactly one — and that one has to be allowlisted. Anything else is
    // a genuine model decision, not a misconfiguration, so it forwards.
    return offeredTools.length === 1 && allowlisted.length === 1
      ? { kind: 'force', tool: allowlisted[0].function }
      : { kind: 'forward' };
  }

  const name = forcedToolName(toolChoice);
  if (!name) {
    return { kind: 'forward' };
  }

  const match = allowlisted.find((tool) => {
    return tool.function.name === name;
  });
  if (match) {
    return { kind: 'force', tool: match.function };
  }

  if (toolNames.has(name)) {
    return {
      kind: 'reject',
      message:
        `tool_choice forces "${name}", which is allowlisted for deterministic ` +
        `forcing, but the request offers no such tool (offered: ` +
        `${
          offeredTools
            .map((tool) => {
              return tool?.function?.name;
            })
            .join(', ') || 'none'
        }). ` +
        `Forwarding this to the model would make the result nondeterministic, ` +
        `so it is rejected instead.`,
    };
  }

  return { kind: 'forward' };
};

/**
 * Logs one line per request that *asked* for forcing, whatever the outcome.
 *
 * A request with no `tool_choice` (or `"auto"` / `"none"`) is the overwhelming
 * majority and says nothing, so it stays silent — but every forcing request is
 * recorded with what it asked for and what happened. Without this, a CI failure
 * three steps downstream ("the run completed instead of pausing") leaves no way
 * to tell whether forcing was requested, whether it was honored, or whether the
 * request reached this proxy at all.
 */
const logDecision = (args) => {
  const { body, decision } = args;
  const toolChoice = body?.tool_choice;
  if (!toolChoice || toolChoice === 'auto' || toolChoice === 'none') {
    return;
  }

  const asked =
    toolChoice === 'required'
      ? 'required'
      : (forcedToolName(toolChoice) ?? '?');
  const offered =
    (Array.isArray(body?.tools) ? body.tools : [])
      .map((tool) => {
        return tool?.function?.name;
      })
      .filter(Boolean)
      .join(', ') || 'none';
  const outcome =
    decision.kind === 'force'
      ? `forced ${decision.tool.name}`
      : decision.kind === 'reject'
        ? 'REJECTED (400)'
        : 'forwarded to model (not allowlisted)';

  // eslint-disable-next-line no-console
  console.log(
    `[tool-choice-proxy] tool_choice=${asked} offered=[${offered}] ` +
      `model=${body?.model} → ${outcome}`
  );
};

const randomId = (prefix) => {
  return `${prefix}${Math.random().toString(36).slice(2, 12)}`;
};

const sendJson = (res, status, payload) => {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
};

const sendForcedToolCall = (args) => {
  const { res, body, forcedTool } = args;
  const toolCall = {
    id: randomId('call_'),
    type: 'function',
    function: {
      name: forcedTool.name,
      arguments: JSON.stringify(
        buildToolArguments({
          parameters: forcedTool.parameters,
          text: lastUserText(body.messages),
        })
      ),
    },
  };
  const created = Math.floor(Date.now() / 1000);
  const id = randomId('chatcmpl-');
  const model = body.model ?? 'tool-choice-proxy';
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  if (!body.stream) {
    sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: null, tool_calls: [toolCall] },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  const chunk = (delta, finishReason) => {
    res.write(
      `data: ${JSON.stringify({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
      })}\n\n`
    );
  };
  chunk({ role: 'assistant' });
  chunk({ tool_calls: [{ index: 0, ...toolCall }] });
  chunk({}, 'tool_calls');
  res.write(
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage })}\n\n`
  );
  res.write('data: [DONE]\n\n');
  res.end();
};

const forward = async (args) => {
  const { req, res, body, upstreamBaseUrl } = args;
  const headers = { ...req.headers };
  delete headers.host;
  delete headers['content-length'];
  delete headers.connection;

  const upstream = await fetch(`${upstreamBaseUrl}${req.url}`, {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    duplex: 'half',
  });

  const responseHeaders = {};
  for (const [key, value] of upstream.headers.entries()) {
    if (key !== 'content-encoding' && key !== 'transfer-encoding') {
      responseHeaders[key] = value;
    }
  }
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) {
    res.end();
    return;
  }
  for await (const chunk of upstream.body) {
    res.write(chunk);
  }
  res.end();
};

/**
 * Creates the proxy server.
 *
 * - `upstreamBaseUrl` — the real Ollama origin, e.g. `http://ollama:11434`. The
 *   OpenAI-compatible routes live under `/v1` there, and the incoming path is
 *   preserved as-is when forwarding.
 * - `toolNames` — tools whose forcing is honored deterministically. Anything not
 *   listed goes to the model untouched, so the default (no list) is a pure
 *   pass-through proxy.
 * - `maxCompletionTokens` — optional output-token cap injected as `max_tokens`
 *   into every forwarded chat completion (a caller-set value below the cap is
 *   kept). Unset = bodies are forwarded verbatim.
 */
export const createToolChoiceProxy = (args) => {
  const { upstreamBaseUrl, maxCompletionTokens } = args;
  const toolNames = new Set(args.toolNames ?? []);

  return createServer((req, res) => {
    (async () => {
      const url = req.url ?? '/';

      if (url === '/health') {
        sendJson(res, 200, { status: 'ok' });
        return;
      }

      const rawBody = await readBody(req);

      if (
        req.method !== 'POST' ||
        !CHAT_COMPLETIONS_PATH.test(url.split('?')[0])
      ) {
        await forward({ req, res, body: rawBody, upstreamBaseUrl });
        return;
      }

      let body;
      try {
        body = JSON.parse(rawBody.toString('utf8'));
      } catch {
        await forward({ req, res, body: rawBody, upstreamBaseUrl });
        return;
      }

      const decision = resolveDecision({ body, toolNames });
      logDecision({ body, decision });

      if (decision.kind === 'reject') {
        sendJson(res, 400, {
          error: { message: `[tool-choice-proxy] ${decision.message}` },
        });
        return;
      }

      if (decision.kind === 'forward') {
        // Agents carry no max_tokens field, so nothing else bounds how many
        // tokens the model emits per completion — the dominant, and wildly
        // variable, cost of the CI suites. Cap it here, at the provider
        // boundary; a caller-set value below the cap is respected.
        if (maxCompletionTokens) {
          body.max_tokens = Math.min(
            body.max_tokens ?? maxCompletionTokens,
            maxCompletionTokens
          );
          await forward({
            req,
            res,
            body: Buffer.from(JSON.stringify(body)),
            upstreamBaseUrl,
          });
          return;
        }
        await forward({ req, res, body: rawBody, upstreamBaseUrl });
        return;
      }

      sendForcedToolCall({ res, body, forcedTool: decision.tool });
    })().catch((error) => {
      // eslint-disable-next-line no-console
      console.error('[tool-choice-proxy] error', error);
      if (!res.headersSent) {
        sendJson(res, 502, { error: { message: String(error) } });
        return;
      }
      res.end();
    });
  });
};

const isMain = process.argv[1] === new URL(import.meta.url).pathname;

if (isMain) {
  const port = Number(process.env.PORT ?? 11434);
  const upstreamBaseUrl = process.env.OLLAMA_UPSTREAM_URL;
  // Comma-separated tool names whose forcing is honored, e.g.
  // TOOL_CHOICE_TOOLS='get_order_status,get_weather'. Unset = pass-through only.
  const toolNames = (process.env.TOOL_CHOICE_TOOLS ?? '')
    .split(',')
    .map((name) => {
      return name.trim();
    })
    .filter(Boolean);
  // Output-token cap injected into every forwarded chat completion, e.g.
  // MAX_COMPLETION_TOKENS=256. Unset = no cap.
  const maxCompletionTokens =
    Number(process.env.MAX_COMPLETION_TOKENS) || undefined;
  if (!upstreamBaseUrl) {
    // eslint-disable-next-line no-console
    console.error('OLLAMA_UPSTREAM_URL is required');
    process.exit(1);
  }
  createToolChoiceProxy({
    upstreamBaseUrl,
    toolNames,
    maxCompletionTokens,
  }).listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `[tool-choice-proxy] listening on :${port} → ${upstreamBaseUrl} ` +
        `(forcing: ${toolNames.join(', ') || 'none'}; ` +
        `max_tokens cap: ${maxCompletionTokens ?? 'none'})`
    );
  });
}
