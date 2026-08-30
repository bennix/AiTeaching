const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generateWeeklyPlan } = require('../lib/ai');

test('weekly plan consumes compatible SSE output incrementally', async (context) => {
  const server = http.createServer(async (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    response.write('data: {"choices":[{"delta":{"content":"# 本周主题"}}]}\n\n');
    await new Promise((resolve) => setTimeout(resolve, 10));
    response.write('data: {"choices":[{"delta":{"content":"\\n函数与图像"}}]}\n\n');
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());

  const partials = [];
  const result = await generateWeeklyPlan({
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    model: 'test-model', apiKey: 'test-key',
  }, {
    teachingWeek: 2, totalWeeks: 16, courseName: '高一数学', className: '一班',
    rawText: '函数定义与图像。',
  }, { previousPlans: '# 第 1 周\n集合基础', onDelta: (partial) => partials.push(partial) });

  assert.deepEqual(partials, ['# 本周主题', '# 本周主题\n函数与图像']);
  assert.equal(result, '# 本周主题\n函数与图像');
});
