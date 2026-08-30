const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

function handlerSource(selector) {
  const start = source.indexOf(`$('#${selector}').addEventListener('submit'`);
  assert.notEqual(start, -1, `missing ${selector} submit handler`);
  const next = source.indexOf("\n$('#", start + 1);
  return source.slice(start, next === -1 ? source.length : next);
}

test('async teacher forms retain their form reference across await', () => {
  for (const selector of ['settings-form', 'password-form', 'mail-form', 'student-form', 'class-material-form']) {
    const handler = handlerSource(selector);
    assert.match(handler, /const formElement = event\.currentTarget;/, `${selector} must capture the form before awaiting`);
    const afterAwait = handler.slice(handler.indexOf('await '));
    assert.doesNotMatch(afterAwait, /event\.currentTarget/, `${selector} must not read event.currentTarget after awaiting`);
  }
});

test('teacher settings shows the ZenMux invite only when no API key is configured', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="api-key-invite"[^>]*hidden/);
  assert.match(html, /href="https:\/\/zenmux\.ai\/invite\/GBQMC5"/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(source, /\$\('#api-key-invite'\)\.hidden = Boolean\(settings\.hasApiKey\);/);
});
