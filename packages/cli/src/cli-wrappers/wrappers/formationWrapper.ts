import * as fs from 'node:fs';

import yaml from 'js-yaml';

import type { Wrapper } from '../types.js';

const FORMATION_COMMANDS = [
  'validate-agent-formation',
  'plan-agent-formation',
  'create-agent-formation',
  'update-agent-formation',
];

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
    return yaml.load(trimmed);
  } catch {
    throw new Error(
      `Template file must contain valid JSON or YAML: ${templatePath}`
    );
  }
};

const resolveEnvRef = (args: {
  value: string;
  env: Record<string, string | undefined>;
}): string => {
  const { value, env } = args;

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

export const formationWrapper: Wrapper = {
  id: 'formation-wrapper',
  commands: FORMATION_COMMANDS,
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
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) {
          throw new Error(
            `Invalid --${PARAMETER_FLAG} value "${pair}". Expected key=value.`
          );
        }

        const key = pair.slice(0, eqIdx).trim();
        const rawValue = pair.slice(eqIdx + 1);

        if (!key) {
          throw new Error(
            `Invalid --${PARAMETER_FLAG} value "${pair}". Parameter key cannot be empty.`
          );
        }

        resolvedParameters[key] = resolveEnvRef({
          value: rawValue,
          env: mergedEnv,
        });
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
