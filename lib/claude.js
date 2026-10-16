import Anthropic from '@anthropic-ai/sdk';
import { addApiUsage, emptyUsage, finalizeUsage, MODEL } from './cost.js';
import { safeParseJSON } from './json.js';

const MAX_CONTINUATIONS = 4;

export class RefusalError extends Error {}

// Streams the request (long reports would otherwise risk the SDK's HTTP timeout) and
// resumes server-tool turns that come back with stop_reason "pause_turn", by re-sending the
// paused assistant content unchanged. Returns every content block across continuations,
// the final text, and usage/cost summed over all requests. `schema` turns on structured
// outputs, which constrains the reply to valid JSON matching that JSON schema.
export async function runClaude(client, { system, messages, maxTokens, tools, schema }) {
  const usage = emptyUsage();
  const assistantSoFar = [];
  let final;

  for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
    const convo = assistantSoFar.length
      ? [...messages, { role: 'assistant', content: assistantSoFar }]
      : messages;
    const params = { model: MODEL, max_tokens: maxTokens, system, messages: convo };
    if (tools) params.tools = tools;
    if (schema) params.output_config = { format: { type: 'json_schema', schema } };

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

// runClaude for endpoints that need a JSON object back. Returns the runClaude result plus
// `data`, the parsed object. If the reply still can't be parsed after repair, asks once
// more (a fresh sample almost always comes back clean) before giving up. If the API rejects
// the structured-output schema itself, falls back to prompt-only JSON rather than failing.
export async function runClaudeJSON(client, opts) {
  const usage = emptyUsage();
  let schema = opts.schema;
  let lastError;

  for (let attempt = 0; attempt < 2; attempt++) {
    let result;
    try {
      result = await runClaude(client, { ...opts, schema });
    } catch (err) {
      if (schema && err instanceof Anthropic.BadRequestError && /output_config|schema|format/i.test(err.message)) {
        console.error('Structured output rejected, retrying without it:', err.message);
        schema = undefined;
        attempt--;
        continue;
      }
      throw err;
    }
    addUsage(usage, result.usage);
    if (!result.text.trim()) {
      lastError = new Error('Empty response from Claude');
      continue;
    }
    try {
      return { ...result, data: safeParseJSON(result.text), usage: finalizeUsage(usage) };
    } catch (err) {
      console.error(`Malformed JSON from Claude (attempt ${attempt + 1}, stop_reason ${result.stopReason}):`, err.message);
      lastError = err;
    }
  }
  throw new Error(`The AI's response couldn't be read (${lastError.message}). Please try again.`);
}

function addUsage(total, u) {
  for (const k of Object.keys(total)) total[k] += u[k] || 0;
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
