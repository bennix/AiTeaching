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
