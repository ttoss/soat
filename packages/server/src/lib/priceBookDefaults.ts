/**
 * Default price rows SOAT ships so cost is computed out of the box. Values are
 * USD per million tokens and are indicative — operators override them with
 * future-dated rows via `PUT /api/v1/usage/prices`. Seeded at a fixed past
 * `effectiveFrom` so they apply to every run until overridden.
 */
export const DEFAULT_PRICE_EFFECTIVE_FROM = new Date(
  '2020-01-01T00:00:00.000Z'
);

export const DEFAULT_PRICES: Array<{
  provider: string;
  model: string;
  inputPricePerM: number;
  outputPricePerM: number;
  cachedPricePerM: number | null;
}> = [
  {
    provider: 'openai',
    model: 'gpt-4o',
    inputPricePerM: 2.5,
    outputPricePerM: 10,
    cachedPricePerM: 1.25,
  },
  {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputPricePerM: 0.15,
    outputPricePerM: 0.6,
    cachedPricePerM: 0.075,
  },
  {
    provider: 'openai',
    model: 'o3-mini',
    inputPricePerM: 1.1,
    outputPricePerM: 4.4,
    cachedPricePerM: 0.55,
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-sonnet-latest',
    inputPricePerM: 3,
    outputPricePerM: 15,
    cachedPricePerM: 0.3,
  },
  {
    provider: 'anthropic',
    model: 'claude-3-5-haiku-latest',
    inputPricePerM: 0.8,
    outputPricePerM: 4,
    cachedPricePerM: 0.08,
  },
  {
    provider: 'google',
    model: 'gemini-2.0-flash',
    inputPricePerM: 0.1,
    outputPricePerM: 0.4,
    cachedPricePerM: 0.025,
  },
];
