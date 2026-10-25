import {
  collectUnknownFields,
  isOpenOrAmbiguous,
  resolveInlineSchema,
} from '../../../../src/lib/openapiUnknownFields';

const unknownPaths = (args: { schema: unknown; value: unknown }): string[] => {
  return collectUnknownFields(args, { resolveRef: resolveInlineSchema }).map(
    (field) => {
      return field.path;
    }
  );
};

const exactlyOneOf = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tool_id: { type: 'string' },
    agent_id: { type: 'string' },
    settings: {
      type: 'object',
      additionalProperties: false,
      properties: { mode: { type: 'string' } },
    },
  },
  oneOf: [{ required: ['tool_id'] }, { required: ['agent_id'] }],
};

describe('openapiUnknownFields', () => {
  describe('a level whose oneOf branches carry only required', () => {
    test('reads as closed', () => {
      expect(isOpenOrAmbiguous(exactlyOneOf)).toBe(false);
    });

    test('reads as closed under anyOf too', () => {
      const { oneOf, ...rest } = exactlyOneOf;
      expect(isOpenOrAmbiguous({ ...rest, anyOf: oneOf })).toBe(false);
    });

    test('flags a key its properties do not declare', () => {
      expect(
        unknownPaths({
          schema: exactlyOneOf,
          value: { tool_id: 't', converter: 'ocr' },
        })
      ).toEqual(['converter']);
    });

    test('descends into its declared properties', () => {
      expect(
        unknownPaths({
          schema: exactlyOneOf,
          value: { agent_id: 'a', settings: { mode: 'x', extra: 1 } },
        })
      ).toEqual(['settings.extra']);
    });

    test('accepts a body carrying only declared keys', () => {
      expect(
        unknownPaths({ schema: exactlyOneOf, value: { tool_id: 't' } })
      ).toEqual([]);
    });
  });

  describe('a level whose oneOf branches are real shapes', () => {
    const union = {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          properties: { text: { type: 'string' } },
        },
        {
          type: 'object',
          additionalProperties: false,
          properties: { image_url: { type: 'string' } },
        },
      ],
    };

    test('stays ambiguous', () => {
      expect(isOpenOrAmbiguous(union)).toBe(true);
    });

    test('is judged against the union of branch fields', () => {
      expect(
        unknownPaths({ schema: union, value: { text: 'a', video: 'b' } })
      ).toEqual(['video']);
    });

    test('skips the level when a branch carries required beside other keywords', () => {
      const mixed = {
        ...exactlyOneOf,
        oneOf: [
          {
            required: ['tool_id'],
            properties: { tool_id: { type: 'string' } },
          },
          { required: ['agent_id'] },
        ],
      };
      expect(isOpenOrAmbiguous(mixed)).toBe(true);
    });

    test('skips the level when it also carries allOf', () => {
      expect(
        isOpenOrAmbiguous({ ...exactlyOneOf, allOf: [{ type: 'object' }] })
      ).toBe(true);
    });
  });
});
