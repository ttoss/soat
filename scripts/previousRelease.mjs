/**
 * The previous release: the newest `CHANGELOG.md` version whose `v<version>`
 * tag is on `origin`. A release PR adds its own heading before its tag exists,
 * so the top heading alone is not a published release.
 *
 * `tests/harness/previousRelease.test.mjs` pins these rules.
 *
 * Usage: node scripts/previousRelease.mjs   (prints the version)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const previousRelease = (args) => {
  const tags = new Set(args.tags);
  for (const match of args.changelog.matchAll(
    /^#{1,2} \[(\d+\.\d+\.\d+)\]/gm
  )) {
    if (tags.has(`v${match[1]}`)) {
      return match[1];
    }
  }
  throw new Error(
    'CHANGELOG.md names no published release (no v<version> tag on origin)'
  );
};

const remoteTags = () => {
  return execFileSync(
    'git',
    ['ls-remote', '--tags', '--refs', 'origin', 'v*'],
    { encoding: 'utf8' }
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      return line.split('\trefs/tags/')[1];
    });
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const changelog = fs.readFileSync(`${root}/CHANGELOG.md`, 'utf8');
  const version = previousRelease({ changelog, tags: remoteTags() });
  process.stdout.write(`${version}\n`);
}
