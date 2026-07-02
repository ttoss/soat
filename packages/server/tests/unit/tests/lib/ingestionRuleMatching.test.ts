import {
  compareGlobSpecificity,
  matchesContentTypeGlob,
} from 'src/lib/ingestionRuleMatching';

describe('matchesContentTypeGlob', () => {
  test('matches an exact content type with no wildcard', () => {
    expect(
      matchesContentTypeGlob({ glob: 'image/png', contentType: 'image/png' })
    ).toBe(true);
  });

  test('matches a subtype wildcard', () => {
    expect(
      matchesContentTypeGlob({ glob: 'image/*', contentType: 'image/jpeg' })
    ).toBe(true);
  });

  test('matches a full wildcard', () => {
    expect(
      matchesContentTypeGlob({ glob: '*/*', contentType: 'text/csv' })
    ).toBe(true);
  });

  test('does not match a different exact content type', () => {
    expect(
      matchesContentTypeGlob({ glob: 'image/png', contentType: 'image/jpeg' })
    ).toBe(false);
  });

  test('does not match a different subtype wildcard', () => {
    expect(
      matchesContentTypeGlob({ glob: 'image/*', contentType: 'audio/mpeg' })
    ).toBe(false);
  });

  test('matches a content type with special regex characters escaped literally', () => {
    expect(
      matchesContentTypeGlob({
        glob: 'application/vnd.api+json',
        contentType: 'application/vnd.api+json',
      })
    ).toBe(true);
    expect(
      matchesContentTypeGlob({
        glob: 'application/vnd.api+json',
        contentType: 'applicationXvndXapiXjson',
      })
    ).toBe(false);
  });
});

describe('compareGlobSpecificity', () => {
  test('ranks fewer wildcards as more specific', () => {
    expect(compareGlobSpecificity('image/png', 'image/*')).toBeLessThan(0);
    expect(compareGlobSpecificity('image/*', 'image/png')).toBeGreaterThan(0);
  });

  test('ranks a longer literal pattern as more specific when wildcard counts are equal', () => {
    expect(compareGlobSpecificity('image/*', 'i/*')).toBeLessThan(0);
    expect(compareGlobSpecificity('i/*', 'image/*')).toBeGreaterThan(0);
  });

  test('breaks ties alphabetically when wildcard count and length are equal', () => {
    expect(compareGlobSpecificity('audio/*', 'image/*')).toBeLessThan(0);
    expect(compareGlobSpecificity('image/*', 'audio/*')).toBeGreaterThan(0);
    expect(compareGlobSpecificity('image/*', 'image/*')).toBe(0);
  });
});
