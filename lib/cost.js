// USD per million tokens. Source: Anthropic pricing for claude-sonnet-5 (input $2,
// output $10, 5-minute cache writes $2.50, cache reads $0.20); web search $10 / 1,000.
export const MODEL = 'claude-sonnet-5';
export const PRICING = {
  'claude-sonnet-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
};
export const WEB_SEARCH_USD = 10 / 1000;

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, webSearches: 0 };
}

export function addApiUsage(total, apiUsage) {
  if (!apiUsage) return total;
  total.inputTokens += apiUsage.input_tokens || 0;
  total.outputTokens += apiUsage.output_tokens || 0;
  total.cacheCreationTokens += apiUsage.cache_creation_input_tokens || 0;
  total.cacheReadTokens += apiUsage.cache_read_input_tokens || 0;
  total.webSearches += apiUsage.server_tool_use?.web_search_requests || 0;
  return total;
}

export function usageCostUSD(usage, model = MODEL) {
  const p = PRICING[model] || PRICING[MODEL];
  const tokensUSD =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      usage.cacheCreationTokens * p.cacheWrite +
      usage.cacheReadTokens * p.cacheRead) / 1_000_000;
  return tokensUSD + usage.webSearches * WEB_SEARCH_USD;
}

export function finalizeUsage(usage, model = MODEL) {
  return { ...usage, model, usd: Math.round(usageCostUSD(usage, model) * 10000) / 10000 };
}
