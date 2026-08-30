const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
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
  form.set('exerciseMode', 'uniform'); form.set('exercise_choice_count', '3'); form.set('exercise_choice_difficulty', 'easy');
  form.set('exercise_short_answer_count', '2'); form.set('exercise_short_answer_difficulty', 'medium');
  form.set('exercise_application_count', '1'); form.set('exercise_application_difficulty', 'hard');
  form.set('lessonFile', new Blob(['# 变量与类型\n学习变量、数值和字符串。'], { type: 'text/markdown' }), '第一周.md');
  const imported = await json(`${base}/api/import`, { method: 'POST', headers: { Cookie: adminCookie }, body: form });
  assert.equal(imported.body.count, 1);
  const lessonId = imported.body.lessonIds[0];
  const importedLesson = server.store.getLesson(lessonId);
  assert.equal(importedLesson.sourceFilename, '第一周.md');
  assert.deepEqual(importedLesson.exerciseOptions.typeConfigs, [
    { type: 'choice', count: 3, difficulty: 'easy' },
    { type: 'short_answer', count: 2, difficulty: 'medium' },
    { type: 'application', count: 1, difficulty: 'hard' },
  ]);
  server.store.updateLesson(lessonId, { status: 'done', aiResult: '本周学习变量与公式 $x=1$。' });
  server.store.addExercises([{ id: crypto.randomUUID(), lessonId, published: true, targetStudentId: null, type: 'choice', question: 'Python 变量如何赋值？\nA. x = 1\nB. 1 = x\nC. var x\nD. let x', answer: 'A', explanation: '赋值语句把右侧数值保存到左侧变量。', difficulty: 'easy', knowledgePoint: '变量' }]);

  const firstCourseware = await json(`${base}/api/lessons/${lessonId}/courseware`, { method: 'POST', headers: { Cookie: adminCookie } });
  const firstPath = server.store.state.materials.find((item) => item.id === firstCourseware.body.material.id).filePath;
  const secondCourseware = await json(`${base}/api/lessons/${lessonId}/courseware`, { method: 'POST', headers: { Cookie: adminCookie } });
  assert.equal(secondCourseware.body.replaced, 1);
  assert.equal(server.store.state.materials.filter((item) => item.lessonId === lessonId && item.type === 'ai_generated').length, 1);
  assert.equal(fs.existsSync(firstPath), false);
  const materialId = secondCourseware.body.material.id;
  const teacherPreview = await json(`${base}/api/materials/${materialId}/preview`, { headers: { Cookie: adminCookie } });
  assert.match(teacherPreview.body.markdown, /\$x=1\$/);
  const teacherDownload = await fetch(`${base}/api/materials/${materialId}/download`, { headers: { Cookie: adminCookie } });
  assert.match(teacherDownload.headers.get('content-type'), /text\/html/);
  const downloadedCourseware = await teacherDownload.text();
  assert.match(downloadedCourseware, /RichText\.render/);
  assert.match(downloadedCourseware, /本周学习变量与公式/);
  assert.match(downloadedCourseware, /data:font\/woff2;base64,/);
  assert.doesNotMatch(downloadedCourseware, /(?:src|href)="\//);

  const studentLogin = await json(`${base}/api/auth/student`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: 'S001', className: '一班' }) });
  const studentCookie = studentLogin.response.headers.get('set-cookie').split(';')[0];
  const studentState = await json(`${base}/api/student/state`, { headers: { Cookie: studentCookie } });
  assert.equal(studentState.body.lessons.length, 1);
  const studentPreview = await json(`${base}/api/student/material/${materialId}/preview`, { headers: { Cookie: studentCookie } });
  assert.match(studentPreview.body.markdown, /\$x=1\$/);
  const exerciseId = studentState.body.exercises[0].id;
  const attendance = await json(`${base}/api/student/attendance`, { method: 'POST', headers: { Cookie: studentCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ lessonId }) });
  assert.equal(attendance.body.ok, true);
  const submission = await json(`${base}/api/student/submit`, { method: 'POST', headers: { Cookie: studentCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ exerciseId, answer: 'A' }) });
  assert.equal(submission.body.submission.correct, true);
  assert.match(submission.body.submission.feedback, /判定理由/);
  assert.match(submission.body.submission.feedback, /正确思路/);

  const deleted = await json(`${base}/api/lessons/batch-delete`, { method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [lessonId] }) });
  assert.equal(deleted.body.deleted, 1);
  assert.equal(server.store.state.lessons.length, 0);
  assert.equal(server.store.state.exercises.length, 0);
  assert.equal(server.store.state.submissions.length, 0);
});

