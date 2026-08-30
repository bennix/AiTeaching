const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const renderer = path.join(__dirname, '..', 'renderer');

test('teacher and student pages load the sanitized Markdown and LaTeX renderer', () => {
  for (const filename of ['index.html', 'student.html']) {
    const html = fs.readFileSync(path.join(renderer, filename), 'utf8');
    assert.match(html, /purify\.min\.js/);
    assert.match(html, /katex\.min\.js/);
    assert.match(html, /markdown\.js/);
  }
});

test('teacher and student pages expose courseware preview dialogs', () => {
  const teacher = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
  const student = fs.readFileSync(path.join(renderer, 'student.html'), 'utf8');
  assert.match(teacher, /id="courseware-preview-dialog"/);
  assert.match(student, /id="student-courseware-preview"/);
  assert.match(fs.readFileSync(path.join(renderer, 'app.js'), 'utf8'), /RichText\.render\(\$\('#courseware-preview-content'\)/);
  assert.match(fs.readFileSync(path.join(renderer, 'student.js'), 'utf8'), /RichText\.render\(\$\('#student-courseware-content'\)/);
});

test('rich text renderer sanitizes before typesetting', () => {
  const source = fs.readFileSync(path.join(renderer, 'markdown.js'), 'utf8');
  assert.ok(source.indexOf('DOMPurify.sanitize') < source.indexOf('renderMathInElement'));
  assert.match(source, /FORBID_TAGS/);
});

test('bare subscript and superscript tokens are normalized for KaTeX on both clients', () => {
  const source = fs.readFileSync(path.join(renderer, 'markdown.js'), 'utf8');
  const sandbox = {
    window: {},
    marked: { use() {}, parse(value) { return value; }, parseInline(value) { return value; } },
    DOMPurify: { sanitize(value) { return value; } },
  };
  vm.runInNewContext(source, sandbox);
  assert.equal(sandbox.window.RichText.normalizeBareMathText('数列 a_a、x_1 和 y^2'), '数列 \\(a_a\\)、\\(x_1\\) 和 \\(y^2\\)');
  assert.equal(sandbox.window.RichText.normalizeBareMathText('字段 student_id 不应变成公式'), '字段 student_id 不应变成公式');
  assert.equal(sandbox.window.RichText.normalizeBareMathText('已有 $a_a$ 保持不变'), '已有 $a_a$ 保持不变');
});

test('downloaded courseware is a standalone HTML document', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(server, /function buildStandaloneCoursewareHtml/);
  assert.match(server, /data:\$\{mime\};base64/);
  assert.doesNotMatch(server, /<script src="\/vendor\/marked/);
});
