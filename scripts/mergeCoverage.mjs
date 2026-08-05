/**
 * Merge the coverage each test shard produced and enforce the suite's coverage
 * thresholds over the union.
 *
 * Sharding splits the server suite across parallel CI jobs, and no shard sees
 * more than its own slice of the source — so no shard can be allowed to check
 * thresholds itself (every one of them would fail). The shards run with
 * thresholds disabled and emit raw coverage; this script re-assembles it and
 * applies the gate once, over the whole picture.
 *
 * The thresholds are read from `jest --showConfig` rather than restated here,
 * so `jest.config.ts` stays the single source of truth. The evaluation below
 * deliberately mirrors Jest's own `_checkThreshold`, including its two
 * non-obvious rules:
 *
 *   - a file matched by a path/glob group is checked in *that* group only, and
 *   - the `global` group then falls back to every covered file.
 *
 * `tests/harness/mergeCoverage.test.mjs` pins that behaviour.
 *
 * Usage:
 *   node scripts/mergeCoverage.mjs --config <showConfig.json> \
 *     --cwd <package dir> <shard-coverage.json...>
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// CommonJS module — its named exports are not statically analysable from ESM.
import istanbulCoverage from 'istanbul-lib-coverage';

const { createCoverageMap } = istanbulCoverage;

const METRICS = ['statements', 'branches', 'lines', 'functions'];

export const mergeCoverage = (args) => {
  const merged = createCoverageMap({});

  for (const coverage of args.coverages) {
    merged.merge(coverage);
  }

  return merged;
};

const checkSummary = (args) => {
  const errors = [];

  for (const metric of METRICS) {
    const threshold = args.thresholds[metric];

    if (threshold === undefined) {
      continue;
    }

    const actual = args.summary[metric];

    if (threshold < 0) {
      const uncovered = actual.total - actual.covered;

      if (uncovered > -threshold) {
        errors.push(
          `Uncovered count for ${metric} (${uncovered}) exceeds ${args.name} threshold (${-threshold})`
        );
      }
    } else if (actual.pct < threshold) {
      errors.push(
        `Coverage for ${metric} (${actual.pct}%) does not meet "${args.name}" threshold (${threshold}%)`
      );
    }
  }

  return errors;
};

const combineSummaries = (args) => {
  return args.files
    .map((file) => {
      return args.coverageMap.fileCoverageFor(file).toSummary();
    })
    .reduce((combined, summary) => {
      return combined ? combined.merge(summary) : summary;
    }, undefined);
};

/**
 * Sort every covered file into exactly one threshold group, the way Jest does:
 * a group key is either a directory prefix or a glob, and `global` collects
 * whatever no other group claimed.
 */
const groupFiles = (args) => {
  const groups = Object.keys(args.coverageThreshold).filter((group) => {
    return group !== 'global';
  });

  const matchedByGroup = new Map(
    groups.map((group) => {
      return [group, []];
    })
  );
  const globCache = new Map();
  const unclaimed = [];

  for (const file of args.coverageMap.files()) {
    const group = groups.find((candidate) => {
      const absolute = path.resolve(args.cwd, candidate);

      if (file.startsWith(absolute + path.sep)) {
        return true;
      }

      if (!globCache.has(absolute)) {
        globCache.set(
          absolute,
          fs.globSync(candidate, { cwd: args.cwd }).map((match) => {
            return path.resolve(args.cwd, match);
          })
        );
      }

      return globCache.get(absolute).includes(file);
    });

    if (group) {
      matchedByGroup.get(group).push(file);
    } else {
      unclaimed.push(file);
    }
  }

  return { matchedByGroup, unclaimed };
};

export const evaluateThresholds = (args) => {
  const { matchedByGroup, unclaimed } = groupFiles(args);
  const allFiles = args.coverageMap.files();
  const errors = [];

  for (const [group, thresholds] of Object.entries(args.coverageThreshold)) {
    if (group === 'global') {
      // Jest falls back to every covered file when the glob/path groups
      // claimed them all — the global gate covers the suite either way.
      const files = unclaimed.length > 0 ? unclaimed : allFiles;
      const summary = combineSummaries({
        coverageMap: args.coverageMap,
        files,
      });

      if (summary) {
        errors.push(...checkSummary({ name: 'global', summary, thresholds }));
      }

      continue;
    }

    const files = matchedByGroup.get(group);

    if (files.length === 0) {
      errors.push(`Coverage data for ${group} was not found.`);
      continue;
    }

    // A path group is checked in aggregate; a glob group, file by file.
    const isPath = files.every((file) => {
      return file.startsWith(path.resolve(args.cwd, group) + path.sep);
    });

    if (isPath) {
      const summary = combineSummaries({
        coverageMap: args.coverageMap,
        files,
      });
      errors.push(...checkSummary({ name: group, summary, thresholds }));
      continue;
    }

    for (const file of files) {
      errors.push(
        ...checkSummary({
          name: file,
          summary: args.coverageMap.fileCoverageFor(file).toSummary(),
          thresholds,
        })
      );
    }
  }

  return errors;
};

const parseArgs = (argv) => {
  const options = { config: undefined, cwd: process.cwd(), files: [] };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--config') {
      index += 1;
      options.config = argv[index];
    } else if (argv[index] === '--cwd') {
      index += 1;
      options.cwd = path.resolve(argv[index]);
    } else {
      options.files.push(argv[index]);
    }
  }

  return options;
};

const readJson = (file) => {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));

  if (!options.config || options.files.length === 0) {
    throw new Error(
      'usage: node scripts/mergeCoverage.mjs --config <showConfig.json> ' +
        '--cwd <dir> <shard-coverage.json...>'
    );
  }

  const { coverageThreshold } = readJson(options.config).globalConfig;

  if (!coverageThreshold) {
    throw new Error(
      'The Jest config declares no coverageThreshold — nothing would be ' +
        'enforced, so the sharded run has no gate. Refusing to pass silently.'
    );
  }

  const coverageMap = mergeCoverage({
    coverages: options.files.map(readJson),
  });
  console.log(
    `Merged coverage from ${options.files.length} shard(s): ${coverageMap.files().length} files.`
  );

  const errors = evaluateThresholds({
    coverageMap,
    coverageThreshold,
    cwd: options.cwd,
  });

  for (const error of errors) {
    console.error(`Jest: ${error}`);
  }

  if (errors.length > 0) {
    process.exitCode = 1;
    return;
  }
  console.log('Coverage thresholds met.');
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
