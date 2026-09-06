import { buildObjectPath, categoryFromPath } from 'src/lib/fileStorageLayout';

describe('fileStorageLayout', () => {
  describe('buildObjectPath', () => {
    test('scopes an object to its project and category', () => {
      expect(
        buildObjectPath({
          projectPublicId: 'proj_ABC',
          category: 'traces',
          fileId: 'file_123',
          filename: 'run.json',
        })
      ).toBe('proj_ABC/traces/file_123.json');
    });

    test('omits the extension when the filename has none', () => {
      expect(
        buildObjectPath({
          projectPublicId: 'proj_ABC',
          category: 'files',
          fileId: 'file_123',
          filename: 'README',
        })
      ).toBe('proj_ABC/files/file_123');
    });

    test('the extension override describes the bytes, not the download name', () => {
      // A document's stored object is always UTF-8 text, even when the
      // document is named after the binary it was ingested from.
      expect(
        buildObjectPath({
          projectPublicId: 'proj_ABC',
          category: 'documents',
          fileId: 'file_123',
          filename: 'report.pdf',
          extension: '.txt',
        })
      ).toBe('proj_ABC/documents/file_123.txt');
    });
  });

  describe('categoryFromPath', () => {
    test('uses the leading directory segment', () => {
      expect(categoryFromPath('/traces/run.json')).toBe('traces');
    });

    test('falls back to files for a root-level or absent path', () => {
      expect(categoryFromPath('/run.json')).toBe('files');
      expect(categoryFromPath(null)).toBe('files');
    });
  });

  describe('the object-path boundary', () => {
    test('a provider only accepts a path minted by this module', () => {
      const write = (_args: {
        objectPath: ReturnType<typeof buildObjectPath>;
      }) => {
        return null;
      };

      // A hand-rolled key is what let two writers invent their own layout.
      // The brand is the compile-time refusal; this pins it so a later
      // widening of the type fails the build here.
      // @ts-expect-error a raw string is not a StorageObjectPath
      write({ objectPath: 'file_123.txt' });

      expect(
        write({
          objectPath: buildObjectPath({
            projectPublicId: 'proj_ABC',
            category: 'files',
            fileId: 'file_123',
          }),
        })
      ).toBeNull();
    });
  });
});
