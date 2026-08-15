import * as fs from 'node:fs';

import { load } from 'js-yaml';

import type { Wrapper } from '../types.js';

const FORMATION_COMMANDS = [
  'validate-formation',
  'plan-formation',
  'create-formation',
  'update-formation',
];

/**
 * The two commands that *deploy*. `validate-formation` and `plan-formation`
 * report on a template without touching a resource, so their outcome is the
 * payload, not an exit code.
 */
const DEPLOY_COMMANDS = ['create-formation', 'update-formation'];

const TEMPLATE_PATH_FLAG = 'template-path';
const TEMPLATE_FILE_FLAG = 'template-file';
const ENV_FILE_FLAG = 'env-file';
const PARAMETER_FLAG = 'parameter';
const TEMPLATE_FIELD = 'template';
const PARAMETERS_FIELD = 'parameters';

// eslint-disable-next-line complexity
const parseEnvFile = (args: { envPath: string }): Record<string, string> => {
  const { envPath } = args;

  let content: string;
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    throw new Error(`Unable to read env file: ${envPath}`);
  }

  const vars: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ')
      ? line.slice('export '.length).trim()
      : line;
    const eqIdx = withoutExport.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = withoutExport.slice(0, eqIdx).trim();
    let value = withoutExport.slice(eqIdx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    vars[key] = value;
  }

  return vars;
};

const readTemplateFromPath = (args: { templatePath: string }): unknown => {
  const { templatePath } = args;

  let content: string;
  try {
    content = fs.readFileSync(templatePath, 'utf8');
  } catch {
    throw new Error(`Unable to read template file: ${templatePath}`);
  }

  const trimmed = content.trim();
  if (!trimmed) {
    throw new Error(`Template file is empty: ${templatePath}`);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    // Fall through to YAML parsing.
  }

  try {
    return load(trimmed);
  } catch {
    throw new Error(
      `Template file must contain valid JSON or YAML: ${templatePath}`
    );
  }
};

// Sentinel returned when a `@VAR` / bare-KEY reference has no env value.
// The parameter is then omitted from the request body entirely, so the
// server falls back to its own resolution: reuse a formation's previous
// value when the parameter declares `use_previous_value`, or error if no
// previous value exists (see formationsHelpers.ts `paramHasValue`).
const OMIT_PARAMETER = Symbol('omit-parameter');

