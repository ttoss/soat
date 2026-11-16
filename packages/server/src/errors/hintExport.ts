import { ERROR_CODES, type ErrorCode } from './codes';
import { type HintRoute, hintRoutes, renderHint } from './hintRoutes';
import { ERROR_RESOLUTIONS, STATUS_RESOLUTIONS } from './resolutions';

/**
 * Where `pnpm generate-error-hints` writes the export, beside the specs a
 * deployment pins (`tests/unit/tests/lib/errorResolutions.test.ts` fails on
 * drift).
 */
export const ERROR_HINTS_EXPORT_PATH = 'src/rest/openapi/error-hints.json';

const EXPORT_ROUTE_PREFIX = '/api/v1';

type ExportedHint = { hint: string; routes: HintRoute[] };

const exported = (template: string): ExportedHint => {
  return {
    hint: renderHint({ template, prefix: EXPORT_ROUTE_PREFIX }),
    routes: hintRoutes({ template }),
  };
};

/**
 * The runtime's own hint per code and per status fallback, without a
 * deployment's overrides. `routes` lists what each hint names, relative to
 * `route_prefix`, so a deployment can check them against the routes it serves.
 */
export const buildErrorHintsExport = () => {
  const codes = (Object.keys(ERROR_CODES) as ErrorCode[]).sort();
  return {
    route_prefix: EXPORT_ROUTE_PREFIX,
    codes: Object.fromEntries(
      codes.map((code) => {
        const status = ERROR_CODES[code].httpStatus;
        const template = ERROR_RESOLUTIONS[code] ?? STATUS_RESOLUTIONS[status];
        return [code, { http_status: status, ...exported(template) }];
      })
    ),
    status_fallbacks: Object.fromEntries(
      Object.entries(STATUS_RESOLUTIONS).map(([status, template]) => {
        return [status, exported(template)];
      })
    ),
  };
};
