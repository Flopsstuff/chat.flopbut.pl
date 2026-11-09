import type { ProviderMetadata } from 'ai';

// Anthropic's API reports tokens, not dollars, so the price of an answer is worked out here from
// the published list (https://platform.claude.com/docs/en/about-claude/pricing), in dollars per
// million tokens. A model missing from the list stops the server at start, since every answer
// draws on the allowance by its price.

export type Price = {
  input: number;
  /** Writing to the cache for five minutes, and for an hour. */
  write5m: number;
  write1h: number;
  /** Reading from the cache. */
  read: number;
  output: number;
};

/** Prices by model; a model priced by prompt length lists the dearer tier `above` that size. */
export type ModelPrice = Price & { above?: { tokens: number; price: Price } };

export const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  'claude-haiku-5-5': {
    input: 0.1,
    write5m: 0.125,
    write1h: 0.2,
    read: 0.01,
    output: 0.5,
    // A prompt over 100K tokens, cache reads and writes included, is priced whole at this tier.
    above: {
      tokens: 100_000,
      price: { input: 0.5, write5m: 0.625, write1h: 1, read: 0.05, output: 2.5 },
    },
  },
  'claude-sonnet-5-5': { input: 2, write5m: 2.5, write1h: 4, read: 0.1, output: 10 },
  'claude-opus-5-5': { input: 4, write5m: 5, write1h: 8, read: 0.2, output: 20 },
  'claude-fable-5-1': { input: 10, write5m: 12.5, write1h: 20, read: 0.25, output: 50 },
};

const count = (value: unknown) => (typeof value === 'number' && value > 0 ? value : 0);

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * The cost of one model call from the usage Anthropic returned with it (the provider passes it
 * on as providerMetadata.anthropic.usage): uncached input, cache writes by how long they live,
 * cache reads and output, each at its own price.
 */
export function anthropicCost(
  model: ModelPrice,
  metadata: ProviderMetadata | undefined,
): number | undefined {
  const usage = record(metadata?.anthropic?.usage);
  if (!usage) return undefined;
  const input = count(usage.input_tokens);
  const read = count(usage.cache_read_input_tokens);
  const written = count(usage.cache_creation_input_tokens);
  const split = record(usage.cache_creation);
  const write5m = count(split?.ephemeral_5m_input_tokens);
  let write1h = count(split?.ephemeral_1h_input_tokens);
  // Without the split, the writes are counted at the dearer, hour-long price.
  if (write5m + write1h < written) write1h = written - write5m;
  const output = count(usage.output_tokens);

  const prompt = input + read + write5m + write1h;
  const price = model.above && prompt > model.above.tokens ? model.above.price : model;
  return (
    (input * price.input +
      write5m * price.write5m +
      write1h * price.write1h +
      read * price.read +
      output * price.output) /
    1_000_000
  );
}
