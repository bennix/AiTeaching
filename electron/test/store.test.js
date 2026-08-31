const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JsonStore } = require('../lib/store');

test('API Key 加密保存且教师默认密码可修改', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-'));
  const store = new JsonStore(runtimeDir);
  store.updateSettings({ baseUrl: 'https://example.com/v1/', model: 'demo-model', apiKey: 'secret-key' });
  const saved = fs.readFileSync(store.dataPath, 'utf8');
  assert.doesNotMatch(saved, /secret-key/);
  assert.equal(store.getSettings({ includeKey: true }).apiKey, 'secret-key');
  assert.equal(store.verifyAdminPassword('admin'), true);
  store.setAdminPassword('new-pass');
  assert.equal(store.verifyAdminPassword('admin'), false);
  assert.equal(store.verifyAdminPassword('new-pass'), true);
});

test('changing the AI provider never reuses the previous provider API key', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-provider-key-'));
  const store = new JsonStore(runtimeDir);
  store.updateSettings({ baseUrl: 'https://api.openai.com/v1', model: 'openai/model', apiKey: 'openai-secret' });
  store.updateSettings({ baseUrl: 'https://zenmux.ai/api/v1', model: 'anthropic/model', apiKey: '' });
  assert.equal(store.getSettings().hasApiKey, false);
  assert.equal(store.getSettings({ includeKey: true }).apiKey, '');
});

test('exercise review model is stored separately and must differ from the primary model', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-review-model-'));
  const store = new JsonStore(runtimeDir);
  store.updateSettings({
    baseUrl: 'https://example.com/v1', model: 'primary-model', gradingModel: 'grading-model',
    exerciseReviewModel: 'review-model', apiKey: 'secret',
  });
  assert.equal(store.getSettings().gradingModel, 'grading-model');
  assert.equal(store.getSettings().exerciseReviewModel, 'review-model');
  assert.throws(() => store.updateSettings({
    baseUrl: 'https://example.com/v1', model: 'primary-model', exerciseReviewModel: 'primary-model',
  }), /必须与主模型不同/);
  store.updateSettings({ baseUrl: 'https://example.com/v1', model: 'primary-model', exerciseReviewModel: '' });
  assert.equal(store.getSettings().exerciseReviewModel, '');
});

test('loading existing data repairs previously stored Chinese filename mojibake', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-filename-'));
  const store = new JsonStore(runtimeDir);
  const expected = '高二数学_全学期教案.pdf';
  const mojibake = Buffer.from(expected, 'utf8').toString('latin1');
  store.state.lessons.push({ id: 'lesson-1', title: `高二数学 · 第 1 周`, sourceFilename: mojibake });
  store.state.materials.push({ id: 'material-1', filename: mojibake });
  store.save();

  const reloaded = new JsonStore(runtimeDir);
  assert.equal(reloaded.state.lessons[0].sourceFilename, expected);
  assert.equal(reloaded.state.materials[0].filename, expected);
  assert.match(fs.readFileSync(reloaded.dataPath, 'utf8'), new RegExp(expected));
});

test('batch deletion removes only selected lessons and their dependent records', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-delete-'));
  const store = new JsonStore(runtimeDir);
  fs.writeFileSync(path.join(store.uploadDir, 'selected-source.md'), 'selected');
  fs.writeFileSync(path.join(store.uploadDir, 'shared-source.md'), 'shared');
  store.state.lessons.push(
    { id: 'lesson-a', sourceStoredName: 'selected-source.md' },
    { id: 'lesson-b', sourceStoredName: 'shared-source.md' },
    { id: 'lesson-c', sourceStoredName: 'shared-source.md' },
  );
  store.state.exercises.push({ id: 'exercise-a', lessonId: 'lesson-a' }, { id: 'exercise-b', lessonId: 'lesson-b' });
  store.state.submissions.push({ id: 'submission-a', exerciseId: 'exercise-a' }, { id: 'submission-b', exerciseId: 'exercise-b' });
  store.state.attendance.push({ id: 'attendance-a', lessonId: 'lesson-a' }, { id: 'attendance-c', lessonId: 'lesson-c' });
  store.state.materials.push({ id: 'material-b', lessonId: 'lesson-b' });
  store.save();

  assert.equal(store.deleteLessons(['lesson-a', 'lesson-b', 'not-found']), 2);
  assert.deepEqual(store.state.lessons.map((item) => item.id), ['lesson-c']);
  assert.deepEqual(store.state.exercises, []);
  assert.deepEqual(store.state.submissions, []);
  assert.deepEqual(store.state.attendance.map((item) => item.id), ['attendance-c']);
  assert.deepEqual(store.state.materials, []);
  assert.equal(fs.existsSync(path.join(store.uploadDir, 'selected-source.md')), false);
  assert.equal(fs.existsSync(path.join(store.uploadDir, 'shared-source.md')), true);
});

