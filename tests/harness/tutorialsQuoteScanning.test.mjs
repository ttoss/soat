// Command-boundary detection in tests/tutorials-tests.sh.
//
// The runner joins multi-line commands by tracking unclosed single quotes. The
// check used to count every `'`, which cannot tell a quote from an apostrophe —
// one `Alice's` made the count odd, so the runner swallowed every later line and
// died on `unexpected EOF` naming a command that had already run fine.
//
// Driven against throwaway markdown, so no server or LLM is involved.
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

/** The runner prints `[Step N] <command>` as it dispatches each command. */
const steps = (output) => {
  return [...output.matchAll(/^\[Step (\d+)\] (.*)$/gm)].map((m) => {
    return m[2];
  });
};

describe('command boundaries and quoting', () => {
  test('an apostrophe inside a double-quoted argument ends the command', async () => {
    const file = await writeTutorial(
      'apostrophe',
      [
        'echo "Alice\'s fiscal year ends in March"',
        'echo second-command-ran',
      ].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    // Two commands, dispatched as two steps — not swallowed into one blob.
    assert.deepEqual(steps(output), [
      'echo "Alice\'s fiscal year ends in March"',
      'echo second-command-ran',
    ]);
    assert.doesNotMatch(output, /unexpected EOF/);
  });

  test('every apostrophe-bearing command is its own step', async () => {
    const file = await writeTutorial(
      'apostrophes-many',
      [
        'echo "Alice\'s policy"',
        'echo "Bob\'s policy"',
        'echo "Carol\'s policy"',
        'echo last-command-ran',
      ].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    assert.equal(steps(output).length, 4, output);
    assert.doesNotMatch(output, /unexpected EOF/);
  });

  test('a genuinely unclosed single-quoted string still joins the next line', async () => {
    const file = await writeTutorial(
      'multiline-json',
      ['echo \'{', '  "memory_ids": ["mem_1"]', '}\'', 'echo after-json'].join(
        '\n'
      )
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    assert.match(output, /"memory_ids"/);
    assert.match(output, /after-json/);
    // The JSON spans three lines but is one command; `after-json` is the second.
    assert.equal(steps(output).length, 2, output);
  });

  test('a double-quoted string spanning lines is joined, not split', async () => {
    const file = await writeTutorial(
      'multiline-double',
      ['echo "first line', 'second line"', 'echo after-double'].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    assert.match(output, /second line/);
    assert.match(output, /after-double/);
    assert.doesNotMatch(output, /unexpected EOF/);
  });

  test('an apostrophe followed by a multi-line filter keeps both intact', async () => {
    // The two shapes interleaved, as `memories-agent.md` had them when #1046
    // fired. Neither alone reproduces it: the apostrophe leaves the old counter
    // odd and the next opening quote brings it back to even, so the runner
    // flushed a blob whose quote was still open.
    const file = await writeTutorial(
      'apostrophe-then-multiline',
      [
        'echo "Alice\'s renewal"',
        "echo '[.data[] | select(.source_type == \"agent\")",
        "       | {content, source_type}]'",
        'echo after-filter',
      ].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    assert.doesNotMatch(output, /unexpected EOF/);
    assert.match(output, /source_type/);
    assert.match(output, /after-filter/);
    // Three commands: the apostrophe echo, the two-line filter, the last echo.
    assert.equal(steps(output).length, 3, output);
  });
});
