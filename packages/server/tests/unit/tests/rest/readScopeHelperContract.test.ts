import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `resolveReadProjectIds` is the **read** preamble: `.claude/rules/errors.md`
 * documents it as "a list/read route; an empty scope is allowed and yields an
 * empty result". A route that loads one resource and checks its project must
 * use `requireProjectAccess` instead, where "an empty scope is a `403`".
 *
 * Thirteen write routes used the read helper anyway (#1029). The consequence is
 * not an authorization hole — the scoped lookup still finds nothing — but the
 * denial arrives as `404 RESOURCE_NOT_FOUND` instead of `403`, from routes whose
 * `GET` twin answers `200` for the same caller at the same instant. Worse, an
 * empty scope is not itself a denial, so the handler runs on: the lib validates
 * the body first, and an unauthorized caller can tell a well-formed body from a
 * malformed one by its `400`.
 *
 * The rule is only checkable at the call site, because both helpers return
 * `number[] | undefined` and the wrong one produces a *plausible* status — which
 * is exactly why prose lost and why the equivalent read routes never drifted.
 * So the action name is the contract: `resolveReadProjectIds` may only guard an
 * action whose verb reads.
 */

const V1_DIR = join(__dirname, '../../../../src/rest/v1');

/**
 * The helper's own module defines it and calls it from `requireProjectAccess`.
 */
const PREAMBLE_OWNER = 'helpers.ts';

/**
 * Verbs whose routes tolerate an empty scope, because "the caller may read zero
 * projects" is a correct answer for them: the filter matches nothing and the
 * response is an empty list. `Search` and `Export` are list-shaped for this
 * purpose even though one is a `POST` and the other streams NDJSON.
 */
const READ_VERBS = ['Get', 'List', 'Search', 'Export'];

const READ_ACTION = new RegExp(`^[a-z0-9-]+:(${READ_VERBS.join('|')})[A-Z]`);

/** Blanks comments while preserving offsets, so a rule quoted in a doc comment
 * is not read as an instance of it. */
const stripComments = (source: string): string => {
  return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (match) => {
    return match.replace(/[^\n]/g, ' ');
  });
};

/**
 * Every `resolveReadProjectIds(` call with the action it was given, or
 * `undefined` when the action is not a string literal at the call site — a
 * dynamic action is unresolvable statically, so it is a violation too: a shared
 * `resolve*ProjectId` wrapper taking an `action: string` is how the create
 * routes ended up on the read helper without any single site naming a write.
 */
const readHelperCalls = (
  rawSource: string
): { line: number; action?: string }[] => {
  const source = stripComments(rawSource);
  const calls = /\bresolveReadProjectIds\s*\(([\s\S]{0,400}?)\)/g;
  const found: { line: number; action?: string }[] = [];

  let match: RegExpExecArray | null;

  while ((match = calls.exec(source)) !== null) {
    const action = /\baction:\s*'([^']*)'/.exec(match[1]);
    found.push({
      line: source.slice(0, match.index).split('\n').length,
      action: action?.[1],
    });
  }

  return found;
};

describe('resolveReadProjectIds only guards read actions', () => {
  const files = readdirSync(V1_DIR).filter((f) => {
    return f.endsWith('.ts') && f !== PREAMBLE_OWNER;
  });

  test('every v1 handler file is scanned', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  test.each(files)('%s guards writes with requireProjectAccess', (file) => {
    const violations = readHelperCalls(readFileSync(join(V1_DIR, file), 'utf8'))
      .filter((call) => {
        return !call.action || !READ_ACTION.test(call.action);
      })
      .map((call) => {
        return (
          `${file}:${call.line} guards \`${call.action ?? '<non-literal action>'}\` with ` +
          `resolveReadProjectIds — an empty scope is allowed there, so an unauthorized ` +
          `caller gets 404 instead of 403. Use requireProjectAccess (loads one resource) ` +
          `or resolveWriteProjectId (needs one concrete project) from helpers.ts`
        );
      });

    expect(violations).toEqual([]);
  });

  test('the read verbs are the ones the helper documents', () => {
    expect(READ_ACTION.test('agents:ListAgents')).toBe(true);
    expect(READ_ACTION.test('audit:ExportAuditEntries')).toBe(true);
    expect(READ_ACTION.test('knowledge:SearchKnowledge')).toBe(true);
    expect(READ_ACTION.test('model-routes:GetModelRoute')).toBe(true);
    expect(READ_ACTION.test('agents:UpdateAgent')).toBe(false);
    expect(READ_ACTION.test('agents:SetAgentRelease')).toBe(false);
    expect(READ_ACTION.test('tools:CallTool')).toBe(false);
  });
});
