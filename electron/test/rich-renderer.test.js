const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = path.join(__dirname, '..', 'renderer');

test('teacher and student pages load the sanitized Markdown and LaTeX renderer', () => {
  for (const filename of ['index.html', 'student.html']) {
    const html = fs.readFileSync(path.join(renderer, filename), 'utf8');
    assert.match(html, /purify\.min\.js/);
    assert.match(html, /katex\.min\.js/);
    assert.match(html, /markdown\.js/);
  }
});

test('rich text renderer sanitizes before typesetting', () => {
  const source = fs.readFileSync(path.join(renderer, 'markdown.js'), 'utf8');
  assert.ok(source.indexOf('DOMPurify.sanitize') < source.indexOf('renderMathInElement'));
  assert.match(source, /FORBID_TAGS/);
});
