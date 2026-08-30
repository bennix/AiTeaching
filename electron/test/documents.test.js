const test = require('node:test');
const assert = require('node:assert/strict');
const { addWeeks, buildLessonRecords, splitByWeekHeadings } = require('../lib/documents');

test('按明确的教学周标题拆分整学期教案', () => {
  const sections = splitByWeekHeadings('# 第1周：导论\n变量与类型\n\n## 第2周 函数\n参数和返回值', 2);
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, '导论');
  assert.match(sections[1].text, /参数和返回值/);
});

test('整学期导入生成指定数量和每周日期', () => {
  const records = buildLessonRecords({
    text: '第一部分内容。\n\n第二部分内容。\n\n第三部分内容。', filename: '课程.md', scope: 'semester',
    courseName: '程序设计', className: '一班', startDate: '2026-09-01', totalWeeks: 3,
  });
  assert.equal(records.length, 3);
  assert.equal(records[2].date, addWeeks('2026-09-01', 2));
  assert.equal(records[0].teachingWeek, 1);
});
