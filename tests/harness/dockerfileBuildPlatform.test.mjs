import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import * as url from 'node:url';

/**
 * The published image is multi-platform, and every platform other than the
 * runner's own is built under QEMU user emulation. tsdown is not reliable
 * there: on the arm64 leg a rolldown build can stop making progress and never
 * finish, with no error and no output, until the job's timeout.
 *
 * What the packages' `build` scripts emit is JavaScript, declarations and
 * static assets, identical on every platform, so the stage that runs them
 * pins itself to `$BUILDPLATFORM` and runs natively. The target-platform
 * stages take only those `dist/` directories from it: a `node_modules` copied
 * across would carry the build platform's native binaries into an image for
 * another architecture.
 */

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

const ROOT = path.resolve(__dirname, '../..');

const FROM = /^FROM\s+(?:--platform=(\S+)\s+)?\S+(?:\s+AS\s+(\S+))?\s*$/i;

const BUILD_RUN = /^RUN\s+pnpm\s+(?:--filter\s+\S+\s+)?(?:run\s+)?build\b/;

const COPY_FROM = /^COPY\s+--from=(\S+)\s+(\S+)\s+\S+\s*$/;

/**
 * Splits the Dockerfile into its stages, each with its `--platform` and its
 * instructions (continuation lines joined, comments dropped).
 */
const readStages = () => {
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf-8');

  const instructions = dockerfile
    .replace(/\\\n/g, ' ')
    .split('\n')
    .map((line) => {
      return line.trim();
    })
    .filter((line) => {
      return line && !line.startsWith('#');
    });

  const stages = [];

  for (const instruction of instructions) {
    const from = FROM.exec(instruction);

    if (from) {
      stages.push({
        name: from[2] ?? String(stages.length),
        platform: from[1],
        instructions: [],
      });
      continue;
    }

    stages.at(-1)?.instructions.push(instruction);
  }

  return stages;
};

const BUILD_PLATFORM = '$BUILDPLATFORM';

const runsBuild = (args) => {
  return args.stage.instructions.some((instruction) => {
    return BUILD_RUN.test(instruction);
  });
};

describe('Dockerfile build platform', () => {
  const stages = readStages();

  test('every stage that runs a package build runs on $BUILDPLATFORM', () => {
    const buildStages = stages.filter((stage) => {
      return runsBuild({ stage });
    });

    assert.ok(
      buildStages.length > 0,
      'expected a Dockerfile stage that runs `pnpm --filter <pkg> build`'
    );

    for (const stage of buildStages) {
      assert.equal(
        stage.platform,
        BUILD_PLATFORM,
        `stage "${stage.name}" runs a package build but is not ` +
          '`FROM --platform=$BUILDPLATFORM`: under QEMU the build can hang'
      );
    }
  });

  test('target-platform stages copy only dist/ from a $BUILDPLATFORM stage', () => {
    const buildPlatformStages = new Set(
      stages
        .filter((stage) => {
          return stage.platform === BUILD_PLATFORM;
        })
        .map((stage) => {
          return stage.name;
        })
    );

    for (const stage of stages) {
      if (stage.platform === BUILD_PLATFORM) {
        continue;
      }

      for (const instruction of stage.instructions) {
        const copy = COPY_FROM.exec(instruction);

        if (!copy || !buildPlatformStages.has(copy[1])) {
          continue;
        }

        assert.match(
          copy[2],
          /\/dist\/?$/,
          `stage "${stage.name}" copies ${copy[2]} from the build-platform ` +
            `stage "${copy[1]}": only dist/ is platform-independent`
        );
      }
    }
  });
});
