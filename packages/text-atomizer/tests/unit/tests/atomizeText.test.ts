import { atomizeText } from 'src/index';

jest.setTimeout(30000);

test.each([
  {
    // Simple transitive with direct object (phrase)
    text: 'The teacher gave the students a difficult test.',
    expected: {
      discourse: {
        speechAct: 'statement',
        topic: 'The teacher',
        focus: 'a difficult test',
      },
      subject: {
        text: 'The teacher',
        type: 'phrase',
        head: 'teacher',
        clauseType: null,
        appositive: null,
      },
      predicate: {
        text: 'gave the students a difficult test',
        verbalGroup: {
          text: 'gave',
          mainVerb: 'gave',
          auxiliaries: [],
          modals: [],
          voice: 'active',
          tense: 'past',
          aspect: 'simple',
        },
        directObject: {
          text: 'a difficult test',
          type: 'phrase',
          head: 'test',
          clauseType: null,
        },
        indirectObject: {
          text: 'the students',
          type: 'phrase',
          head: 'students',
        },
        prepositionalObject: null,
        subjectComplement: null,
        objectComplement: null,
        agent: null,
        adverbials: [],
      },
    },
  },
  {
    // Noun clause as direct object
    text: 'I believe that she is honest.',
    expected: {
      discourse: {
        speechAct: 'statement',
        topic: 'I',
        focus: 'that she is honest',
      },
      subject: {
        text: 'I',
        type: 'phrase',
        head: 'I',
        clauseType: null,
        appositive: null,
      },
      predicate: {
        text: 'believe that she is honest',
        verbalGroup: {
          text: 'believe',
          mainVerb: 'believe',
          auxiliaries: [],
          modals: [],
          voice: 'active',
          tense: 'present',
          aspect: 'simple',
        },
        directObject: {
          text: 'that she is honest',
          type: 'noun_clause',
          head: null,
          clauseType: 'that',
        },
        indirectObject: null,
        prepositionalObject: null,
        subjectComplement: null,
        objectComplement: null,
        agent: null,
        adverbials: [],
      },
    },
  },
  {
    // Infinitive clause as direct object
    text: 'I want to leave.',
    expected: {
      discourse: { speechAct: 'statement', topic: 'I', focus: 'to leave' },
      subject: {
        text: 'I',
        type: 'phrase',
        head: 'I',
        clauseType: null,
        appositive: null,
      },
      predicate: {
        text: 'want to leave',
        verbalGroup: {
          text: 'want',
          mainVerb: 'want',
          auxiliaries: [],
          modals: [],
          voice: 'active',
          tense: 'present',
          aspect: 'simple',
        },
        directObject: {
          text: 'to leave',
          type: 'infinitive_clause',
          head: null,
          clauseType: 'to',
        },
        indirectObject: null,
        prepositionalObject: null,
        subjectComplement: null,
        objectComplement: null,
        agent: null,
        adverbials: [],
      },
    },
  },
  {
    // Prepositional object (verb-required PP)
    text: 'He depends on you.',
    expected: {
      discourse: { speechAct: 'statement', topic: 'He', focus: 'on you' },
      subject: {
        text: 'He',
        type: 'phrase',
        head: 'He',
        clauseType: null,
        appositive: null,
      },
      predicate: {
        text: 'depends on you',
        verbalGroup: {
          text: 'depends',
          mainVerb: 'depend',
          auxiliaries: [],
          modals: [],
          voice: 'active',
          tense: 'present',
          aspect: 'simple',
        },
        directObject: null,
        indirectObject: null,
        prepositionalObject: {
          text: 'on you',
          preposition: 'on',
          object: { text: 'you', head: 'you' },
        },
        subjectComplement: null,
        objectComplement: null,
        agent: null,
        adverbials: [],
      },
    },
  },
  {
    // Passive voice with agent
    text: 'The cake was eaten by John.',
    expected: {
      discourse: {
        speechAct: 'statement',
        topic: 'The cake',
        focus: 'by John',
      },
      subject: {
        text: 'The cake',
        type: 'phrase',
        head: 'cake',
        clauseType: null,
        appositive: null,
      },
      predicate: {
        text: 'was eaten by John',
        verbalGroup: {
          text: 'was eaten',
          mainVerb: 'eat',
          auxiliaries: ['was'],
          modals: [],
          voice: 'passive',
          tense: 'past',
          aspect: 'simple',
        },
        directObject: null,
        indirectObject: null,
        prepositionalObject: null,
        subjectComplement: null,
        objectComplement: null,
        agent: { text: 'by John', head: 'John' },
        adverbials: [],
      },
    },
  },
  {
    // Gerund as subject
    text: 'Running is healthy.',
    expected: {
      discourse: { speechAct: 'statement', topic: 'Running', focus: 'healthy' },
      subject: {
        text: 'Running',
        type: 'gerund_clause',
        head: null,
        clauseType: null,
        appositive: null,
      },
      predicate: {
        text: 'is healthy',
        verbalGroup: {
          text: 'is',
          mainVerb: 'be',
          auxiliaries: [],
          modals: [],
          voice: 'active',
          tense: 'present',
          aspect: 'simple',
        },
        directObject: null,
        indirectObject: null,
        prepositionalObject: null,
        subjectComplement: {
          text: 'healthy',
          type: 'phrase',
          head: 'healthy',
          clauseType: null,
        },
        objectComplement: null,
        agent: null,
        adverbials: [],
      },
    },
  },
  {
    // Appositive
    text: 'My friend, a doctor, is here.',
    expected: {
      discourse: { speechAct: 'statement', topic: 'My friend', focus: 'here' },
      subject: {
        text: 'My friend',
        type: 'phrase',
        head: 'friend',
        clauseType: null,
        appositive: { text: 'a doctor', head: 'doctor' },
      },
      predicate: {
        text: 'is here',
        verbalGroup: {
          text: 'is',
          mainVerb: 'be',
          auxiliaries: [],
          modals: [],
          voice: 'active',
          tense: 'present',
          aspect: 'simple',
        },
        directObject: null,
        indirectObject: null,
        prepositionalObject: null,
        subjectComplement: null,
        objectComplement: null,
        agent: null,
        adverbials: [
          {
            text: 'here',
            type: 'phrase',
            head: 'here',
            clauseType: null,
            semanticRole: 'place',
          },
        ],
      },
    },
  },
  {
    // Present perfect progressive (complex verbal group)
    text: 'She has been working hard.',
    expected: {
      discourse: { speechAct: 'statement', topic: 'She', focus: 'hard' },
      subject: {
        text: 'She',
        type: 'phrase',
        head: 'She',
        clauseType: null,
        appositive: null,
      },
      predicate: {
        text: 'has been working hard',
        verbalGroup: {
          text: 'has been working',
          mainVerb: 'work',
          auxiliaries: ['has', 'been'],
          modals: [],
          voice: 'active',
          tense: 'present',
          aspect: 'perfect_progressive',
        },
        directObject: null,
        indirectObject: null,
        prepositionalObject: null,
        subjectComplement: null,
        objectComplement: null,
        agent: null,
        adverbials: [
          {
            text: 'hard',
            type: 'phrase',
            head: 'hard',
            clauseType: null,
            semanticRole: 'manner',
          },
        ],
      },
    },
  },
  {
    // Participle clause as adverbial
    text: 'Having finished the work, she left.',
    expected: {
      discourse: { speechAct: 'statement', topic: 'she', focus: 'left' },
      subject: {
        text: 'she',
        type: 'phrase',
        head: 'she',
        clauseType: null,
        appositive: null,
      },
      predicate: {
        text: 'left',
        verbalGroup: {
          text: 'left',
          mainVerb: 'leave',
          auxiliaries: [],
          modals: [],
          voice: 'active',
          tense: 'past',
          aspect: 'simple',
        },
        directObject: null,
        indirectObject: null,
        prepositionalObject: null,
        subjectComplement: null,
        objectComplement: null,
        agent: null,
        adverbials: [
          {
            text: 'Having finished the work',
            type: 'participle_clause',
            head: null,
            clauseType: null,
            semanticRole: 'time',
          },
        ],
      },
    },
  },
])('atomizeText correctly decomposes: "$text"', async ({ text, expected }) => {
  const result = await atomizeText({ text });
  expect(result).toEqual(expected);
});
