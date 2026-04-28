/* eslint-disable no-console */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import input from '@inquirer/input';
import password from '@inquirer/password';
import * as sdk from '@soat/sdk';
import { program } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import { resolveClient, writeProfile } from './config.js';
import { routes } from './generated/routes.js';

/**
 * Normalize kebab-case, snake_case, or camelCase to camelCase for param matching.
 * e.g. agent-id → agentId, actor_id → actorId, agentId → agentId
 */
const toCanonical = (s: string) => {
  return s.replace(/[-_]([a-z0-9])/g, (_, c: string) => {
    return c.toUpperCase();
  });
};

/** Convert kebab-case to snake_case for body/query keys (e.g. project-id → project_id). */
const kebabToSnake = (s: string) => {
  return s.replace(/-/g, '_');
};

/** Parse unknown args like --foo bar --baz 1 into a flat Record. */
const parseUnknown = (args: string[]): Record<string, string> => {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const val = args[i + 1];
      if (val !== undefined && !val.startsWith('--')) {
        result[key] = val;
        i++;
      } else {
        result[key] = 'true';
      }
    }
  }
  return result;
};

const parseFlagValue = (value: string): unknown => {
  const trimmed = value.trim();

  if (
    trimmed.startsWith('{') ||
    trimmed.startsWith('[') ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    trimmed === 'null' ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
};

/** Normalize symbol names to compare exports across acronym casing differences. */
const normalizeSymbol = (name: string) => {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
};

/** Resolve SDK service exports even when generated names differ by acronym casing. */
const resolveServiceClass = (serviceClassName: string) => {
  const sdkExports = sdk as Record<string, unknown>;

  const exactMatch = sdkExports[serviceClassName];
  if (exactMatch) return exactMatch;

  const normalizedTarget = normalizeSymbol(serviceClassName);

  const fuzzyMatches = Object.entries(sdkExports).filter(
    ([exportName, value]) => {
      return Boolean(value) && normalizeSymbol(exportName) === normalizedTarget;
    }
  );

  if (fuzzyMatches.length === 1) {
    return fuzzyMatches[0][1];
  }

  return undefined;
};

program
  .name('soat')
  .description('SOAT CLI')
  .version(pkg.version)
  .option('-p, --profile <name>', 'config profile to use');

// ── configure ────────────────────────────────────────────────────────────────

program
  .command('configure')
  .description('Save credentials to a named profile (~/.soat/config.json)')
  .option('-p, --profile <name>', 'profile name', 'default')
  .action(async (opts) => {
    const baseUrl = await input({
      message: 'Base URL:',
    });
    const token = await password({ message: 'Token (hidden):' });
    writeProfile(opts.profile, { baseUrl, token });

    console.log(`Profile "${opts.profile}" saved.`);
  });

// ── list-commands ─────────────────────────────────────────────────────────────

program
  .command('list-commands')
  .description('List all available API commands')
  .action(() => {
    const pad = Math.max(
      ...Object.keys(routes).map((k) => {
        return k.length;
      })
    );
    for (const [cmd, r] of Object.entries(routes).sort()) {
      console.log(`  ${cmd.padEnd(pad)}  ${r.description}`);
    }
  });

const matchesFilter = (eventType: string, filter: string) => {
  const patterns = filter
    .split(',')
    .map((part) => {
      return part.trim();
    })
    .filter(Boolean);

  if (patterns.length === 0) return true;

  return patterns.some((pattern) => {
    if (pattern === '*') return true;
    if (pattern.endsWith('*')) {
      return eventType.startsWith(pattern.slice(0, -1));
    }
    return eventType === pattern;
  });
};

const verifySignature = (
  secret: string,
  payload: string,
  signatureHeader: string
) => {
  const expected = createHmac('sha256', secret).update(payload).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const actualBuffer = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuffer.length !== actualBuffer.length) return false;

  return timingSafeEqual(expectedBuffer, actualBuffer);
};

// ── listen ──────────────────────────────────────────────────────────────────

