// Tests for the `# → retry N` annotation in tests/tutorials-tests.sh.
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
  workDir = await mkdtemp(path.join(tmpdir(), 'soat-tutorials-'));
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

// A command that fails its first `failures` invocations and then succeeds,
// using a counter file so state survives across retries.
const flakyCommand = (counterName, failures) => {
  const counter = path.join(workDir, counterName);
  return [
    `COUNT=$(cat ${counter} 2>/dev/null || echo 0); COUNT=$((COUNT + 1)); echo "$COUNT" > ${counter}; test "$COUNT" -gt ${failures}`,
    counter,
  ];
};

describe('tutorials-tests.sh retry annotation', () => {
  test('retries an annotated command until it succeeds', async () => {
    const [cmd] = flakyCommand('eventually-passes', 2);
    const file = await writeTutorial(
      'eventually-passes',
      ['# → retry 5', cmd].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    assert.match(output, /attempt 2\/5/);
    assert.match(output, /Tutorial validation completed successfully/);
  });

  // The real call site (chat-with-llm.md step 11) is a backslash-continued
  // command piped into `jq -e`, with the annotation on its own line above it.
  test('applies to a multi-line command piped into an assertion', async () => {
    const counter = path.join(workDir, 'multiline-counter');
    const file = await writeTutorial(
      'multiline',
      [
        '# → retry 5',
        `COUNT=$(cat ${counter} 2>/dev/null || echo 0); COUNT=$((COUNT + 1)); echo "$COUNT" > ${counter}; echo "$COUNT" \\`,
        `  | jq -e '. >= 3'`,
      ].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    assert.match(output, /attempt 3\/5/);
  });

  test('fails after exhausting the retry budget', async () => {
    const [cmd] = flakyCommand('never-passes', 99);
    const file = await writeTutorial(
      'never-passes',
      ['# → retry 3', cmd].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 1);
    assert.match(output, /failed after 3 attempts/);
  });

  test('runs an annotated command exactly once when it passes first try', async () => {
    const [cmd, counter] = flakyCommand('passes-first', 0);
    const file = await writeTutorial(
      'passes-first',
      ['# → retry 5', cmd].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    const { readFile } = await import('node:fs/promises');
    assert.equal((await readFile(counter, 'utf8')).trim(), '1');
  });

  test('leaves unannotated commands failing on the first error', async () => {
    const [cmd] = flakyCommand('unannotated', 2);
    const file = await writeTutorial('unannotated', cmd);

    const { code, output } = await runTutorial(file);

    assert.equal(code, 1);
    assert.match(output, /Command failed \(exit 1\)/);
  });

  test('still honors the expect-fail and ignore annotations', async () => {
    const file = await writeTutorial(
      'other-annotations',
      ['# → 403', 'false', '', '# → ignore', 'false', '', 'true'].join('\n')
    );

    const { code, output } = await runTutorial(file);

    assert.equal(code, 0, output);
    assert.match(output, /expected failure — ok/);
  });
});
