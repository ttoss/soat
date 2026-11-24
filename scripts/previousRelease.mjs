/**
 * The previous release: the newest `CHANGELOG.md` version whose `v<version>`
 * tag is on `origin` and whose `ttoss/soat:<version>` image is on Docker Hub.
 * A release PR adds its own heading before its tag exists, and `main.yml`
 * pushes the tag before it publishes the image.
 *
 * `tests/harness/previousRelease.test.mjs` pins these rules.
 *
 * Usage: node scripts/previousRelease.mjs   (prints the version)
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const previousRelease = async (args) => {
  const tags = new Set(args.tags);
  for (const match of args.changelog.matchAll(
    /^#{1,2} \[(\d+\.\d+\.\d+)\]/gm
  )) {
    if (tags.has(`v${match[1]}`) && (await args.hasImage(match[1]))) {
      return match[1];
    }
  }
  throw new Error(
    'CHANGELOG.md names no published release (no v<version> tag on origin with its image on Docker Hub)'
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

const dockerHubHasImage = async (version) => {
  const response = await fetch(
    `https://hub.docker.com/v2/repositories/ttoss/soat/tags/${version}`
  );
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(
      `Docker Hub answered ${response.status} for ttoss/soat:${version}`
    );
  }
  return true;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  }).trim();
  const changelog = fs.readFileSync(`${root}/CHANGELOG.md`, 'utf8');
  const version = await previousRelease({
    changelog,
    tags: remoteTags(),
    hasImage: dockerHubHasImage,
  });
  process.stdout.write(`${version}\n`);
}