const resolveEnvRef = (args: {
  value: string;
  env: Record<string, string | undefined>;
}): string | typeof OMIT_PARAMETER => {
  const { value, env } = args;

  // @ENV_VAR_NAME — shell-safe reference; the shell does not expand @ prefixes.
  // A missing var is not an error here: the whole point of `@VAR` is to
  // reference a formation parameter's value by name, and an unset var means
  // "use whatever the server resolves" (previous value, or its own error).
  const atRef = /^@([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (atRef) {
    const resolved = env[atRef[1]];
    return resolved === undefined ? OMIT_PARAMETER : resolved;
  }

  const simple = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
  if (simple) {
    const resolved = env[simple[1]];
    if (resolved === undefined) {
      throw new Error(`Missing environment variable: ${simple[1]}`);
    }
    return resolved;
  }

  const bracketed = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value);
  if (bracketed) {
    const resolved = env[bracketed[1]];
    if (resolved === undefined) {
      throw new Error(`Missing environment variable: ${bracketed[1]}`);
    }
    return resolved;
  }

  return value;
};

const resolveParameterPair = (args: {
  pair: string;
  env: Record<string, string | undefined>;
}): { key: string; value: string | typeof OMIT_PARAMETER } => {
  const { pair, env } = args;
  const eqIdx = pair.indexOf('=');

  if (eqIdx === 0) {
    throw new Error(
      `Invalid --${PARAMETER_FLAG} value "${pair}". Parameter key cannot be empty.`
    );
  }

  if (eqIdx === -1) {
    // No '=' — use the token itself as the env var name to look up. Same
    // "omit, let the server decide" behavior as `@VAR` when unset.
    const key = pair.trim();
    if (!key) {
      throw new Error(
        `Invalid --${PARAMETER_FLAG} value "${pair}". Parameter key cannot be empty.`
      );
    }
    const resolved = env[key];
    return { key, value: resolved === undefined ? OMIT_PARAMETER : resolved };
  }

  const key = pair.slice(0, eqIdx).trim();
  const rawValue = pair.slice(eqIdx + 1);

  if (!key) {
    throw new Error(
      `Invalid --${PARAMETER_FLAG} value "${pair}". Parameter key cannot be empty.`
    );
  }

  return { key, value: resolveEnvRef({ value: rawValue, env }) };
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const readString = (value: unknown): string | undefined => {
  return typeof value === 'string' && value ? value : undefined;
};

/** The reason line, from the response's `error` bag when it carries one. */
const describeDeployReason = (args: {
  error: Record<string, unknown> | undefined;
  formationId: string | undefined;
}): string => {
  const reason = readString(args.error?.message);
  if (!reason) {
    return `No reason was reported on the response; run \`soat list-formation-events --formation-id ${args.formationId ?? '<id>'}\` for the operation history.`;
  }

  return `${readString(args.error?.code) ?? 'UNKNOWN'}: ${reason}`;
};

/**
 * A deploy whose reconciliation failed, rendered for stderr.
 *
 * The server answers 2xx here on purpose — the operation ran, and partial
 * failure is modelled on the resource — so the body's `status` is the only
 * signal that anything went wrong. Turning it into a non-zero exit is what
 * stops `&&` chains from reporting a deploy that deployed nothing (#1028).
 */
const describeFailedDeploy = (args: {
  commandName: string;
  data: unknown;
}): string | null => {
  const { commandName, data } = args;

  if (!DEPLOY_COMMANDS.includes(commandName)) return null;
  if (!isRecord(data) || data.status !== 'failed') return null;

  const error = isRecord(data.error) ? data.error : undefined;
  const meta = isRecord(error?.meta) ? error.meta : undefined;
  const logicalId = readString(meta?.logical_id);
  const at = logicalId ? ` at resource '${logicalId}'` : '';
  const detail = describeDeployReason({
    error,
    formationId: readString(data.id),
  });

  return `${commandName}: the deploy failed${at} — the formation is 'failed'. ${detail}`;
};

export const formationsWrapper: Wrapper = {
  id: 'formations-wrapper',
  commands: FORMATION_COMMANDS,
  failureMessage: describeFailedDeploy,
  helpFlags: [
    {
      name: 'template-path',
      description:
        'Path to template file (JSON or YAML). Alias: --template-file',
      required: false,
      type: 'string',
    },
    {
      name: 'parameter',
      description:
        'Template parameter in key=value format (repeatable). Values support env var references: $VAR, ${VAR}, or @VAR_NAME (shell-safe). Omit the value entirely (--parameter KEY) to auto-read KEY from the merged env. For @VAR_NAME and bare KEY, an unset env var omits the parameter instead of failing, so the server reuses a previous value (formation parameters declared `use_previous_value`) or errors if none exists.',
      required: false,
      type: 'string',
    },
    {
      name: 'env-file',
      description: 'Path to .env file for parameter variable substitution',
      required: false,
      type: 'string',
    },
  ],
  // eslint-disable-next-line complexity
  apply: ({ context }) => {
    const forcedBody: Record<string, unknown> = {};
    const flags = {
      single: { ...context.parsedFlags.single },
      repeated: { ...context.parsedFlags.repeated },
    };

    const templatePath = flags.single[TEMPLATE_PATH_FLAG];
    const templateFile = flags.single[TEMPLATE_FILE_FLAG];
    const templateInline = flags.single[TEMPLATE_FIELD];
    const parametersInline = flags.single[PARAMETERS_FIELD];
    const parameterValues = flags.repeated[PARAMETER_FLAG] ?? [];
    const envFile = flags.single[ENV_FILE_FLAG];

    if (templatePath && templateFile) {
      throw new Error(
        `Use either --${TEMPLATE_PATH_FLAG} or --${TEMPLATE_FILE_FLAG}, not both.`
      );
    }

    const effectiveTemplatePath = templatePath ?? templateFile;

    if (templateInline && effectiveTemplatePath) {
      throw new Error(
        `Use either --${TEMPLATE_FIELD} or --${TEMPLATE_PATH_FLAG}, not both.`
      );
    }

    if (parametersInline && parameterValues.length > 0) {
      throw new Error(
        `Use either --${PARAMETERS_FIELD} or repeatable --${PARAMETER_FLAG}, not both.`
      );
    }

    let envFileVars: Record<string, string> = {};
    if (envFile) {
      envFileVars = parseEnvFile({ envPath: envFile });
    }

    const mergedEnv: Record<string, string | undefined> = {
      ...envFileVars,
      ...process.env,
    };

    if (effectiveTemplatePath) {
      forcedBody[TEMPLATE_FIELD] = readTemplateFromPath({
        templatePath: effectiveTemplatePath,
      });
    }

    if (parameterValues.length > 0) {
      const resolvedParameters: Record<string, string> = {};

      for (const pair of parameterValues) {
        const { key, value } = resolveParameterPair({ pair, env: mergedEnv });
        if (value !== OMIT_PARAMETER) {
          resolvedParameters[key] = value;
        }
      }

      forcedBody[PARAMETERS_FIELD] = resolvedParameters;
    }

    delete flags.single[TEMPLATE_PATH_FLAG];
    delete flags.single[TEMPLATE_FILE_FLAG];
    delete flags.single[ENV_FILE_FLAG];
    delete flags.single[PARAMETER_FLAG];
    delete flags.repeated[PARAMETER_FLAG];

    return {
      flags,
      forcedBody,
    };
  },
};
