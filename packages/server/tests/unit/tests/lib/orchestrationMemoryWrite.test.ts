import { parseMemoryWriteInputs } from 'src/lib/orchestrationMemoryWrite';

// Pure input-normalization for the `memory_write` node. F-14: a `tags` mapping
// was silently dropped and `source_type` from the node mapping was ignored.
describe('parseMemoryWriteInputs', () => {
  test('coerces non-string content to JSON', () => {
    expect(parseMemoryWriteInputs({ content: { a: 1 } }).content).toBe(
      '{"a":1}'
    );
  });

  test('passes a string tag array through unchanged', () => {
    expect(
      parseMemoryWriteInputs({ content: 'x', tags: ['role:pilot', 'a'] }).tags
    ).toEqual(['role:pilot', 'a']);
  });

  test('flattens a { key: value } tag mapping into key:value strings', () => {
    // The exact repro shape: input_mapping tags: { role: '<mapped>' }
    expect(
      parseMemoryWriteInputs({
        content: 'x',
        tags: { role: 'traffic-manager', source: 'rejected_approval' },
      }).tags
    ).toEqual(['role:traffic-manager', 'source:rejected_approval']);
  });

  test('drops non-string entries from a mixed tag array', () => {
    expect(
      parseMemoryWriteInputs({ content: 'x', tags: ['ok', 5, null] }).tags
    ).toEqual(['ok']);
  });

  test('keeps a plain object metadata and rejects arrays/scalars', () => {
    expect(
      parseMemoryWriteInputs({ content: 'x', metadata: { k: 'v' } }).metadata
    ).toEqual({ k: 'v' });
    expect(
      parseMemoryWriteInputs({ content: 'x', metadata: [1, 2] }).metadata
    ).toBeUndefined();
    expect(
      parseMemoryWriteInputs({ content: 'x', metadata: 'nope' }).metadata
    ).toBeUndefined();
  });

  test('honors a valid source_type from the mapping', () => {
    expect(
      parseMemoryWriteInputs({ content: 'x', sourceType: 'agent' }).sourceType
    ).toBe('agent');
  });

  test('defaults source_type to orchestration when absent or invalid', () => {
    expect(parseMemoryWriteInputs({ content: 'x' }).sourceType).toBe(
      'orchestration'
    );
    expect(
      parseMemoryWriteInputs({ content: 'x', sourceType: 'bogus' }).sourceType
    ).toBe('orchestration');
  });
});