test('deleting a class removes its roster data and unlinks only that class from lessons', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-delete-class-'));
  const store = new JsonStore(runtimeDir);
  const materialPath = path.join(store.uploadDir, 'class-material.pdf');
  fs.writeFileSync(materialPath, 'material');
  store.state.students.push(
    { studentId: 'S1', courseName: '数学', className: '一班' },
    { studentId: 'S2', courseName: '数学', className: '二班' },
  );
  store.state.lessons.push({ id: 'lesson-1', courseName: '数学', className: '一班', classNames: ['一班', '二班'] });
  store.state.exercises.push({ id: 'personalized', targetStudentId: 'S1' }, { id: 'shared', lessonId: 'lesson-1' });
  store.state.submissions.push({ id: 'submission-1', studentId: 'S1', exerciseId: 'shared' });
  store.state.attendance.push({ id: 'attendance-1', studentId: 'S1', lessonId: 'lesson-1' });
  store.state.studentReports.push({ id: 'report-1', studentId: 'S1' });
  store.state.classReports.push({ id: 'class-report', courseName: '数学', className: '一班' });
  store.state.classMaterials.push({ id: 'class-material', courseName: '数学', className: '一班', filePath: materialPath });
  store.save();

  assert.deepEqual(store.deleteClass('数学', '一班'), { students: 1, lessons: 1, materials: 1 });
  assert.deepEqual(store.state.students.map((item) => item.studentId), ['S2']);
  assert.deepEqual(store.state.lessons[0].classNames, ['二班']);
  assert.equal(store.state.lessons[0].className, '二班');
  assert.deepEqual(store.state.exercises.map((item) => item.id), ['shared']);
  assert.deepEqual(store.state.submissions, []);
  assert.deepEqual(store.state.attendance, []);
  assert.deepEqual(store.state.studentReports, []);
  assert.deepEqual(store.state.classReports, []);
  assert.deepEqual(store.state.classMaterials, []);
  assert.equal(fs.existsSync(materialPath), false);
});

test('deleting a course cascades through lessons, classes and course resources', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-delete-course-'));
  const store = new JsonStore(runtimeDir);
  store.state.students.push(
    { studentId: 'S1', courseName: '数学', className: '一班' },
    { studentId: 'S2', courseName: '英语', className: '二班' },
  );
  store.state.lessons.push(
    { id: 'math', courseName: '数学' },
    { id: 'english', courseName: '英语' },
  );
  store.state.exercises.push({ id: 'math-exercise', lessonId: 'math' }, { id: 'english-exercise', lessonId: 'english' });
  store.state.submissions.push({ id: 'math-submission', studentId: 'S1', exerciseId: 'math-exercise' }, { id: 'english-submission', studentId: 'S2', exerciseId: 'english-exercise' });
  store.save();

  assert.deepEqual(store.deleteCourse('数学'), { lessons: 1, students: 1, materials: 0 });
  assert.deepEqual(store.state.lessons.map((item) => item.id), ['english']);
  assert.deepEqual(store.state.students.map((item) => item.studentId), ['S2']);
  assert.deepEqual(store.state.exercises.map((item) => item.id), ['english-exercise']);
  assert.deepEqual(store.state.submissions.map((item) => item.id), ['english-submission']);
});

