/* eslint-disable no-console */
import input from '@inquirer/input';
import password from '@inquirer/password';
import * as sdk from '@soat/sdk';
import { program } from 'commander';

import pkg from '../package.json' with { type: 'json' };
import { resolveClient, writeProfile } from './config.js';
import { routes } from './generated/routes.js';

/** Convert kebab-case flag name to camelCase key (e.g. actor-id → actorId). */
const kebabToCamel = (s: string) => {
  return s.replace(/-([a-z])/g, (_, c: string) => {
    return c.toUpperCase();
  });
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
      console.log(`  ${cmd.padEnd(pad)}  ${r.serviceClass}.${r.operationId}`);
    }
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
      const camel = kebabToCamel(flagKey);
      const parsedValue = parseFlagValue(val);
      if (route.pathParams.includes(flagKey)) {
        pathArgs[camel] = parsedValue;
      } else if (route.queryParams.includes(flagKey)) {
        queryArgs[camel] = parsedValue;
      } else {
        bodyArgs[camel] = parsedValue;
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
