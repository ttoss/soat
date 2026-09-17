import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

import { ESLint } from 'eslint';

import { MAX_LINES_EXEMPT, MODULE_CEILING } from '../../eslint.config.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The module ceiling is only a ceiling if the way over it is countable. The
 * exemptions are one list in `eslint.config.js`, and these hold that list to
 * "only shrinks": nothing joins it quietly, nothing stays on it once the file
 * fits, and no file can exempt itself past it.
 */
describe('module ceiling', () => {
  /**
   * The size of the list when it was written down. **Lower it as files shrink;
   * never raise it.** A change that needs it raised is a module that should
   * have been split.
   */
  const EXEMPT_BUDGET = 8;

  /** The files ESLint reports over the ceiling with the exemption lifted. */
  const overTheCeiling = async (files) => {
    const eslint = new ESLint({
      cwd: repoRoot,
      overrideConfig: {
        files,
        rules: {
          'max-lines': [
            'error',
            { max: MODULE_CEILING, skipBlankLines: true, skipComments: true },
          ],
        },
      },
    });
    const results = await eslint.lintFiles(files);
    return results
      .filter((result) => {
        return result.messages.some((message) => {
          return message.ruleId === 'max-lines';
        });
      })
      .map((result) => {
        return path.relative(repoRoot, result.filePath);
      });
  };

  test('every exempt file still exists', () => {
    const missing = MAX_LINES_EXEMPT.filter((file) => {
      return !fs.existsSync(path.join(repoRoot, file));
    });

    assert.deepEqual(missing, []);
  });

  test('the list is sorted and free of duplicates', () => {
    assert.deepEqual(MAX_LINES_EXEMPT, [...new Set(MAX_LINES_EXEMPT)].sort());
  });

  test('the list is no longer than its budget', () => {
    assert.ok(
      MAX_LINES_EXEMPT.length <= EXEMPT_BUDGET,
      `${MAX_LINES_EXEMPT.length} files are exempt from the ${MODULE_CEILING}-line ceiling, over the budget of ${EXEMPT_BUDGET}. Split the module instead of listing it.`
    );
  });

  test('every exempt file is genuinely over the ceiling', async () => {
    const stillOver = await overTheCeiling(MAX_LINES_EXEMPT);
    const fitsNow = MAX_LINES_EXEMPT.filter((file) => {
      return !stillOver.includes(file);
    });

    assert.deepEqual(
      fitsNow,
      [],
      `these files now fit under the ${MODULE_CEILING}-line ceiling; drop them from MAX_LINES_EXEMPT: ${fitsNow.join(', ')}`
    );
  });

  test('no file exempts itself with an inline disable', () => {
    const tracked = execFileSync('git', ['ls-files', '-z', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    })
      .split('\0')
      .filter(Boolean);

    // Only a real directive counts: the comment has to *open* with
    // `eslint-disable`, and the rule has to be `max-lines` itself rather than
    // `max-lines-per-function`. Prose naming the rule is not an exemption.
    const directive =
      /(?:\/\*|\/\/)\s*eslint-disable(?:-next-line|-line)?\s+([^\n]*?)(?:\*\/|$)/gm;

    const selfExempt = tracked.filter((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
      return [...source.matchAll(directive)].some(([, rules]) => {
        return rules.split(',').some((rule) => {
          return rule.trim() === 'max-lines';
        });
      });
    });

    assert.deepEqual(
      selfExempt,
      [],
      `max-lines is exempted in eslint.config.js and nowhere else; these files disable it inline: ${selfExempt.join(', ')}`
    );
  });
});
