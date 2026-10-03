import { addApiUsage, emptyUsage, finalizeUsage, MODEL } from './cost.js';

const MAX_CONTINUATIONS = 4;

export class RefusalError extends Error {}

// Streams the request (long reports would otherwise risk the SDK's HTTP timeout) and
// resumes server-tool turns that come back with stop_reason "pause_turn", by re-sending the
// paused assistant content unchanged. Returns every content block across continuations,
// the final text, and usage/cost summed over all requests.
export async function runClaude(client, { system, messages, maxTokens, tools }) {
  const usage = emptyUsage();
  const assistantSoFar = [];
  let final;

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const convo = assistantSoFar.length
      ? [...messages, { role: 'assistant', content: assistantSoFar }]
      : messages;
    const params = { model: MODEL, max_tokens: maxTokens, system, messages: convo };
    if (tools) params.tools = tools;

    final = await client.messages.stream(params).finalMessage();
    addApiUsage(usage, final.usage);
    assistantSoFar.push(...final.content);
    if (final.stop_reason !== 'pause_turn') break;
  }

  if (final.stop_reason === 'refusal') {
    throw new RefusalError('The AI declined to generate this content. Try rephrasing the brief or regenerating with different notes.');
  }

  return {
    content: assistantSoFar,
    text: finalText(assistantSoFar),
    stopReason: final.stop_reason,
    usage: finalizeUsage(usage),
  };
}

// Text written after the last tool interaction — i.e. the model's final answer, without
// any "Let me search for..." narration that preceded its searches.
export function finalText(blocks) {
  let lastNonText = -1;
  blocks.forEach((b, i) => { if (b.type !== 'text' && b.type !== 'thinking' && b.type !== 'redacted_thinking') lastNonText = i; });
  return blocks
    .slice(lastNonText + 1)
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}
