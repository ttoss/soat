import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { previousRelease } from '../../scripts/previousRelease.mjs';

const changelog = [
  '# Change Log',
  '',
  '# [0.116.0](https://github.com/ttoss/soat/compare/v0.115.0...v0.116.0) (2026-11-17)',
  '',
  '## [0.115.1](https://github.com/ttoss/soat/compare/v0.115.0...v0.115.1) (2026-11-17)',
  '',
  '# [0.115.0](https://github.com/ttoss/soat/compare/v0.114.0...v0.115.0) (2026-11-16)',
  '',
  '# [0.114.0](https://github.com/ttoss/soat/compare/v0.113.0...v0.114.0) (2026-11-16)',
].join('\n');

const images = (versions) => {
  return async (version) => {
    return versions.includes(version);
  };
};

const allImages = images(['0.114.0', '0.115.0', '0.115.1', '0.116.0']);

describe('previousRelease', () => {
  test('is the newest CHANGELOG version whose tag and image are published', async () => {
    assert.equal(
      await previousRelease({
        changelog,
        tags: ['v0.114.0', 'v0.115.1', 'v0.116.0'],
        hasImage: allImages,
      }),
      '0.116.0'
    );
  });

  test('skips a version the change adds before its tag exists', async () => {
    assert.equal(
      await previousRelease({
        changelog,
        tags: ['v0.114.0', 'v0.115.0'],
        hasImage: allImages,
      }),
      '0.115.0'
    );
  });

  test('skips a tagged version whose image is not yet published', async () => {
    assert.equal(
      await previousRelease({
        changelog,
        tags: ['v0.114.0', 'v0.115.1', 'v0.116.0'],
        hasImage: images(['0.114.0', '0.115.1']),
      }),
      '0.115.1'
    );
  });

  test('never looks up the image of an untagged version', async () => {
    const asked = [];
    await previousRelease({
      changelog,
      tags: ['v0.115.0'],
      hasImage: async (version) => {
        asked.push(version);
        return true;
      },
    });
    assert.deepEqual(asked, ['0.115.0']);
  });

  test('ignores tags that name no CHANGELOG version', async () => {
    assert.equal(
      await previousRelease({
        changelog,
        tags: ['v9.9.9', 'v0.114.0'],
        hasImage: allImages,
      }),
      '0.114.0'
    );
  });
});

describe('previousRelease fails closed', () => {
  test('when no CHANGELOG version is tagged', async () => {
    await assert.rejects(
      previousRelease({ changelog, tags: ['v9.9.9'], hasImage: allImages }),
      /no published release/
    );
  });

  test('when no tagged version has an image', async () => {
    await assert.rejects(
      previousRelease({
        changelog,
        tags: ['v0.116.0'],
        hasImage: images([]),
      }),
      /no published release/
    );
  });

  test('when the image lookup fails', async () => {
    await assert.rejects(
      previousRelease({
        changelog,
        tags: ['v0.116.0'],
        hasImage: async () => {
          throw new Error('registry unreachable');
        },
      }),
      /registry unreachable/
    );
  });
});
