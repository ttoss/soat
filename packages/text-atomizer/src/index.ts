import ollama from 'ollama';

const SEED = 42;

const SYSTEM_PROMPT = `
Act as a linguist specialized in syntactic analysis. Your task is to perform a structural decomposition of the sentences provided.

You must produce a two-level analysis:

Level 1: Identify and separate the two essential terms of the sentence: the Subject and the Predicate.
Level 2: Decompose the Predicate into its core verb and its dependents.

Output Format:

Return a JSON object with the following structure:
{
  "subject": "[Identified Subject]",
  "predicate": {
    "text": "[Identified Predicate]",
    "verb": "[Main verb nucleus of the predicate]",
    "complements": ["[Verb complements / required arguments]"] ,
    "adjuncts": ["[Adjuncts / optional modifiers]"]
  }
}

Rules:

- Maintain the analysis in the same language as the original sentence.
- If the sentence is impersonal (subjectless), keep the subject field null.
- Be precise in defining the boundary where the subject ends and the predicate begins.
- predicate.text MUST be the full predicate span as it appears in the sentence (everything after the subject), including the verb and all complements/adjuncts (minus final punctuation).
- The predicate.verb must be the main verb nucleus (a verb form as it appears in the sentence).
- Complements are dependents required by the verb (objects, predicatives, required prepositional complements). If none, return an empty array.
- Adjuncts are optional modifiers (adverbials, optional prepositional phrases, temporal/locative/manner phrases, etc). If none, return an empty array.
- Do not invent words. Prefer extracting spans from the original sentence.

Normalization rules for complements/adjuncts strings:

- Each item in complements/adjuncts should be the smallest meaningful span (usually a noun phrase).
- If a dependent is introduced by a preposition (e.g., "over the lazy dog"), DO NOT include the preposition in the complements/adjuncts item; include only the object of the preposition (e.g., "the lazy dog").
- Even when you omit the preposition in the array item, predicate.text must still include the full prepositional phrase as it appears in the sentence.

Example (follow exactly):

Input: "The quick brown fox jumps over the lazy dog."
Output:
{
  "subject": "The quick brown fox",
  "predicate": {
    "text": "jumps over the lazy dog",
    "verb": "jumps",
    "complements": ["the lazy dog"],
    "adjuncts": []
  }
}
`;

type PredicateDecomposition = {
  text: string;
  verb: string;
  complements: string[];
  adjuncts: string[];
};

type DecompositionResult = {
  subject: string | null;
  predicate: PredicateDecomposition;
};

export const atomizeText = async (args: { text: string }) => {
  const response = await ollama.chat({
    model: 'gemma3:1b',
    format: 'json',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Analyze and decompose the following sentence:\n\n"${args.text}"`,
      },
    ],
    options: {
      seed: SEED,
      temperature: 0,
    },
  });

  const content = response.message.content;

  let result: DecompositionResult;
  try {
    result = JSON.parse(content) as DecompositionResult;
  } catch (error) {
    throw new Error(
      `Failed to parse model JSON response: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (typeof result.subject !== 'string' && result.subject !== null) {
    throw new Error('Invalid subject in response');
  }

  if (
    typeof result.predicate !== 'object' ||
    result.predicate === null ||
    Array.isArray(result.predicate)
  ) {
    throw new Error('Invalid predicate in response');
  }

  if (typeof result.predicate.text !== 'string') {
    throw new Error('Invalid predicate.text in response');
  }

  if (typeof result.predicate.verb !== 'string') {
    throw new Error('Invalid predicate.verb in response');
  }

  if (!Array.isArray(result.predicate.complements)) {
    throw new Error('Invalid predicate.complements in response');
  }

  if (
    !result.predicate.complements.every((value) => {
      return typeof value === 'string';
    })
  ) {
    throw new Error('Invalid predicate.complements item in response');
  }

  if (!Array.isArray(result.predicate.adjuncts)) {
    throw new Error('Invalid predicate.adjuncts in response');
  }

  if (
    !result.predicate.adjuncts.every((value) => {
      return typeof value === 'string';
    })
  ) {
    throw new Error('Invalid predicate.adjuncts item in response');
  }

  return result;
};

// atomizeText({ text: 'The quick brown fox jumps over the lazy dog.' }).then(
//   (result) => {
//     if (result) {
//       console.log('Decomposed:', result);
//     }
//   }
// );