program
  .command('listen')
  .description('Start a local webhook listener for testing deliveries')
  .option('--port <number>', 'port to listen on', '8787')
  .option('--path <path>', 'request path to accept', '/webhook')
  .option(
    '--secret <secret>',
    'verify X-Soat-Signature with this webhook secret'
  )
  .option(
    '--filter <pattern>',
    'filter event type(s), supports prefix wildcard and comma separation (e.g. sessions.generation.*,files.*)'
  )
  .option('--json', 'print one JSON object per line')
  // eslint-disable-next-line max-lines-per-function
  .action((opts) => {
    const port = Number(opts.port);
    const path = opts.path as string;
    const secret = opts.secret as string | undefined;
    const filter = opts.filter as string | undefined;
    const asJson = Boolean(opts.json);

    if (!Number.isInteger(port) || port <= 0) {
      console.error('Invalid port. Use a positive integer.');
      process.exit(1);
    }

    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== path) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }

      const chunks: Buffer[] = [];

      req.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      // eslint-disable-next-line complexity
      req.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const eventType = String(req.headers['x-soat-event'] ?? 'unknown');
        const deliveryId = String(req.headers['x-soat-delivery'] ?? 'unknown');
        const signature = String(req.headers['x-soat-signature'] ?? '');

        if (filter && !matchesFilter(eventType, filter)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, skipped: true }));
          return;
        }

        let parsedPayload: unknown = rawBody;
        try {
          parsedPayload = JSON.parse(rawBody);
        } catch {
          // Keep raw body when payload is not valid JSON.
        }

        let isSignatureValid: boolean | null = null;
        if (secret) {
          isSignatureValid = verifySignature(secret, rawBody, signature);
        }

        const record = {
          timestamp: new Date().toISOString(),
          event_type: eventType,
          delivery_id: deliveryId,
          signature,
          signature_valid: isSignatureValid,
          payload: parsedPayload,
        };

        if (asJson) {
          console.log(JSON.stringify(record));
        } else {
          console.log('--- webhook received ---');
          console.log('event_type:', eventType);
          console.log('delivery_id:', deliveryId);
          if (secret) {
            console.log('signature_valid:', isSignatureValid);
          }
          console.log('payload:', JSON.stringify(parsedPayload, null, 2));
        }

        const responseStatus = secret && isSignatureValid === false ? 401 : 200;
        res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: responseStatus === 200,
            event_type: eventType,
            delivery_id: deliveryId,
            signature_valid: isSignatureValid,
          })
        );
      });
    });

    server.listen(port, () => {
      console.log(
        `Listening for SOAT webhooks on http://localhost:${port}${path}`
      );
      if (filter) {
        console.log(`Filter: ${filter}`);
      }
      if (secret) {
        console.log('Signature verification: enabled');
      }
    });

    process.on('SIGINT', () => {
      server.close(() => {
        process.exit(0);
      });
    });
  });

// ── dynamic dispatch ──────────────────────────────────────────────────────────

program
  .argument('[command]', 'API command in kebab-case (e.g. list-actors)')
  .argument('[args...]')
  .allowUnknownOption()
  // eslint-disable-next-line complexity
  .action(async (commandName) => {
    if (!commandName) {
      program.help();
      return;
    }

    const route = routes[commandName];
    if (!route) {
      console.error(`Unknown command: ${commandName}`);
      console.error(`Run "soat list-commands" to see all available commands.`);
      process.exit(1);
    }

    // Collect flags from everything after the command name
    const rawIdx = process.argv.indexOf(commandName);
    const rawArgs = rawIdx >= 0 ? process.argv.slice(rawIdx + 1) : [];
    const flags = parseUnknown(rawArgs);

    // Split flags into path / query / body
    const pathArgs: Record<string, unknown> = {};
    const queryArgs: Record<string, unknown> = {};
    const bodyArgs: Record<string, unknown> = {};

    for (const [flagKey, val] of Object.entries(flags)) {
      if (flagKey === 'profile') continue;
      const canonical = toCanonical(flagKey);
      const parsedValue = parseFlagValue(val);
      const pathParam = route.pathParams.find((p) => {
        return toCanonical(p) === canonical;
      });
      const queryParam = route.queryParams.find((p) => {
        return toCanonical(p) === canonical;
      });

      if (pathParam) {
        pathArgs[pathParam] = parsedValue;
      } else if (queryParam) {
        queryArgs[queryParam] = parsedValue;
      } else {
        bodyArgs[kebabToSnake(flagKey)] = parsedValue;
      }
    }

    const profileOpt =
      flags['profile'] ?? program.opts<{ profile?: string }>().profile;
    const client = resolveClient(profileOpt);

    const serviceClass = resolveServiceClass(route.serviceClass);
    if (!serviceClass) {
      console.error(`SDK class "${route.serviceClass}" not found.`);
      process.exit(1);
    }

    const method = (serviceClass as Record<string, unknown>)[route.operationId];
    if (typeof method !== 'function') {
      console.error(
        `Method "${route.operationId}" not found on ${route.serviceClass}.`
      );
      process.exit(1);
    }

    const callOpts: Record<string, unknown> = { client };
    if (Object.keys(pathArgs).length) callOpts['path'] = pathArgs;
    if (Object.keys(queryArgs).length) callOpts['query'] = queryArgs;
    if (Object.keys(bodyArgs).length) callOpts['body'] = bodyArgs;

    const result = await method(callOpts);

    if (result.error) {
      const status =
        result.response && 'status' in result.response
          ? result.response.status
          : undefined;
      console.error(
        JSON.stringify(
          {
            status,
            error: result.error,
          },
          null,
          2
        )
      );
      process.exit(1);
    }

    console.log(JSON.stringify(result.data, null, 2));
  });

program.parse();
