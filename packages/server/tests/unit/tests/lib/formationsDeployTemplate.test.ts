import { restoreTemplateSecrets } from 'src/lib/formationsDeployTemplate';

const MASK = { no_echo: true };

const agent = (header: unknown) => {
  return {
    type: 'agent',
    properties: {
      name: 'a',
      tool_bindings: [
        { tool: { name: 'x', type: 'mcp', mcp: { url: 'u' } } },
        {
          tool: {
            name: 'y',
            type: 'mcp',
            mcp: { url: 'u', headers: { Authorization: header } },
          },
        },
      ],
    },
  };
};

describe('restoreTemplateSecrets', () => {
  test('a placeholder inside an array entry takes the stored entry value', () => {
    const stored = { resources: { A: agent('Bearer literal') } };

    expect(
      restoreTemplateSecrets({
        template: { resources: { A: agent(MASK) } },
        stored,
      })
    ).toEqual(stored);
  });

  test('an array shortened beside a placeholder is refused', () => {
    const shortened = agent(MASK);
    shortened.properties.tool_bindings.shift();

    expect(() => {
      return restoreTemplateSecrets({
        template: { resources: { A: shortened } },
        stored: { resources: { A: agent('Bearer literal') } },
      });
    }).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }));
  });

  test('a resource without a placeholder passes through unchanged', () => {
    const template = { resources: { A: agent('{{secret:sec_1}}') } };

    expect(restoreTemplateSecrets({ template, stored: null })).toEqual(
      template
    );
  });

  test('a template with no resources map is returned as sent', () => {
    const template = { parameters: { P: { default: MASK } } };

    expect(restoreTemplateSecrets({ template, stored: null })).toBe(template);
  });
});
