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

describe('previousRelease', () => {
  test('is the newest CHANGELOG version whose tag is published', () => {
    assert.equal(
      previousRelease({
        changelog,
        tags: ['v0.114.0', 'v0.115.1', 'v0.116.0'],
      }),
      '0.116.0'
    );
  });

  test('skips a version the change adds before its tag exists', () => {
    assert.equal(
      previousRelease({ changelog, tags: ['v0.114.0', 'v0.115.0'] }),
      '0.115.0'
    );
  });

  test('ignores tags that name no CHANGELOG version', () => {
    assert.equal(
      previousRelease({ changelog, tags: ['v9.9.9', 'v0.114.0'] }),
      '0.114.0'
    );
  });

  test('fails closed when no CHANGELOG version is published', () => {
    assert.throws(() => {
      return previousRelease({ changelog, tags: ['v9.9.9'] });
    }, /no published release/);
  });
});
