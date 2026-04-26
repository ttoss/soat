import input from '@inquirer/input';
import password from '@inquirer/password';
import { program } from 'commander';
import pkg from '../package.json' with { type: 'json' };
import { resolveClient, writeProfile } from './config.js';
import { routes } from './generated/routes.js';
import * as sdk from '@soat/sdk';

/** Convert kebab-case flag name to camelCase key (e.g. actor-id → actorId). */
const kebabToCamel = (s: string) =>
  s.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

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
    const baseUrl = await input({ message: 'Base URL:', default: 'https://api.soat.dev' });
    const token = await password({ message: 'Token (hidden):' });
    writeProfile(opts.profile, { baseUrl, token });
    console.log(`Profile "${opts.profile}" saved.`);
  });

// ── list-commands ─────────────────────────────────────────────────────────────

program
  .command('list-commands')
  .description('List all available API commands')
  .action(() => {
    const pad = Math.max(...Object.keys(routes).map((k) => k.length));
    for (const [cmd, r] of Object.entries(routes).sort()) {
      console.log(`  ${cmd.padEnd(pad)}  ${r.serviceClass}.${r.operationId}`);
    }
  });

// ── dynamic dispatch ──────────────────────────────────────────────────────────

program
  .argument('[command]', 'API command in kebab-case (e.g. list-actors)')
  .argument('[args...]')
  .allowUnknownOption()
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
    const pathArgs: Record<string, string> = {};
    const queryArgs: Record<string, string> = {};
    const bodyArgs: Record<string, string> = {};

    for (const [flagKey, val] of Object.entries(flags)) {
      if (flagKey === 'profile') continue;
      const camel = kebabToCamel(flagKey);
      if (route.pathParams.includes(flagKey)) {
        pathArgs[camel] = val;
      } else if (route.queryParams.includes(flagKey)) {
        queryArgs[camel] = val;
      } else {
        bodyArgs[camel] = val;
      }
    }

    const profileOpt = flags['profile'] ?? program.opts<{ profile?: string }>().profile;
    const client = resolveClient(profileOpt);

    const serviceClass = (sdk as Record<string, Record<string, (opts: unknown) => Promise<{ data?: unknown; error?: unknown }>>>)[route.serviceClass];
    if (!serviceClass) {
      console.error(`SDK class "${route.serviceClass}" not found.`);
      process.exit(1);
    }

    const method = serviceClass[route.operationId];
    if (typeof method !== 'function') {
      console.error(`Method "${route.operationId}" not found on ${route.serviceClass}.`);
      process.exit(1);
    }

    const callOpts: Record<string, unknown> = { client };
    if (Object.keys(pathArgs).length) callOpts['path'] = pathArgs;
    if (Object.keys(queryArgs).length) callOpts['query'] = queryArgs;
    if (Object.keys(bodyArgs).length) callOpts['body'] = bodyArgs;

    const result = await method(callOpts);

    if (result.error) {
      console.error(JSON.stringify(result.error, null, 2));
      process.exit(1);
    }

    console.log(JSON.stringify(result.data, null, 2));
  });

program.parse();
