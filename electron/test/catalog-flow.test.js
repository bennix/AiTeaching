const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLanServer } = require('../server');
const { JsonStore } = require('../lib/store');

test('roster imported after lesson links only unique pending classes, never detached or ambiguous lessons', () => {
  const store = new JsonStore(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-pending-')));
  store.addLessons([{ id: 'before-roster', courseName: 'Python 程序设计', classNames: [] }]);
  assert.equal(store.getLesson('before-roster').classAssociation, 'pending');
  store.upsertStudents([{ studentId: 'A', name: '甲', courseName: 'Python程序设计', className: '一班' }]);
  assert.deepEqual(store.getLesson('before-roster').classNames, ['一班']);
  store.upsertStudent({ studentId: 'B', name: '乙', courseName: 'Python程序设计', className: '二班' });
  assert.deepEqual(store.getLesson('before-roster').classNames, ['一班']);
  store.deleteClass('Python程序设计', '一班');
  assert.equal(store.getLesson('before-roster').classAssociation, 'detached');
  store.upsertStudent({ studentId: 'C', name: '丙', courseName: 'Python程序设计', className: '二班' });
  assert.deepEqual(store.getLesson('before-roster').classNames, []);
  store.addLessons([{ id: 'ambiguous', courseName: '数学', classNames: [] }]);
  store.upsertStudents([
    { studentId: 'M1', name: '甲', courseName: '数学', className: '一班' },
    { studentId: 'M2', name: '乙', courseName: '数学', className: '二班' },
  ]);
  assert.deepEqual(store.getLesson('ambiguous').classNames, []);
  assert.equal(store.getLesson('ambiguous').classAssociation, 'pending');
});

test('roster establishes catalog before lesson generation; explicit links control student content', async (t) => {
  const server = await createLanServer({ runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-flow-')), rendererDir: path.join(__dirname, '../renderer'), preferredPort: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const request = async (route, options = {}) => {
    const response = await fetch(base + route, options);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const admin = await request('/api/auth/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin' }) });
  const headers = { Cookie: admin.cookie, 'Content-Type': 'application/json' };
  server.store.upsertStudent({ studentId: 'P1', name: '测试', courseName: 'Python程序设计', className: '教学班 AIB110002.02' });
  const catalog = await request('/api/public/courses');
  assert.equal(catalog.body.courses.length, 1);
  const login = await request('/api/auth/student', { method: 'POST', headers, body: JSON.stringify({ studentId: 'P1', courseId: catalog.body.courses[0].id }) });
  const studentHeaders = { Cookie: login.cookie };
  assert.deepEqual((await request('/api/student/state', { headers: studentHeaders })).body.lessons, []);
  server.store.addLessons([{ id: 'python', title: 'Python 第1周', courseName: 'Python 程序设计', className: '', classNames: [], aiResult: '已完成方案', status: 'done', createdAt: '2026-09-07' }]);
  server.store.addExercises([{ id: 'published', lessonId: 'python', published: true }, { id: 'draft', lessonId: 'python', published: false }]);
  server.store.state.materials.push({ id: 'slides', lessonId: 'python', type: 'ai_generated', markdown: '# 测试课件' });
  assert.deepEqual((await request('/api/student/state', { headers: studentHeaders })).body.lessons, []);
  const linked = await request('/api/lessons/python/classes', { method: 'PUT', headers, body: JSON.stringify({ classNames: ['教学班 AIB110002.02'] }) });
  assert.equal(linked.status, 200);
  let state = (await request('/api/student/state', { headers: studentHeaders })).body;
  assert.deepEqual(state.lessons.map((x) => x.id), ['python']);
  assert.deepEqual(state.exercises.map((x) => x.id), ['published']);
  assert.deepEqual(state.materials.map((x) => x.id), ['slides']);
  server.store.updateLesson('python', { status: 'processing', processingStage: 'exercises' });
  state = (await request('/api/student/state', { headers: studentHeaders })).body;
  assert.equal(state.lessons.length, 1, 'regenerating exercises must not hide the completed teaching plan');
  for (const classNames of [[], ['别的课程的班级']]) {
    assert.equal((await request('/api/lessons/python/classes', { method: 'PUT', headers, body: JSON.stringify({ classNames }) })).status, 400);
    assert.deepEqual(server.store.getLesson('python').classNames, ['教学班 AIB110002.02']);
  }
  await request('/api/classes/delete', { method: 'POST', headers, body: JSON.stringify({ courseName: 'Python程序设计', className: '教学班 AIB110002.02' }) });
  assert.deepEqual((await request('/api/public/courses')).body.courses, []);
});

test('lesson import associates the only matching class and requests a choice when ambiguous', async (t) => {
  const server = await createLanServer({ runtimeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-import-')), rendererDir: path.join(__dirname, '../renderer'), preferredPort: 0 });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const login = await fetch(base + '/api/auth/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"admin"}' });
  const Cookie = login.headers.get('set-cookie').split(';')[0];
  server.store.upsertStudent({ studentId: 'P1', name: '测试1', courseName: 'Python程序设计', className: '一班' });
  const importLesson = () => {
    const form = new FormData();
    form.set('courseName', 'Python 程序设计'); form.set('classNames', '[]'); form.set('scope', 'week'); form.set('weekNumber', '1'); form.set('startDate', '2026-09-07');
    form.set('lessonFile', new Blob(['# 变量']), '教案.md');
    return fetch(base + '/api/import', { method: 'POST', headers: { Cookie }, body: form });
  };
  assert.equal((await importLesson()).status, 201);
  assert.deepEqual(server.store.state.lessons[0].classNames, ['一班']);
  server.store.upsertStudent({ studentId: 'P2', name: '测试2', courseName: 'Python程序设计', className: '二班' });
  const ambiguous = await importLesson();
  assert.equal(ambiguous.status, 400);
  assert.match((await ambiguous.json()).error, /多个班级/);
  assert.equal(server.store.state.lessons.length, 1);
});
