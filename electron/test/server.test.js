const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLanServer } = require('../server');

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('教师和学生通过同一局域网服务完成导入、签到和选择题提交', async (context) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-server-'));
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const server = await createLanServer({ runtimeDir, rendererDir, preferredPort: 0 });
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;

  const denied = await json(`${base}/api/state`);
  assert.equal(denied.response.status, 401);
  const login = await json(`${base}/api/auth/admin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin' }) });
  const adminCookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.equal(login.body.role, 'admin');

  await json(`${base}/api/students`, { method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: 'S001', name: '测试学生', courseName: '程序设计', className: '一班' }) });
  const form = new FormData();
  form.set('scope', 'week'); form.set('courseName', '程序设计'); form.set('className', '一班'); form.set('startDate', '2026-09-01'); form.set('weekNumber', '1');
  form.set('lessonFile', new Blob(['# 变量与类型\n学习变量、数值和字符串。'], { type: 'text/markdown' }), '第一周.md');
  const imported = await json(`${base}/api/import`, { method: 'POST', headers: { Cookie: adminCookie }, body: form });
  assert.equal(imported.body.count, 1);
  const lessonId = imported.body.lessonIds[0];
  server.store.updateLesson(lessonId, { status: 'done', aiResult: '本周学习变量。' });
  server.store.addExercises([{ id: crypto.randomUUID(), lessonId, published: true, targetStudentId: null, type: 'choice', question: 'Python 变量如何赋值？\nA. x = 1\nB. 1 = x\nC. var x\nD. let x', answer: 'A', difficulty: 'easy', knowledgePoint: '变量' }]);

  const studentLogin = await json(`${base}/api/auth/student`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: 'S001', className: '一班' }) });
  const studentCookie = studentLogin.response.headers.get('set-cookie').split(';')[0];
  const studentState = await json(`${base}/api/student/state`, { headers: { Cookie: studentCookie } });
  assert.equal(studentState.body.lessons.length, 1);
  const exerciseId = studentState.body.exercises[0].id;
  const attendance = await json(`${base}/api/student/attendance`, { method: 'POST', headers: { Cookie: studentCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ lessonId }) });
  assert.equal(attendance.body.ok, true);
  const submission = await json(`${base}/api/student/submit`, { method: 'POST', headers: { Cookie: studentCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ exerciseId, answer: 'A' }) });
  assert.equal(submission.body.submission.correct, true);
});