test('loading existing data keeps only the latest AI courseware for each lesson', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-courseware-'));
  const store = new JsonStore(runtimeDir);
  const oldPath = path.join(store.uploadDir, 'old.html');
  const latestPath = path.join(store.uploadDir, 'latest.html');
  fs.writeFileSync(oldPath, 'old');
  fs.writeFileSync(latestPath, 'latest');
  store.state.materials.push(
    { id: 'old', lessonId: 'lesson-1', type: 'ai_generated', filename: '旧课件.html', filePath: oldPath, createdAt: '2026-01-01T00:00:00.000Z' },
    { id: 'latest', lessonId: 'lesson-1', type: 'ai_generated', filename: '新课件.html', filePath: latestPath, createdAt: '2026-01-02T00:00:00.000Z' },
  );
  store.save();

  const reloaded = new JsonStore(runtimeDir);
  assert.deepEqual(reloaded.state.materials.map((item) => item.id), ['latest']);
  assert.equal(fs.existsSync(oldPath), false);
  assert.equal(fs.existsSync(latestPath), true);
});

test('loading existing data repairs a completed plan incorrectly marked failed by later exercise generation', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-state-'));
  const store = new JsonStore(runtimeDir);
  store.state.lessons.push({
    id: 'lesson-1', status: 'error', error: 'fetch failed', processingStage: 'exercises',
    aiResult: '# 已完成的教学方案', updatedAt: '2026-08-30T00:00:00.000Z',
  });
  store.state.exercises.push({ id: 'exercise-1', lessonId: 'lesson-1', type: 'choice', question: '题目', answer: 'A' });
  store.save();

  const reloaded = new JsonStore(runtimeDir);
  assert.equal(reloaded.state.lessons[0].status, 'done');
  assert.equal(reloaded.state.lessons[0].error, '');
  assert.match(reloaded.state.lessons[0].warning, /已保留/);
  assert.equal(reloaded.state.lessons[0].planCompletedAt, '2026-08-30T00:00:00.000Z');
});

test('lesson summaries report question bank completion from actual per-type counts', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-coverage-'));
  const store = new JsonStore(runtimeDir);
  store.state.lessons.push({
    id: 'lesson-coverage', status: 'done', warning: '历史补题提示',
    exerciseOptions: { typeConfigs: [
      { type: 'choice', count: 4 },
      { type: 'short_answer', count: 2 },
      { type: 'application', count: 1 },
    ] },
  });
  store.state.exercises.push(
    ...Array.from({ length: 8 }, (_, index) => ({ id: `choice-${index}`, lessonId: 'lesson-coverage', type: 'choice' })),
    ...Array.from({ length: 4 }, (_, index) => ({ id: `short-${index}`, lessonId: 'lesson-coverage', type: 'short_answer' })),
    ...Array.from({ length: 2 }, (_, index) => ({ id: `application-${index}`, lessonId: 'lesson-coverage', type: 'application' })),
    { id: 'personal', lessonId: 'lesson-coverage', type: 'choice', targetStudentId: 'S001' },
  );

  const summary = store.listLessons()[0].exerciseCoverage;
  assert.equal(summary.complete, true);
  assert.equal(summary.actualTotal, 14);
  assert.equal(summary.expectedTotal, 7);
  assert.deepEqual(summary.rows.map(({ type, actual, expected }) => ({ type, actual, expected })), [
    { type: 'choice', actual: 8, expected: 4 },
    { type: 'short_answer', actual: 4, expected: 2 },
    { type: 'application', actual: 2, expected: 1 },
  ]);
  assert.deepEqual(store.getLessonDetail('lesson-coverage').exerciseCoverage, summary);
});

test('opening existing data creates a daily upgrade-safe snapshot outside the app bundle', () => {
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiaid-store-backup-'));
  const store = new JsonStore(runtimeDir);
  store.addLessons([{ id: 'lesson-backup', title: '升级前教案', status: 'done' }]);
  new JsonStore(runtimeDir);
  const day = new Date().toISOString().slice(0, 10);
  const backupDir = path.join(runtimeDir, 'automatic-backups', day);
  const snapshot = JSON.parse(fs.readFileSync(path.join(backupDir, 'teaching-data.json'), 'utf8'));
  assert.equal(snapshot.lessons[0].title, '升级前教案');
  assert.equal(fs.existsSync(path.join(backupDir, '.data-key')), true);
});
