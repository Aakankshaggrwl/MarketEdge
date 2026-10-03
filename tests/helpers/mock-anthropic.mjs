import http from 'node:http';

// A stand-in for api.anthropic.com that speaks the streaming Messages API, so server
// endpoints can be exercised through the real SDK without network access or API spend.
// `respond(body, callIndex)` returns {content, stop_reason, usage} for each request.
export async function startMockAnthropic(respond) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      let msg;
      try {
        msg = await respond(body, requests.length - 1);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } }));
        return;
      }
      if (msg.httpError) {
        res.writeHead(msg.httpError.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: msg.httpError.error }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
      const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...(msg.usage || {}) };
      send('message_start', {
        message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } },
      });
      msg.content.forEach((block, index) => {
        if (block.type === 'text') {
          send('content_block_start', { index, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
          (block.citations || []).forEach(citation => send('content_block_delta', { index, delta: { type: 'citations_delta', citation } }));
        } else if (block.type === 'server_tool_use') {
          send('content_block_start', { index, content_block: { ...block, input: {} } });
          send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
        } else {
          send('content_block_start', { index, content_block: block });
        }
        send('content_block_stop', { index });
      });
      send('message_delta', { delta: { stop_reason: msg.stop_reason || 'end_turn', stop_sequence: null }, usage });
      send('message_stop', {});
      res.end();
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, requests, close: () => new Promise(r => server.close(r)) };
}

export const textMessage = (text, extra = {}) => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn', ...extra });
