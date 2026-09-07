const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness(api) {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const nodes = {
    '.nav-item.active': { dataset: { view: 'analytics' } },
    '#analytics-live-status': {}, '#lesson-dialog': { open: true },
  };
  const state = { data: {}, analyticsFilters: {}, activeLesson: { id: 'l1' }, activeTab: 'attendance' };
  const context = vm.createContext({ state, api, URLSearchParams, AbortSignal, Date,
    document: { hidden: false, addEventListener() {} }, window: { addEventListener() {} },
    $: (selector) => nodes[selector], renderAnalytics() {}, renderDialogContent() {},
    setInterval(fn, ms) { assert.equal(ms, 3000); },
  });
  vm.runInContext(source.slice(source.indexOf('let analyticsRequestVersion'), source.indexOf('function renderNetwork')), context);
  return { context, state, nodes };
}

test('live refresh loads analytics and attendance without changing the active lesson tab', async () => {
  const calls = [];
  const { context, state } = harness(async (url) => {
    calls.push(url);
    return url.startsWith('/api/analytics')
      ? { filters: { courseName: '数学', className: '一班', lessonId: '' }, summary: { attendancePresent: 1 } }
      : { id: 'l1', attendance: [{ studentId: 's1' }] };
  });
  await context.refreshLearningViews();
  assert.equal(calls.length, 2);
  assert.equal(state.analytics.summary.attendancePresent, 1);
  assert.equal(state.activeLesson.attendance.length, 1);
  assert.equal(state.activeTab, 'attendance');
});

test('an old analytics request cannot overwrite a newer filter selection', async () => {
  const pending = [];
  const { context, state } = harness(() => new Promise((resolve) => pending.push(resolve)));
  const first = context.loadAnalytics({ courseName: '旧课程' });
  const second = context.loadAnalytics({ courseName: '新课程' });
  pending[1]({ filters: { courseName: '新课程' } });
  await second;
  pending[0]({ filters: { courseName: '旧课程' } });
  await first;
  assert.equal(state.analyticsFilters.courseName, '新课程');
});
