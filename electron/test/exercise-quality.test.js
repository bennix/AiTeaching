const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { choiceQuestionQuality, exerciseQuestionKey, parseChoiceOptions, repairRepeatedChoiceOptions } = require('../lib/exercise-quality');
const { generateExercisesForBlueprint, parseGeneratedExercises } = require('../lib/ai');

test('choice quality rejects a repeated A-D block before storage', () => {
  const block = 'A. 甲\nB. 乙\nC. 丙\nD. 丁';
  const exercise = { type: 'choice', question: `选择正确答案。\n${block}\n${block}`, answer: 'B' };
  const quality = choiceQuestionQuality(exercise);
  assert.equal(quality.valid, false);
  assert.equal(parseChoiceOptions(exercise.question).length, 8);
  assert.match(quality.reasons.join('；'), /恰好|必须且只能/);
  assert.deepEqual(parseGeneratedExercises(JSON.stringify([exercise]), { types: ['choice'], count: 1, difficulty: 'medium' }), []);
  const repaired = repairRepeatedChoiceOptions(exercise.question);
  assert.equal(parseChoiceOptions(repaired).length, 4);
  assert.equal(choiceQuestionQuality({ ...exercise, question: repaired }).valid, true);
});

test('choice quality preserves meaningful mathematical bracket differences', () => {
  const exercise = {
    type: 'choice',
    question: '不等式的解集为（ ）\nA. (−∞,−3)∪[4,+∞)\nB. (−∞,−3]∪[4,+∞)\nC. (−3,4]\nD. (−∞,−3)∪(4,+∞)',
    answer: 'A',
  };
  assert.equal(choiceQuestionQuality(exercise).valid, true);
  assert.equal(repairRepeatedChoiceOptions(exercise.question), exercise.question);
  assert.equal(choiceQuestionQuality({
    type: 'choice', question: '选择。\nA. 相同内容\nB. 相同内容\nC. 丙\nD. 丁', answer: 'A',
  }).valid, false);
});

test('question identity ignores layout whitespace but keeps mathematical symbols', () => {
  assert.equal(exerciseQuestionKey('求 x 的值。\nA. 1\nB. 2\nC. 3\nD. 4'), exerciseQuestionKey('求x的值。\nA. 5\nB. 6\nC. 7\nD. 8'));
  assert.notEqual(exerciseQuestionKey('解集为 (0,1)'), exerciseQuestionKey('解集为 [0,1]'));
});

test('blueprint rejects invalid and existing duplicate questions, then retries', async (context) => {
  let calls = 0;
  let lastPrompt = '';
  const server = http.createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    lastPrompt = body.messages[0].content;
    calls += 1;
    const block = 'A. 甲\nB. 乙\nC. 丙\nD. 丁';
    const question = calls === 1
      ? `无效题\n${block}\n${block}`
      : `${calls === 2 ? '已有题' : '有效题'}\nA. 甲\nB. 乙\nC. 丙\nD. 丁`;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ type: 'choice', question, answer: 'A' }]) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => server.close());

  const result = await generateExercisesForBlueprint({
    baseUrl: `http://127.0.0.1:${server.address().port}`, apiKey: 'test', model: 'mock',
  }, { courseName: '通识课程', teachingWeek: 1, aiResult: '教学内容' }, {
    typeConfigs: [{ type: 'choice', count: 1, difficulty: 'medium' }],
  }, { excludeQuestions: ['已有题\nA. 一\nB. 二\nC. 三\nD. 四'] });
  assert.equal(calls, 3);
  assert.equal(result.length, 1);
  assert.match(result[0].question, /有效题/);
  assert.match(lastPrompt, /不得把整组 A-D 选项重复输出/);
});