test('学生可以选择已有课程并只读取所选课程的资料与已发放习题', async (context) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-student-courses-'));
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const server = await createLanServer({ runtimeDir, rendererDir, preferredPort: 0 });
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  server.store.upsertStudent({ studentId: 'S002', name: '跨课程学生', courseName: '旧课程', className: '学生行政班' });
  const lessons = [
    { id: 'math-lesson', title: '高一数学 · 第 1 周', courseName: '高一数学', className: '数学测试班', teachingWeek: 1, totalWeeks: 15, date: '2026-09-01', status: 'done', aiResult: '集合与函数', createdAt: '2026-09-01T00:00:00.000Z' },
    { id: 'english-lesson', title: '高一英语 · 第 1 周', courseName: '高一英语', className: '英语测试班', teachingWeek: 1, totalWeeks: 15, date: '2026-09-01', status: 'done', aiResult: 'Vocabulary', createdAt: '2026-09-01T00:00:00.000Z' },
  ];
  server.store.addLessons(lessons);
  server.store.addExercises([
    { id: 'math-exercise', lessonId: 'math-lesson', published: true, targetStudentId: null, type: 'choice', question: '数学题', answer: 'A' },
    { id: 'english-exercise', lessonId: 'english-lesson', published: true, targetStudentId: null, type: 'choice', question: 'English question', answer: 'B' },
  ]);
  const mathPath = path.join(runtimeDir, 'math.md');
  const englishPath = path.join(runtimeDir, 'english.md');
  fs.writeFileSync(mathPath, '# 数学资料');
  fs.writeFileSync(englishPath, '# English material');
  server.store.state.materials.push(
    { id: 'math-material', lessonId: 'math-lesson', filename: '数学资料.md', filePath: mathPath, type: 'manual' },
    { id: 'english-material', lessonId: 'english-lesson', filename: 'English.md', filePath: englishPath, type: 'manual' },
  );
  server.store.save();

  const catalog = await json(`${base}/api/public/courses`);
  assert.deepEqual(catalog.body.courses.map((item) => item.label), ['高一数学 · 数学测试班', '高一英语 · 英语测试班']);
  const math = catalog.body.courses.find((item) => item.courseName === '高一数学');
  const english = catalog.body.courses.find((item) => item.courseName === '高一英语');
  const login = await json(`${base}/api/auth/student`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: 'S002', className: '学生行政班', courseId: math.id }) });
  const studentCookie = login.response.headers.get('set-cookie').split(';')[0];
  const mathState = await json(`${base}/api/student/state`, { headers: { Cookie: studentCookie } });
  assert.equal(mathState.body.selectedCourseId, math.id);
  assert.deepEqual(mathState.body.lessons.map((item) => item.id), ['math-lesson']);
  assert.deepEqual(mathState.body.exercises.map((item) => item.id), ['math-exercise']);
  assert.deepEqual(mathState.body.materials.map((item) => item.id), ['math-material']);

  const switched = await json(`${base}/api/student/course`, { method: 'POST', headers: { Cookie: studentCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId: english.id }) });
  assert.equal(switched.body.selectedCourseId, english.id);
  const englishState = await json(`${base}/api/student/state`, { headers: { Cookie: studentCookie } });
  assert.deepEqual(englishState.body.lessons.map((item) => item.id), ['english-lesson']);
  assert.deepEqual(englishState.body.exercises.map((item) => item.id), ['english-exercise']);
  assert.deepEqual(englishState.body.materials.map((item) => item.id), ['english-material']);
  const crossCourseSubmit = await json(`${base}/api/student/submit`, { method: 'POST', headers: { Cookie: studentCookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ exerciseId: 'math-exercise', answer: 'A' }) });
  assert.equal(crossCourseSubmit.response.status, 400);
});

test('教师可以查看班级学情图表数据并生成可保存的 AI 报告', async (context) => {
  let aiRequest = null;
  const aiServer = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    aiRequest = JSON.parse(body);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message: { content: '# 班级学情报告\n\n函数是当前薄弱知识点。' } }] }));
  });
  await new Promise((resolve) => aiServer.listen(0, '127.0.0.1', resolve));
  context.after(() => aiServer.close());

  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-analytics-'));
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const server = await createLanServer({ runtimeDir, rendererDir, preferredPort: 0 });
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  server.store.updateSettings({
    baseUrl: `http://127.0.0.1:${aiServer.address().port}/v1`, apiKey: 'test-key', model: 'test-model',
  });
  server.store.addLessons([{ id: 'week-1', title: '数学第 1 周', courseName: '数学', teachingWeek: 1, status: 'done' }]);
  server.store.upsertStudent({ studentId: 'S1', name: '甲', courseName: '数学', className: '一班' });
  server.store.addExercises([{ id: 'question-1', lessonId: 'week-1', published: true, type: 'choice', knowledgePoint: '函数' }]);
  server.store.addAttendance({ id: 'attendance-1', lessonId: 'week-1', studentId: 'S1', status: 'present' });
  server.store.addSubmission({ id: 'submission-1', exerciseId: 'question-1', studentId: 'S1', correct: false });

  const login = await json(`${base}/api/auth/admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin' }),
  });
  const adminCookie = login.response.headers.get('set-cookie').split(';')[0];
  const analytics = await json(`${base}/api/analytics?courseName=${encodeURIComponent('数学')}&className=${encodeURIComponent('一班')}`, { headers: { Cookie: adminCookie } });
  assert.equal(analytics.body.summary.attendanceRate, 100);
  assert.equal(analytics.body.summary.completionRate, 100);
  assert.equal(analytics.body.summary.accuracyRate, 0);
  assert.deepEqual(analytics.body.knowledgePoints.map((item) => item.name), ['函数']);

  const generated = await json(`${base}/api/analytics/report`, {
    method: 'POST', headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ courseName: '数学', className: '一班' }),
  });
  assert.equal(generated.body.ok, true);
  assert.match(generated.body.report.markdown, /函数是当前薄弱知识点/);
  assert.equal(server.store.state.classReports.length, 1);
  assert.equal(aiRequest.model, 'test-model');
  assert.match(aiRequest.messages[0].content, /未作答只影响完成率/);

  const refreshed = await json(`${base}/api/analytics?courseName=${encodeURIComponent('数学')}&className=${encodeURIComponent('一班')}`, { headers: { Cookie: adminCookie } });
  assert.match(refreshed.body.latestReport.markdown, /班级学情报告/);
});
