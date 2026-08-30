const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generateExercisesForBlueprint, gradeAnswer } = require('../lib/ai');

async function mockAi(handler) {
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const content = await handler(JSON.parse(raw || '{}'));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('choice grading locks deterministic correctness while preserving AI explanation', async (context) => {
  const mock = await mockAi(() => JSON.stringify({
    correct: true,
    reason: 'B 把等式方向写反，不能完成变量赋值。',
    correctApproach: '应选择 A，因为赋值目标在左侧。',
    suggestion: '先识别赋值号两侧的角色。',
  }));
  context.after(mock.close);
  const result = await gradeAnswer({ baseUrl: mock.baseUrl, apiKey: 'test', model: 'mock' }, {
    type: 'choice', question: '如何赋值？', answer: 'A', explanation: 'A 是正确赋值语句。',
  }, 'B');
  assert.equal(result.correct, false);
  assert.match(result.feedback, /判定理由/);
  assert.match(result.feedback, /正确思路/);
  assert.match(result.feedback, /改进建议/);
});

test('choice grading without API key returns an immediate local explanation', async () => {
  const result = await gradeAnswer({ baseUrl: 'https://invalid.example', apiKey: '', model: 'mock' }, {
    type: 'choice', question: '如何赋值？', answer: 'A', explanation: 'A 符合变量赋值语法。',
  }, 'A');
  assert.equal(result.correct, true);
  assert.match(result.feedback, /判定理由/);
  assert.match(result.feedback, /A 符合变量赋值语法/);
});

test('exercise generation retries shortages and accepts Chinese type aliases', async (context) => {
  let calls = 0;
  const progressEvents = [];
  const mock = await mockAi(() => {
    calls += 1;
    if (calls === 1) return '[]';
    return JSON.stringify([
      { type: '简答题', question: '说明 $x=1$ 的含义。', answer: '把 1 赋给 x。', explanation: '左侧是变量，右侧是值。', difficulty: 'medium', knowledgePoint: '变量' },
      { type: 'short_answer', question: '变量有什么作用？', answer: '保存并引用数据。', explanation: '变量为数据命名。', difficulty: 'medium', knowledgePoint: '变量' },
    ]);
  });
  context.after(mock.close);
  const result = await generateExercisesForBlueprint({ baseUrl: mock.baseUrl, apiKey: 'test', model: 'mock' }, {
    courseName: '程序设计', teachingWeek: 1, aiResult: '变量与赋值',
  }, { typeConfigs: [{ type: 'short_answer', count: 2, difficulty: 'medium' }] }, {
    onProgress: (fresh, progress) => progressEvents.push({ fresh: fresh.length, ...progress }),
  });
  assert.equal(calls, 2);
  assert.equal(result.length, 2);
  assert.ok(result.every((item) => item.type === 'short_answer'));
  assert.deepEqual(progressEvents.map((item) => [item.fresh, item.actual, item.phase]), [
    [0, 0, 'generating'], [0, 0, 'generating'], [2, 2, 'generating'], [0, 2, 'complete'],
  ]);
});
