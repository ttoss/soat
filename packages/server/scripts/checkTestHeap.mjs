// Fails when a test file leaves memory behind in the jest worker: runs copies
// of one `rest/` file in band, collecting garbage after each, and measures how
// the heap grows per file. A handle a file never closes roots its module graph.
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

export const MAX_GROWTH_MB_PER_FILE = 5;
const COPIES = 8;
const PROBE = 'formationBodyLimit.test.ts';
const COPY_SUFFIX = '.heap-check.test.ts';

const SERVER = path.resolve(
  path.dirname(url.fileURLToPath(import.meta.url)),
  '..'
);
const REST = path.join(SERVER, 'tests/unit/tests/rest');

/**
 * The heap after each file, in run order, from jest's `--logHeapUsage` output.
 * The first file is dropped: it pays for the caches every later file shares.
 */
export const heapGrowth = ({ output }) => {
  const heaps = [
    ...output.matchAll(/^PASS .*[(, ](\d+) MB heap size\)$/gm),
  ].map((match) => {
    return Number(match[1]);
  });
  const measured = heaps.slice(1);
  const perFile =
    measured.length < 2
      ? Number.NaN
      : (measured.at(-1) - measured[0]) / (measured.length - 1);
  return { heaps, perFile };
};

const removeCopies = () => {
  for (const file of fs.readdirSync(REST)) {
    if (file.endsWith(COPY_SUFFIX)) fs.rmSync(path.join(REST, file));
  }
};

const main = () => {
  removeCopies();
  let result;
  try {
    for (let index = 1; index <= COPIES; index += 1) {
      fs.copyFileSync(
        path.join(REST, PROBE),
        path.join(REST, `heapCheck${index}${COPY_SUFFIX}`)
      );
    }
    result = spawnSync(
      'pnpm',
      [
        'exec',
        'jest',
        '--projects',
        'tests/unit',
        '--runInBand',
        '--logHeapUsage',
        '--coverage=false',
        '--reporters=default',
        '--testPathPatterns',
        `${COPY_SUFFIX.replaceAll('.', '\\.')}$`,
      ],
      {
        cwd: SERVER,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --expose-gc`,
        },
      }
    );
  } finally {
    removeCopies();
  }
  const output = `${result.stdout}${result.stderr}`;
  const { heaps, perFile } = heapGrowth({ output });
  console.log(`heap after each file (MB): ${heaps.join(', ')}`);
  if (result.status !== 0 || heaps.length !== COPIES) {
    console.error(output);
    console.error(`expected ${COPIES} passing files with a heap size`);
    process.exit(1);
  }
  console.log(`growth: ${perFile.toFixed(1)} MB per file`);
  if (!(perFile <= MAX_GROWTH_MB_PER_FILE)) {
    console.error(
      `over ${MAX_GROWTH_MB_PER_FILE} MB per file: a test file leaves a handle open`
    );
    process.exit(1);
  }
};

if (import.meta.url === `file://${process.argv[1]}`) main();
