import { renderDeciderFrame } from 'src/lib/deciderFrame';

/**
 * The frame's exact wording. It is not part of a decider's version, so a
 * change to it can move answers on an unchanged decider; pinning it here makes
 * every such change a reviewed diff rather than a silent one.
 */
describe('renderDeciderFrame', () => {
  test('renders every question type, then the state', () => {
    const frame = renderDeciderFrame({
      questions: {
        route: {
          type: 'choice',
          instructions: 'Which team should own this ticket?',
          criteria: { billing: 'Charges', technical: 'Errors' },
        },
        severity: {
          type: 'score',
          instructions: 'How urgent is it?',
          criteria: ['Cosmetic', 'Blocking'],
        },
        escalate: {
          type: 'boolean',
          instructions: 'Escalate it?',
          criteria: { false: 'Routine', true: 'Legal threat' },
        },
        reply: { type: 'boolean', instructions: 'Reply today?' },
      },
      state: 'I was charged twice.',
    });

    expect(frame).toBe(
      [
        'Answer every question below about the state that follows. Choose each answer only from the ones its question offers.',
        '## Questions',
        '### route (choice)\nWhich team should own this ticket?\nAnswer with one of these options:\n- billing: Charges\n- technical: Errors',
        '### severity (score)\nHow urgent is it?\nAnswer with the number of the level that fits:\n- 0: Cosmetic\n- 1: Blocking',
        '### escalate (boolean)\nEscalate it?\nAnswer true or false:\n- false: Routine\n- true: Legal threat',
        '### reply (boolean)\nReply today?\nAnswer true or false.',
        '## State',
        '<state>',
        'I was charged twice.',
        '</state>',
      ].join('\n\n')
    );
  });

  test('a state that is not a string is shown as indented JSON', () => {
    const frame = renderDeciderFrame({
      questions: { reply: { type: 'boolean', instructions: 'Reply?' } },
      state: { order_id: 'ord_1' },
    });

    expect(frame).toContain(
      '<state>\n\n{\n  "order_id": "ord_1"\n}\n\n</state>'
    );
  });
});
