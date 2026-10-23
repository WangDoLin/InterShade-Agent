import { ModelResolver } from '../../providers/catalog/ModelResolver.js';

/**
 * Calculates token cost in USD using the unified ModelCatalogStore pricing table (CAT-020),
 * with deterministic fallback heuristics for custom or local models.
 */
export function calculateModelCost(inputTokens: number, outputTokens: number, model: string): number {
  const catalogPricing = ModelResolver.resolvePricing(model);
  if (catalogPricing) {
    return (
      (inputTokens / 1_000_000) * catalogPricing.inputPer1MUsd +
      (outputTokens / 1_000_000) * catalogPricing.outputPer1MUsd
    );
  }

  const m = model.toLowerCase();
  let inputRatePerM = 3.0;
  let outputRatePerM = 15.0;

  if (m.includes('gemini-2.5-flash') || m.includes('gemini-1.5-flash')) {
    inputRatePerM = 0.075;
    outputRatePerM = 0.30;
  } else if (m.includes('gemini-2.5-pro') || m.includes('gemini-1.5-pro')) {
    inputRatePerM = 1.25;
    outputRatePerM = 5.00;
  } else if (m.includes('claude-3-5-haiku') || m.includes('claude-3-haiku')) {
    inputRatePerM = 0.80;
    outputRatePerM = 4.00;
  } else if (m.includes('claude')) {
    inputRatePerM = 3.00;
    outputRatePerM = 15.00;
  } else if (m.includes('gpt-4o-mini')) {
    inputRatePerM = 0.15;
    outputRatePerM = 0.60;
  } else if (m.includes('gpt-4o')) {
    inputRatePerM = 2.50;
    outputRatePerM = 10.00;
  } else if (m.includes('deepseek')) {
    inputRatePerM = 0.14;
    outputRatePerM = 0.28;
  } else if (m.includes('llama') || m.includes('qwen') || m.includes('local') || m.includes('ollama')) {
    inputRatePerM = 0.00;
    outputRatePerM = 0.00;
  }

  return (inputTokens / 1_000_000) * inputRatePerM + (outputTokens / 1_000_000) * outputRatePerM;
}
