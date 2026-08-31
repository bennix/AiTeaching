const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { fetchModelCatalog, filterTeachingModels } = require('../lib/ai');

test('teaching model filter keeps long-context text chat models and rejects incompatible endpoints', () => {
  const result = filterTeachingModels([
    { id: 'anthropic/claude-sonnet', display_name: 'Claude Sonnet', input_modalities: ['text', 'file'], output_modalities: ['text'], context_length: 200000, capabilities: { reasoning: true } },
    { id: 'vendor/image-maker', input_modalities: ['text'], output_modalities: ['image'], context_length: 128000 },
    { id: 'vendor/text-lite', input_modalities: ['text'], output_modalities: ['text'], context_length: 8192 },
    { id: 'vendor/embed-large', input_modalities: ['text'], output_modalities: ['embedding'], context_length: 128000 },
    { id: 'private/minimal-chat-model' },
  ]);

  assert.deepEqual(result.models.map((item) => item.id), [
    'anthropic/claude-sonnet',
    'private/minimal-chat-model',
  ]);
  assert.equal(result.total, 5);
  assert.equal(result.excluded, 3);
  assert.equal(result.models[0].reasoning, true);
  assert.equal(result.models[0].contextLength, 200000);
});

test('model catalog uses the OpenAI-compatible models endpoint and preserves minimal provider responses', async (context) => {
  let requestedUrl = '';
  const server = http.createServer((request, response) => {
    requestedUrl = request.url;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'private/chat-a' }, { id: 'private/chat-b' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());

  const catalog = await fetchModelCatalog({
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    apiKey: '',
  });
  assert.equal(requestedUrl, '/v1/models');
  assert.deepEqual(catalog.models.map((item) => item.id), ['private/chat-a', 'private/chat-b']);
  assert.equal(catalog.excluded, 0);
});
