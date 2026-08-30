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
