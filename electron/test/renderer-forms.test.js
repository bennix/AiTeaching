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
  assert.match(source, /function updateApiKeyInvite\(/);
  assert.match(source, /hasApplicableKey \|\| !isZenMuxBaseUrl/);
  assert.match(source, /baseUrl\.addEventListener\('input', updateApiKeyInvite\)/);
  assert.match(source, /apiKey\.addEventListener\('input', updateApiKeyInvite\)/);
});

test('teacher model picker explains and requests application-capable models', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="model-filter-status"/);
  assert.match(html, /<select id="model-options-select"/);
  assert.match(html, /<select id="grading-model-options-select"/);
  assert.match(html, /<select id="exercise-review-model-options-select"/);
  assert.match(html, /数理化必填，且必须不同于主模型/);
  assert.doesNotMatch(html, /<datalist id="model-options"/);
  assert.match(html, /支持文本输入与文本输出/);
  assert.match(html, /href="https:\/\/zenmux\.ai\/models"/);
  assert.match(source, /function renderModelSelectors\(/);
  assert.match(source, /请选择已获取的适用模型（\$\{models\.length\} 个）/);
  assert.match(source, /model-options-select'\)\.addEventListener\('change'/);
  assert.match(source, /grading-model-options-select'\)\.addEventListener\('change'/);
  assert.match(source, /exercise-review-model-options-select'\)\.addEventListener\('change'/);
  assert.match(source, /baseUrl: formElement\.baseUrl\.value/);
  assert.match(source, /已排除.*不适合教学工作流/);
});

test('STEM exercise workflow exposes independent review progress and verification evidence', () => {
  assert.match(source, /progress\?\.phase === 'reviewing'/);
  assert.match(source, /只有复核通过的题目会自动出现在这里/);
  assert.match(source, /查看两种解法与复核记录/);
  assert.match(source, /复核模型：/);
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
  assert.match(source, /AI 正在生成并复核第一批题目/);
});

test('publishing or withdrawing an exercise keeps the question bank tab active', () => {
  assert.match(source, /async function openLesson\(id, activeTab = 'ai'\)/);
  assert.match(source, /state\.activeTab = activeTab;/);
  assert.match(source, /await openLesson\(lesson\.id, 'exercises'\)/);
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

test('teacher student directory separates classes and only renders the selected class roster', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="student-class-list"/);
  assert.match(html, /id="active-student-class-name"/);
  assert.match(html, /id="active-student-class-meta"/);
  assert.match(source, /function studentClassGroups\(/);
  assert.match(source, /state\.activeStudentClassKey/);
  assert.match(source, /selectedGroup\.students\.map/);
  assert.match(source, /data-student-class-key/);
});

test('teacher lesson directory groups teaching weeks by course and linked classes', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  const css = ['extra.css', 'styles.css']
    .map((filename) => fs.readFileSync(path.join(__dirname, '..', 'renderer', filename), 'utf8')).join('\n');
  for (const id of ['lesson-group-list', 'active-lesson-group-name', 'active-lesson-group-meta', 'lesson-list']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(source, /function lessonGroups\(/);
  assert.match(source, /state\.activeLessonGroupKey/);
  assert.match(source, /selectedGroup\?\.lessons \|\| \[\]/);
  assert.match(source, /data-lesson-group-key/);
  assert.match(source, /function visibleLessons\(/);
  assert.match(css, /\.lesson-directory\s*\{/);
  assert.match(css, /\.lesson-group-item\.active\s*\{/);
  assert.match(css, /\.batch-toolbar\[hidden\]\s*\{display:none\}/);

  const functionStart = source.indexOf('function lessonGroups(');
  const functionEnd = source.indexOf('\nfunction activeLessonGroup(', functionStart);
  const groupLessons = Function(`${source.slice(functionStart, functionEnd)}; return lessonGroups;`)();
  const groups = groupLessons([
    { id: 'math-1', courseName: '数学', classNames: ['二班', '一班'], status: 'done' },
    { id: 'math-2', courseName: '数学', classNames: ['一班', '二班'], status: 'processing' },
    { id: 'english-1', courseName: '英语', className: '三班', status: 'ready' },
  ]);
  const math = groups.find((group) => group.courseName === '数学');
  assert.equal(groups.length, 2);
  assert.deepEqual(math.classNames, ['一班', '二班']);
  assert.equal(math.count, 2);
  assert.equal(math.doneCount, 1);
  assert.equal(math.processingCount, 1);
});
