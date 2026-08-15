// Tests for how tests/tutorials-tests.sh decides where one command ends.
//
// The runner accumulates lines until quotes balance, so that a multi-line
// single-quoted argument (a `jq` filter spanning two lines, say) is executed as
// one command. Deciding that requires knowing which quotes are *syntactic* —
// an apostrophe inside a double-quoted string is a literal, not an opening
// quote. Getting it wrong silently glues every following command onto the
// current one until the count happens to even out, and the failure surfaces
// several steps later as a bare `unexpected EOF` (#1046).
//
// The runner is driven against throwaway tutorial markdown files, so no server
// or LLM is involved — the commands under test are plain shell.
//
// Run: pnpm run test:harness
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';

const RUNNER = fileURLToPath(new URL('../tutorials-tests.sh', import.meta.url));

let workDir;

before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'soat-tutorials-quotes-'));
});

after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Writes a tutorial whose CLI tab contains `commands`. */
const writeTutorial = async (name, commands) => {
  const file = path.join(workDir, `${name}.md`);
  await writeFile(
    file,
    [
      '<TabItem value="cli">',
      '',
      '```bash',
      commands,
      '```',
      '',
      '</TabItem>',
      '',
    ].join('\n')
  );
  return file;
};

const runTutorial = (file) => {
  return new Promise((resolve) => {
    const child = spawn('bash', [RUNNER, file], {
      env: {
        ...process.env,
        SOAT_BASE_URL: 'http://127.0.0.1:1',
        HOME: workDir,
      },
    });
    let output = '';
    child.stdout.on('data', (c) => {
      output += c;
    });
    child.stderr.on('data', (c) => {
      output += c;
    });
    child.on('close', (code) => {
      resolve({ code, output });
    });
  });
};

describe('command boundaries and quoting', () => {
  test('an apostrophe inside double quotes does not swallow the next command', async () => {
    // The exact shape that broke `memories-agent`: a possessive apostrophe in
    // a double-quoted argument. It is one `'` byte, so a naive count reads the
    // command as unterminated and keeps consuming the lines after it.
    const file = await writeTutorial(
      'apostrophe-in-double-quotes',
      [
        'echo "Alice\'s fiscal year ends in March"',
        'echo SECOND_COMMAND_RAN',
      ].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.doesNotMatch(output, /unexpected EOF/);
    assert.match(output, /SECOND_COMMAND_RAN/);
    // Both lines happen to *run* even when glued together, so asserting the
    // output alone would pass on the broken runner. The defect is the merge:
    // two commands must be two steps, or a `# → expect-fail` annotation binds
    // to the wrong one and the step count misreports what was covered.
    assert.match(output, /\[Step 2\]/);
    assert.equal(code, 0);
  });

  test('a single-quoted string spanning two lines stays one command', async () => {
    // The behavior the naive count got right and which must survive the fix:
    // a `jq` filter broken across lines is a single argument, not two commands.
    const file = await writeTutorial(
      'multiline-single-quote',
      ["echo 'first line", "second line'"].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.match(output, /first line/);
    assert.match(output, /second line/);
    assert.equal(code, 0);
  });

  test('an apostrophe and a later multi-line filter both parse', async () => {
    // Both together, which is what `memories-agent` actually contains. The
    // apostrophe must not consume the filter, and the filter must still be
    // held together across its two lines.
    const file = await writeTutorial(
      'apostrophe-then-multiline',
      [
        'echo "Alice\'s renewal"',
        "echo 'filter part one",
        "filter part two'",
        'echo LAST_COMMAND_RAN',
      ].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.doesNotMatch(output, /unexpected EOF/);
    assert.match(output, /filter part one/);
    assert.match(output, /filter part two/);
    assert.match(output, /LAST_COMMAND_RAN/);
    // Three commands: the echo, the two-line filter, and the last echo.
    assert.match(output, /\[Step 3\]/);
    assert.equal(code, 0);
  });

  test('a double quote inside a single-quoted string is a literal', async () => {
    // The mirror case. `jq '[.data[] | select(.source_type == "agent")]'`
    // carries two double quotes inside single quotes; treating either as
    // opening a double-quoted context would desynchronize the scanner.
    const file = await writeTutorial(
      'double-quote-in-single',
      ['echo \'a "quoted" word\'', 'echo AFTER_LITERAL'].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.match(output, /a "quoted" word/);
    assert.match(output, /AFTER_LITERAL/);
    assert.equal(code, 0);
  });
});
