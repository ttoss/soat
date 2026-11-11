import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const routesDir = fileURLToPath(
  new URL('../../packages/server/src/rest/v1/', import.meta.url)
);

/**
 * Collection routes that resolve no project scope, each with why. Every other
 * `GET` on a path naming no resource goes through `resolveListScope`
 * (`rest/v1/listScope.ts`).
 */
const NOT_PROJECT_SCOPED = {
  'apiKeys.ts /api-keys': 'owner-scoped: a user administers their own keys',
  'memories.ts /memories': 'scoped by the memory store `?memory_store_id` names',
  'oauth.ts /oauth/consent-info': 'consent screen, not a list',
  'oauthConnections.ts /oauth-connections/callback': 'OAuth redirect target',
  'openapi.ts /openapi.json': 'the spec',
  'policies.ts /policies':
    'global resource: `?project_id` is part of its admin gate',
  'projects.ts /projects': 'the projects themselves',
  'triggers.ts /trigger-firings': 'scoped by the trigger `?trigger_id` names',
  'usage.ts /usage/prices': 'global price book',
  'users.ts /users': 'global resource',
  'users.ts /users/me': 'the caller',
  'webhooks.ts /webhook-deliveries': 'scoped by the webhook `?webhook_id` names',
};

const ROUTE = /\.get\(\s*'(\/[^':]*)'/g;
const HANDLER_END = /^\)?\}?\);$/;
const LOCAL_HELPER = /^const (\w+) = async\b/gm;

const BYPASSES = [
  /\bctx\.query(?:\.project_id\b|\[\s*'project_id'\s*\])/,
  /\bproject_id:\s*\w+[^}]*\}\s*=\s*ctx\.query\b/,
  /\b(?:resolveReadProjectIds|requireProjectAccess)\(/,
  /project_id (?:query parameter )?is required/,
];

const stripComments = (source) => {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
};

const blockFrom = (lines, startLine) => {
  const endLine = lines.findIndex((line, index) => {
    return index > startLine && /^\S/.test(line) && HANDLER_END.test(line);
  });
  return lines
    .slice(startLine, endLine === -1 ? lines.length : endLine + 1)
    .join('\n');
};

const lineOf = (source, index) => {
  return source.slice(0, index).split('\n').length - 1;
};

const listRoutes = () => {
  return fs
    .readdirSync(routesDir)
    .filter((file) => {
      return file.endsWith('.ts') && file !== 'listScope.ts';
    })
    .flatMap((file) => {
      const source = stripComments(
        fs.readFileSync(path.join(routesDir, file), 'utf-8')
      );
      const lines = source.split('\n');
      const helpers = [...source.matchAll(LOCAL_HELPER)]
        .filter((match) => {
          return blockFrom(lines, lineOf(source, match.index)).includes(
            'resolveListScope('
          );
        })
        .map((match) => {
          return match[1];
        });
      return [...source.matchAll(ROUTE)].map((match) => {
        return {
          key: `${file} ${match[1]}`,
          path: match[1],
          body: blockFrom(lines, lineOf(source, match.index)),
          helpers,
        };
      });
    });
};

const scoped = () => {
  return listRoutes().filter((route) => {
    return !(route.key in NOT_PROJECT_SCOPED);
  });
};

test('every list route resolves its project scope through resolveListScope', () => {
  const offenders = scoped()
    .filter((route) => {
      return ![
        'resolveListScope(',
        ...route.helpers.map((name) => {
          return `${name}(`;
        }),
      ].some((call) => {
        return route.body.includes(call);
      });
    })
    .map((route) => {
      return route.key;
    });

  assert.deepEqual(offenders, []);
});

test('no list route reads project_id or resolves its scope itself', () => {
  const offenders = scoped()
    .filter((route) => {
      return BYPASSES.some((pattern) => {
        return pattern.test(route.body);
      });
    })
    .map((route) => {
      return route.key;
    });

  assert.deepEqual(offenders, []);
});

test('exports require project_id through the chokepoint', () => {
  const offenders = scoped()
    .filter((route) => {
      return (
        route.path.endsWith('/export') &&
        !/projectSelector:\s*'required'/.test(route.body)
      );
    })
    .map((route) => {
      return route.key;
    });

  assert.deepEqual(offenders, []);
});

test('every exemption names a registered route', () => {
  const keys = new Set(
    listRoutes().map((route) => {
      return route.key;
    })
  );
  const stale = Object.keys(NOT_PROJECT_SCOPED).filter((key) => {
    return !keys.has(key);
  });

  assert.deepEqual(stale, []);
});
