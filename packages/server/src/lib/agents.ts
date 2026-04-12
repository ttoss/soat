import { Ollama } from 'ollama';

export const streamAgent = async (args: { model: string; prompt: string }) => {
  const host = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
  const ollama = new Ollama({ host });

  return ollama.chat({
    model: args.model,
    messages: [{ role: 'user', content: args.prompt }],
    stream: true,
  });
};
