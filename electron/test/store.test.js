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
