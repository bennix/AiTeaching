const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { generateExercises, generateExercisesForBlueprint, gradeAnswer, requiresIndependentExerciseReview } = require('../lib/ai');

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

test('math, physics and chemistry require a distinct exercise review model', async () => {
  assert.equal(requiresIndependentExerciseReview({ courseName: '高一数学' }), true);
  assert.equal(requiresIndependentExerciseReview({ courseName: '大学物理' }), true);
  assert.equal(requiresIndependentExerciseReview({ courseName: '基础化学' }), true);
  assert.equal(requiresIndependentExerciseReview({ courseName: '大学英语' }), false);
  await assert.rejects(() => generateExercises({ baseUrl: 'https://invalid.example', apiKey: 'key', model: 'primary' }, {
    courseName: '高一数学', teachingWeek: 1, aiResult: '集合',
  }, { types: ['choice'], count: 1 }), /指定题目复核模型/);
  await assert.rejects(() => generateExercises({
    baseUrl: 'https://invalid.example', apiKey: 'key', model: 'same', exerciseReviewModel: 'same',
  }, { courseName: '物理', teachingWeek: 1 }, { types: ['choice'], count: 1 }), /必须与主模型不同/);
});

test('independent reviewer rejects unsafe STEM questions before they can be returned for storage', async (context) => {
  const models = [];
  const mock = await mockAi((body) => {
    models.push(body.model);
    if (body.model === 'reviewer') return JSON.stringify({ reviews: [
      { index: 0, approved: true, verifiedAnswer: '$x=2$', reason: '代数法与图像法都得到 x=2' },
      { index: 1, approved: false, verifiedAnswer: '', reason: '题干条件不足，答案不唯一' },
    ] });
    return JSON.stringify({ exercises: [
      { type: 'short_answer', question: '求方程 $x+1=3$ 的解。', answer: '$x=2$', solutionOne: '移项得到 $x=2$。', solutionTwo: '作图求交点得到 $x=2$。', difficulty: 'easy', knowledgePoint: '方程' },
      { type: 'short_answer', question: '求未知量。', answer: '1', solutionOne: '猜测为 1。', solutionTwo: '仍猜测为 1。', difficulty: 'easy', knowledgePoint: '方程' },
    ] });
  });
  context.after(mock.close);
  const result = await generateExercises({
    baseUrl: mock.baseUrl, apiKey: 'test', model: 'primary', exerciseReviewModel: 'reviewer',
  }, { courseName: '高一数学', teachingWeek: 1, aiResult: '一元一次方程' }, {
    types: ['short_answer'], count: 2, difficulty: 'easy',
  });
  assert.deepEqual(models, ['primary', 'reviewer']);
  assert.equal(result.length, 1);
  assert.equal(result[0].question, '求方程 $x+1=3$ 的解。');
  assert.equal(result[0].answer, '$x=2$');
  assert.equal(result[0].reviewedBy, 'reviewer');
  assert.match(result[0].explanation, /解法一/);
  assert.match(result[0].explanation, /解法二/);
  assert.match(result[0].explanation, /独立模型复核/);
});

test('blueprint retries rejected STEM candidates and emits only reviewer-approved questions', async (context) => {
  let primaryCalls = 0;
  let reviewCalls = 0;
  const progressEvents = [];
  const mock = await mockAi((body) => {
    if (body.model === 'reviewer') {
      reviewCalls += 1;
      return JSON.stringify({ reviews: [{
        index: 0, approved: reviewCalls > 1, verifiedAnswer: reviewCalls > 1 ? '42' : '',
        reason: reviewCalls > 1 ? '两种计算路径均得到 42' : '第二种解法不能成立',
      }] });
    }
    primaryCalls += 1;
    return JSON.stringify({ exercises: [{
      type: 'application', question: `候选题 ${primaryCalls}`, answer: '42',
      solutionOne: '由定义直接计算得到 42。', solutionTwo: '代入结果反向检验得到 42。',
      difficulty: 'hard', knowledgePoint: '综合计算',
    }] });
  });
  context.after(mock.close);
  const result = await generateExercisesForBlueprint({
    baseUrl: mock.baseUrl, apiKey: 'test', model: 'primary', exerciseReviewModel: 'reviewer',
  }, { courseName: '物理', teachingWeek: 2, aiResult: '综合计算' }, {
    typeConfigs: [{ type: 'application', count: 1, difficulty: 'hard' }],
  }, { onProgress: (fresh, progress) => progressEvents.push({ questions: fresh.map((item) => item.question), ...progress }) });
  assert.equal(primaryCalls, 2);
  assert.equal(reviewCalls, 2);
  assert.deepEqual(result.map((item) => item.question), ['候选题 2']);
  assert.deepEqual(progressEvents.flatMap((event) => event.questions), ['候选题 2']);
  assert.equal(progressEvents.filter((event) => event.phase === 'reviewing').length, 2);
});
