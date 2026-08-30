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
  for (const selector of ['settings-form', 'password-form', 'mail-form', 'student-form', 'roster-form', 'class-material-form']) {
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

test('exercise generator reports missing types and keeps its action in a separate footer', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'rich-text.css'), 'utf8');
  assert.match(source, /function exerciseCoverage\(/);
  assert.match(source, /当前题库还缺/);
  assert.match(source, /class="exercise-generator-actions"/);
  assert.match(source, /class="exercise-index">\$\{index \+ 1\}/);
  assert.match(css, /\.exercise-generator-actions\s*\{/);
  assert.match(css, /\.exercise-generator\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/s);
});

test('question bank rerenders live exercise batches from the lesson event stream', () => {
  assert.match(source, /\['ai', 'exercises'\]\.includes\(state\.activeTab\)/);
  assert.match(source, /正在生成\$\{exerciseTypeLabel\(progress\.type\)\}/);
  assert.match(source, /已完成的题目会立即显示在下方/);
  assert.match(source, /AI 正在生成第一批题目/);
});

test('student page selects an existing course and shows all course materials', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'student.html'), 'utf8');
  const studentSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'student.js'), 'utf8');
  assert.match(html, /id="student-login-course-select"/);
  assert.match(html, /id="student-course-select"/);
  assert.match(studentSource, /api\('\/api\/public\/courses'\)/);
  assert.match(studentSource, /api\('\/api\/student\/course'/);
  assert.match(studentSource, /data\.materials\.map/);
  assert.doesNotMatch(studentSource, /data\.materials\.filter\(\(item\) => !lesson/);
});

test('teacher analytics view exposes filters, charts, student detail and AI report generation', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /data-view="analytics"/);
  for (const id of ['analytics-course', 'analytics-class', 'analytics-lesson', 'analytics-trend-chart', 'analytics-knowledge-chart', 'analytics-student-table', 'analytics-report-content']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(source, /api\(`\/api\/analytics/);
  assert.match(source, /api\('\/api\/analytics\/report'/);
  assert.match(source, /function renderTrendChart/);
  assert.match(source, /function renderKnowledgeChart/);
  assert.match(source, /RichText\.render\(\$\('#analytics-report-content'\)/);
});

test('teacher can create a class from a course roster and link courseware to multiple classes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="roster-file"[^>]*accept="\.csv,\.xlsx"/);
  assert.match(html, /用选课单建立班级/);
  assert.match(html, /id="import-class-picker"/);
  assert.match(html, /id="courseware-class-dialog"/);
  assert.match(source, /\$\('#roster-form'\)\.requestSubmit\(\)/);
  assert.match(source, /classNames', JSON\.stringify/);
  assert.match(source, /\/api\/lessons\/\$\{encodeURIComponent\(lessonId\)\}\/classes/);
});
