const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLanServer, parseRosterRows } = require('../server');

async function json(url, options = {}) {
  const response = await fetch(url, options);
  return { response, body: await response.json() };
}

test('识别学校上课点名表中的课程、教学班与学生字段', () => {
  const roster = parseRosterRows([
    ['上课点名表(2026-2027学年1学期)'],
    ['序号：CS30047.01  课程名称：计算机可视化  开课院系：计算与智能创新学院  授课教师：徐老师  是否包含A+成绩：否'],
    ['上课时间地点：1~16周 星期三 1~2节', '', '选课总人数：2'],
    ['序号', '学号', '姓名', '专业', '管理院系', '性别', '是否允许P/NP'],
    [1, '22307110055', '学生甲', '计算机科学与技术', '计算与智能创新学院', '男', '是'],
    [2, '2580XH10083', '学生乙', '人工智能', '计算与智能创新学院', '女', '是'],
    [null, null, null],
    ['备注：学号规则'],
  ]);
  assert.equal(roster.courseName, '计算机可视化');
  assert.equal(roster.className, '教学班 CS30047.01');
  assert.equal(roster.courseCode, 'CS30047.01');
  assert.equal(roster.term, '2026-2027学年1学期');
  assert.equal(roster.expectedCount, 2);
  assert.deepEqual(roster.students.map((item) => [item.studentId, item.name, item.major, item.department, item.gender]), [
    ['22307110055', '学生甲', '计算机科学与技术', '计算与智能创新学院', '男'],
    ['2580XH10083', '学生乙', '人工智能', '计算与智能创新学院', '女'],
  ]);
});

test('选课单一键建立班级，教案与课件可关联多个班级', async (context) => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-roster-'));
  const rendererDir = path.join(__dirname, '..', 'renderer');
  const server = await createLanServer({ runtimeDir, rendererDir, preferredPort: 0 });
  context.after(() => server.close());
  const base = `http://127.0.0.1:${server.port}`;
  const login = await json(`${base}/api/auth/admin`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'admin' }),
  });
  const cookie = login.response.headers.get('set-cookie').split(';')[0];
  const csv = [
    '上课点名表(2026-2027学年1学期)',
    '序号：MATH001.01  课程名称：高一数学  开课院系：数学学院  授课教师：教师甲  是否包含A+成绩：否',
    '选课总人数：2',
    '序号,学号,姓名,专业,管理院系,性别',
    '1,S001,学生甲,数学,数学学院,女',
    '2,S002,学生乙,数学,数学学院,男',
  ].join('\n');
  const rosterForm = new FormData();
  rosterForm.set('rosterFile', new Blob([csv], { type: 'text/csv' }), '高一数学选课单.csv');
  const imported = await json(`${base}/api/students/import`, { method: 'POST', headers: { Cookie: cookie }, body: rosterForm });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.body.className, '教学班 MATH001.01');
  assert.deepEqual([imported.body.count, imported.body.added, imported.body.updated], [2, 2, 0]);

  server.store.upsertStudent({ studentId: 'S003', name: '学生丙', courseName: '高一数学', className: '教学班 MATH001.02' });
  const lessonForm = new FormData();
  lessonForm.set('scope', 'week');
  lessonForm.set('courseName', '高一数学');
  lessonForm.set('classNames', JSON.stringify(['教学班 MATH001.01', '教学班 MATH001.02']));
  lessonForm.set('startDate', '2026-09-01');
  lessonForm.set('weekNumber', '1');
  lessonForm.set('lessonFile', new Blob(['# 集合'], { type: 'text/markdown' }), '第一周.md');
  const lessonImport = await json(`${base}/api/import`, { method: 'POST', headers: { Cookie: cookie }, body: lessonForm });
  const lesson = server.store.getLesson(lessonImport.body.lessonIds[0]);
  assert.deepEqual(lesson.classNames, ['教学班 MATH001.01', '教学班 MATH001.02']);
  server.store.updateLesson(lesson.id, { status: 'done', aiResult: '集合的概念' });

  const catalog = await json(`${base}/api/public/courses`);
  assert.deepEqual(catalog.body.courses.map((item) => item.className), ['教学班 MATH001.01', '教学班 MATH001.02']);
  const firstCourse = catalog.body.courses.find((item) => item.className === '教学班 MATH001.01');
  const studentLogin = await json(`${base}/api/auth/student`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ studentId: 'S001', className: '教学班 MATH001.01', courseId: firstCourse.id }),
  });
  const studentCookie = studentLogin.response.headers.get('set-cookie').split(';')[0];
  const studentState = await json(`${base}/api/student/state`, { headers: { Cookie: studentCookie } });
  assert.deepEqual(studentState.body.lessons.map((item) => item.id), [lesson.id]);
});
