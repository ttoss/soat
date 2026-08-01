import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The response-side twin of `rest/wireKeyContract.test.ts`.
 *
 * That test catches a handler *reading* a camelCase key off the request. This
 * one catches a lib function *emitting* one: the wire is snake_case and a lib
 * return is wire-shaped (see `.claude/rules/case-convention.md`), so a
 * camelCase key inside a returned object is a name no consumer reads. The value
 * resolves to `undefined` at every call site — silently, because
 * `project_id?: string` on the receiving parameter accepts an object that is
 * missing the field entirely and excess-property checking never fires on a
 * variable.
 *
 * `getDocumentStatus` shipped exactly that (#801). It returned `projectId`
 * while both routes that consume it read `project_id`, so the authorization
 * call named no project and the request 500'd for any unscoped API key. It
 * typechecked, and 80-odd REST tests over those routes passed, because the two
 * credential shapes the suite used never reached the branch that dereferences
 * the value.
 *
 * The rule is per-object-literal and needs no field allowlist: a literal that
 * carries at least one snake_case key is wire-shaped, and a wire-shaped literal
 * must not also carry a camelCase key. A literal that is entirely camelCase is
 * internal (lib args, a Sequelize `where`) and is not wire-shaped; a literal
 * that is entirely snake_case is fine. Only the mix is a contract break —
 * which is why a JSON Schema fragment (`additionalProperties` alongside
 * `approval_reasoning` in `agentToolApproval.ts`) does not trip it: those keys
 * live in sibling literals, not the same one.
 *
 * Static on purpose. The failure mode is a *silently undefined* read, so an
 * integration test only catches it if someone remembers to exercise that field
 * through the one credential shape that dereferences it. Reading the source
 * catches the class.
 */

const SRC_DIR = join(__dirname, '../../../../src');

const SCAN_DIRS = ['lib', 'rest/v1'];

const isCamelCase = (key: string): boolean => {
  return /^[a-z][A-Za-z0-9]*$/.test(key) && /[a-z][A-Z]/.test(key);
};

const isSnakeCase = (key: string): boolean => {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(key);
};

const collectSourceFiles = (dir: string): string[] => {
  const files: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);

    if (statSync(full).isDirectory()) {
      files.push(...collectSourceFiles(full));
      continue;
    }

    if (entry.endsWith('.ts')) files.push(full);
  }

  return files;
};

/**
 * Blanks out comments, string bodies and template placeholders, keeping the
 * character count (and therefore every line number) intact. Braces inside a
 * description string or a `${...}` interpolation would otherwise unbalance the
 * literal walker below.
 */
const blankNonCode = (source: string): string => {
  const out = source.split('');
  let i = 0;

  const blankUntil = (end: number) => {
    for (let j = i; j < end && j < out.length; j++) {
      if (out[j] !== '\n') out[j] = ' ';
    }
    i = end;
  };

  while (i < source.length) {
    const two = source.slice(i, i + 2);

    if (two === '//') {
      const nl = source.indexOf('\n', i);
      blankUntil(nl === -1 ? source.length : nl);
      continue;
    }

    if (two === '/*') {
      const close = source.indexOf('*/', i + 2);
      blankUntil(close === -1 ? source.length : close + 2);
      continue;
    }

    const char = source[i];

    if (char === "'" || char === '"' || char === '`') {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === char) break;
        j++;
      }
      blankUntil(Math.min(j + 1, source.length));
      continue;
    }

    i++;
  }

  return out.join('');
};

/** Byte offsets at which a returned object literal starts (`{`). */
const returnedLiteralStarts = (code: string): number[] => {
  const starts: number[] = [];
  const opener = /(?:\breturn\s*|=>\s*\(\s*)\{/g;

  let match: RegExpExecArray | null;

  while ((match = opener.exec(code)) !== null) {
    starts.push(code.indexOf('{', match.index));
  }

  return starts;
};

type Violation = { keys: string[]; line: number };

/**
 * Walks one returned literal and every literal nested inside it, collecting the
 * direct keys of each. Reports a literal whose direct keys mix snake_case and
 * camelCase.
 */
const scanLiteral = (code: string, start: number): Violation[] => {
  const violations: Violation[] = [];
  const stack: { keys: string[]; start: number }[] = [];
  // A property name only counts when it sits directly after the literal's `{`
  // or a separating `,` at that same depth — never inside a value.
  const propertyHead = /^[\s]*([A-Za-z_$][\w$]*)\s*:/;

  const recordKeyAfter = (index: number) => {
    const frame = stack[stack.length - 1];
    if (!frame) return;
    const match = propertyHead.exec(code.slice(index + 1));
    if (match) frame.keys.push(match[1]);
  };

  for (let i = start; i < code.length; i++) {
    const char = code[i];

    if (char === '{') {
      // Push first: the property that follows a `{` belongs to the literal that
      // `{` opens, not to the enclosing one.
      stack.push({ keys: [], start: i });
      recordKeyAfter(i);
      continue;
    }

    if (char === ',') {
      recordKeyAfter(i);
      continue;
    }

    if (char === '}') {
      const frame = stack.pop();

      if (frame) {
        const camel = frame.keys.filter(isCamelCase);
        const snake = frame.keys.filter(isSnakeCase);

        if (camel.length > 0 && snake.length > 0) {
          violations.push({
            keys: camel,
            line: code.slice(0, frame.start).split('\n').length,
          });
        }
      }

      if (stack.length === 0) break;
    }
  }

  return violations;
};

describe('lib returns are wire-shaped (snake_case only)', () => {
  const files = SCAN_DIRS.flatMap((dir) => {
    return collectSourceFiles(join(SRC_DIR, dir));
  });

  test('the scan reaches the lib and v1 handler trees', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  test.each(
    files.map((f) => {
      return [f.slice(SRC_DIR.length + 1), f];
    })
  )('%s returns no camelCase key in a snake_case object', (relative, full) => {
    const code = blankNonCode(readFileSync(full, 'utf8'));

    const violations = returnedLiteralStarts(code).flatMap((start) => {
      return scanLiteral(code, start);
    });

    expect(
      violations.map((v) => {
        return `${relative}:${v.line} returns \`${v.keys.join('`, `')}\` alongside snake_case keys — no consumer reads that key`;
      })
    ).toEqual([]);
  });
});
