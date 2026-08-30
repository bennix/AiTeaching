const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../lib/store');
const { buildLessonRecords } = require('../lib/documents');
const { processLessons } = require('../server');

test('semester import persists a sequential queue and passes completed weeks into each later plan', async (context) => {
  let weeklyConcurrent = 0;
  let maxWeeklyConcurrent = 0;
  const weeklyPrompts = [];
  const aiServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages?.at(-1)?.content || '';
    const weekly = !prompt.includes('exercises 数组');
    if (weekly) {
      weeklyConcurrent += 1;
      maxWeeklyConcurrent = Math.max(maxWeeklyConcurrent, weeklyConcurrent);
      weeklyPrompts.push(prompt);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    const week = /第 (\d+)\/\d+ 教学周/.exec(prompt)?.[1] || '';
    const exerciseType = /允许的题型仅限：([^（]+)/.exec(prompt)?.[1] || 'choice';
    const exerciseCount = Number(/恰好 (\d+) 道/.exec(prompt)?.[1] || 0);
    const content = weekly ? `# 第 ${week} 周已整理方案` : JSON.stringify(Array.from({ length: exerciseCount }, (_, index) => ({
      type: exerciseType, question: `题目 ${index + 1}`, answer: '答案', difficulty: 'medium', knowledgePoint: '知识点',
    })));
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
    if (weekly) weeklyConcurrent -= 1;
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  context.after(() => aiServer.close());

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-processing-'));
  const store = new JsonStore(runtimeDir);
  store.updateSettings({
    baseUrl: `http://127.0.0.1:${aiServer.address().port}`,
    model: 'test-model',
    apiKey: 'test-key',
  });
  const lessons = buildLessonRecords({
    text: '# 第1周 导论\n内容一\n# 第2周 函数\n内容二\n# 第3周 数组\n内容三\n# 第4周 综合\n内容四',
    filename: '整学期教案.md', scope: 'semester', courseName: '程序设计', className: '一班',
    startDate: '2026-09-01', totalWeeks: 4,
  });
  store.addLessons(lessons);

  const liveUpdates = [];
  const processing = processLessons(store, lessons.map((item) => item.id), {
    onUpdate: (update) => liveUpdates.push(JSON.parse(JSON.stringify(update))),
  });
  assert.deepEqual(store.state.lessons.map((item) => item.status), ['processing', 'queued', 'queued', 'queued']);
  await processing;
  assert.deepEqual(store.state.lessons.map((item) => item.status), ['done', 'done', 'done', 'done']);
  assert.equal(maxWeeklyConcurrent, 1);
  assert.equal(weeklyPrompts.length, 4);
  assert.match(weeklyPrompts[1], /第 1 周已整理方案/);
  assert.match(weeklyPrompts[3], /第 1 周已整理方案/);
  assert.match(weeklyPrompts[3], /第 3 周已整理方案/);
  const exerciseUpdates = liveUpdates.filter((item) => item.processingStage === 'exercises' && item.exercises?.length);
  assert.ok(exerciseUpdates.some((item) => item.exercises.length === 4));
  assert.ok(exerciseUpdates.some((item) => item.exercises.length === 6));
  assert.ok(exerciseUpdates.some((item) => item.exerciseProgress?.type === 'short_answer'));
});

test('exercise network failure preserves the completed plan and does not block later weeks', async (context) => {
  let exerciseRequests = 0;
  const aiServer = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const prompt = body.messages?.at(-1)?.content || '';
    if (prompt.includes('exercises 数组')) {
      exerciseRequests += 1;
      request.socket.destroy();
      return;
    }
    const week = /第 (\d+)\/\d+ 教学周/.exec(prompt)?.[1] || '';
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: `# 第 ${week} 周已整理方案` } }] }));
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  context.after(() => aiServer.close());

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-processing-network-'));
  const store = new JsonStore(runtimeDir);
  store.updateSettings({ baseUrl: `http://127.0.0.1:${aiServer.address().port}`, model: 'test-model', apiKey: 'test-key' });
  const lessons = buildLessonRecords({
    text: '# 第1周 导论\n内容一\n# 第2周 函数\n内容二', filename: '两周教案.md', scope: 'semester',
    courseName: '数学', className: '一班', startDate: '2026-09-01', totalWeeks: 2,
  });
  store.addLessons(lessons);

  await processLessons(store, lessons.map((item) => item.id));
  assert.deepEqual(store.state.lessons.map((item) => item.status), ['done', 'done']);
  assert.ok(store.state.lessons.every((item) => item.planCompletedAt));
  assert.ok(store.state.lessons.every((item) => /题库生成暂时中断/.test(item.warning)));
  assert.ok(store.state.lessons.every((item) => /无法连接 AI 服务/.test(item.warning)));
  assert.equal(exerciseRequests, 6);
});
