const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generateExercises } = require('../lib/ai');

test('exercise prompt keeps non-programming subjects free of forced Debug scenarios', async (context) => {
  let prompt = '';
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    prompt = JSON.parse(Buffer.concat(chunks).toString('utf8')).messages[0].content;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '[{"type":"application","question":"分析一次函数的实际应用","answer":"略","difficulty":"medium","knowledgePoint":"一次函数"}]' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());

  const exercises = await generateExercises({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test', apiKey: 'key' }, {
    courseName: '高一数学', teachingWeek: 3, aiResult: '一次函数的图像与应用。',
  }, { types: ['application'], count: 1, difficulty: 'medium' });
  assert.match(prompt, /除非课程名称或教学内容明确属于编程/);
  assert.match(prompt, /禁止出现代码、Debug、调试程序/);
  assert.equal(exercises[0].type, 'application');
});

test('exercise generation accepts content blocks, object wrappers and Chinese fields', async (context) => {
  const server = http.createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: `\`\`\`json
{"questions":[{"题目":"集合 A 的补集是什么？","选项":{"A":"A 本身","B":"全集中不属于 A 的元素","C":"空集","D":"全集"},"答案":"B","解析":"B 是全集中不属于 A 的元素，也就是被"翻色"的部分。\n依据补集定义。","难度":"困难","知识点":"补集"},],}
\`\`\`` }] } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());

  const exercises = await generateExercises({ baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'test', apiKey: 'key' }, {
    courseName: '高一数学', teachingWeek: 1, aiResult: '集合与补集。',
  }, { types: ['choice'], count: 1, difficulty: 'hard' });
  assert.equal(exercises.length, 1);
  assert.equal(exercises[0].type, 'choice');
  assert.match(exercises[0].question, /A\. A 本身/);
  assert.equal(exercises[0].answer, 'B');
  assert.equal(exercises[0].knowledgePoint, '补集');
  assert.match(exercises[0].explanation, /被"翻色"的部分/);
});
