const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLearningAnalytics } = require('../lib/analytics');

test('builds course and week scoped attendance, exercise and mastery analytics', () => {
  const state = {
    lessons: [
      { id: 'w1', courseName: '高一数学', className: '教学班', teachingWeek: 1, title: '第 1 周', status: 'done' },
      { id: 'w2', courseName: '高一数学', className: '教学班', teachingWeek: 2, title: '第 2 周', status: 'done' },
      { id: 'english', courseName: '高一英语', className: '教学班', teachingWeek: 1, title: 'English', status: 'done' },
    ],
    students: [
      { studentId: 'S1', name: '甲', courseName: '高一数学', className: '高一（2）班' },
      { studentId: 'S2', name: '乙', courseName: '高一数学', className: '高一（2）班' },
      { studentId: 'S3', name: '丙', courseName: '高一英语', className: '高一（2）班' },
    ],
    exercises: [
      { id: 'q1', lessonId: 'w1', published: true, targetStudentId: null, knowledgePoint: '集合' },
      { id: 'q2', lessonId: 'w2', published: true, targetStudentId: null, knowledgePoint: '函数' },
      { id: 'q3', lessonId: 'w1', published: true, targetStudentId: 'S1', knowledgePoint: '函数' },
      { id: 'draft', lessonId: 'w1', published: false, targetStudentId: null, knowledgePoint: '不应统计' },
    ],
    submissions: [
      { studentId: 'S1', exerciseId: 'q1', correct: true },
      { studentId: 'S1', exerciseId: 'q2', correct: false },
      { studentId: 'S1', exerciseId: 'q3', correct: false },
      { studentId: 'S2', exerciseId: 'q1', correct: false },
    ],
    attendance: [
      { studentId: 'S1', lessonId: 'w1', status: 'present' },
      { studentId: 'S2', lessonId: 'w1', status: 'present' },
      { studentId: 'S1', lessonId: 'w2', status: 'present' },
    ],
    classReports: [],
  };

  const analytics = buildLearningAnalytics(state, { courseName: '高一数学', className: '高一（2）班' });
  assert.deepEqual(analytics.summary, {
    studentCount: 2, lessonCount: 2, publishedExerciseCount: 3,
    attendancePresent: 3, attendanceExpected: 4, attendanceRate: 75,
    answeredCount: 4, assignmentCount: 5, completionRate: 80,
    correctCount: 1, accuracyRate: 25,
  });
  assert.deepEqual(analytics.knowledgePoints.map((item) => [item.name, item.attempts, item.correct, item.masteryRate]), [
    ['函数', 2, 0, 0], ['集合', 2, 1, 50],
  ]);
  assert.deepEqual(analytics.trends.map((item) => [item.week, item.attendanceRate, item.completionRate, item.accuracyRate]), [
    [1, 100, 100, 33], [2, 50, 50, 0],
  ]);
  assert.deepEqual(analytics.students.map((item) => [item.studentId, item.attendanceRate, item.completionRate, item.accuracyRate]), [
    ['S1', 100, 100, 33], ['S2', 50, 50, 0],
  ]);
  assert.deepEqual(analytics.students[0].weakPoints, ['函数']);
  assert.equal(analytics.latestReport, null);
});

test('scopes analytics to one teaching week without treating unanswered work as incorrect', () => {
  const state = {
    lessons: [{ id: 'w1', courseName: '数学', teachingWeek: 1, status: 'done' }],
    students: [{ studentId: 'S1', name: '甲', courseName: '数学', className: '一班' }],
    exercises: [{ id: 'q1', lessonId: 'w1', published: true, targetStudentId: null, knowledgePoint: '集合' }],
    submissions: [], attendance: [], classReports: [],
  };
  const analytics = buildLearningAnalytics(state, { courseName: '数学', lessonId: 'w1' });
  assert.equal(analytics.summary.assignmentCount, 1);
  assert.equal(analytics.summary.answeredCount, 0);
  assert.equal(analytics.summary.completionRate, 0);
  assert.equal(analytics.summary.accuracyRate, 0);
  assert.deepEqual(analytics.knowledgePoints, []);
});
