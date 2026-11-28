export const ANTHROPIC_PRICING_URL = 'https://platform.claude.com/docs/en/about-claude/pricing#model-pricing';

// Standard Claude API rates in USD per million tokens, checked 2026-11-25.
// Keys are exact Claude API model IDs and documented aliases.
const haiku45 = [1, 5];
const baseRates = new Map([
  ['claude-fable-5-2', [8, 40]],
  ['claude-opus-5-5', [4, 20]],
  ['claude-sonnet-5-5', [2, 10]],
  ['claude-haiku-5-5', [0.10, 0.50]],
  ['claude-fable-5-1', [10, 50]],
  ['claude-fable-5', [10, 50]],
  ['claude-opus-5', [5, 25]],
  ['claude-sonnet-5', [2, 10]],
  ['claude-opus-4-8', [5, 25]],
  ['claude-opus-4-7', [5, 25]],
  ['claude-opus-4-6', [5, 25]],
  ['claude-sonnet-4-6', [3, 15]],
  ['claude-haiku-4-5', haiku45],
  ['claude-haiku-4-5-20251001', haiku45],
]);

const usd = amount => `$${Number.isInteger(amount) ? amount : amount.toFixed(2)}`;

export function anthropicModelPriceLabel(modelId) {
  const rate = baseRates.get(modelId);
  if (!rate) return '';
  const [input, output] = rate;
  if (modelId === 'claude-haiku-5-5') {
    // Anthropic applies the higher rate to requests over 100k prompt tokens.
    return `${usd(input)}–${usd(0.50)} in / ${usd(output)}–${usd(2.50)} out`;
  }
  return `${usd(input)} in / ${usd(output)} out`;
}
