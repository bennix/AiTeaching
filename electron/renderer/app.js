const state = { data: null, analytics: null, analyticsFilters: {}, activeLesson: null, activeTab: 'ai', activeLessonGroupKey: '', activeStudentClassKey: '', poller: null, lessonStream: null, batchMode: false, selectedLessonIds: new Set() };
const viewMeta = {
  lessons: ['教案与教学周', '管理单周教案与整学期教学安排'],
  import: ['导入教案', '支持 PDF、Word 和 Markdown 教案'],
  students: ['学生与班级', '管理名单、学习记录与个性化诊断'],
  analytics: ['签到与学情', '用真实签到和作答数据分析班级学习情况'],
  settings: ['AI 设置', '指定 BaseURL 并选择模型'],
  network: ['局域网服务', '让同一网络中的设备访问本程序'],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const richHtml = (value, options) => RichText.html(value, options);
const exerciseTypeLabel = (type) => ({ choice: '选择题', short_answer: '简答题', application: '实践 / 应用题', coding: '编程题（旧数据）' }[type] || type);

async function api(url, options = {}) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `请求失败（${response.status}）`);
  return payload;
}

function toast(message, isError = false, isWarning = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.classList.toggle('warning', !isError && isWarning);
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3600);
}

function showView(name) {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  $$('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${name}`));
  $('#page-title').textContent = viewMeta[name][0];
  $('#page-subtitle').textContent = viewMeta[name][1];
  if (name === 'analytics') loadAnalytics().catch((error) => toast(error.message, true));
}

function statusLabel(status, stage, warning = '') {
  if (status === 'processing') return stage === 'exercises' ? '● 正在生成题库' : '● 正在流式整理';
  if (status === 'done' && warning) return '✓ 方案完成 · 题库需补充';
  return { done: '✓ 方案与题库已完成', queued: '◷ 排队中', blocked: '! 等待前序周', error: '! 处理失败', ready: '等待 API Key' }[status] || status;
}

function lessonClassLabel(lesson) {
  const names = [...(Array.isArray(lesson.classNames) ? lesson.classNames : []), lesson.className];
  return [...new Set(names.map((item) => String(item || '').trim()).filter(Boolean))].join('、');
}

function lessonGroups(lessons = []) {
  const groups = new Map();
  for (const lesson of lessons) {
    const courseName = String(lesson.courseName || '').trim();
    const classNames = [...new Set([...(Array.isArray(lesson.classNames) ? lesson.classNames : []), lesson.className]
      .map((item) => String(item || '').trim()).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right, 'zh-CN-u-co-stroke', { numeric: true }));
    const key = `${courseName}\u241f${classNames.join('\u241e')}`;
    if (!groups.has(key)) groups.set(key, { key, courseName, classNames, lessons: [] });
    groups.get(key).lessons.push(lesson);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      count: group.lessons.length,
      doneCount: group.lessons.filter((lesson) => lesson.status === 'done').length,
      processingCount: group.lessons.filter((lesson) => lesson.status === 'processing').length,
    }))
    .sort((left, right) => `${left.courseName}${left.classNames.join('')}`.localeCompare(`${right.courseName}${right.classNames.join('')}`, 'zh-CN'));
}

function activeLessonGroup() {
  const groups = lessonGroups(state.data?.lessons || []);
  return groups.find((group) => group.key === state.activeLessonGroupKey) || groups[0] || null;
}

function visibleLessons() {
  return activeLessonGroup()?.lessons || [];
}

function studentClassGroups(students = []) {
  const groups = new Map();
  for (const student of students) {
    const className = String(student.className || '').trim();
    const courseName = String(student.courseName || '').trim();
    const key = `${courseName}\u241f${className}`;
    if (!groups.has(key)) groups.set(key, {
      key,
      className,
      courseName,
      term: student.term || '',
      courseCode: student.courseCode || '',
      students: [],
    });
    groups.get(key).students.push(student);
  }
  return [...groups.values()]
    .map((group) => ({ ...group, count: group.students.length }))
    .sort((left, right) => Number(!left.className) - Number(!right.className)
      || `${left.courseName}${left.className}`.localeCompare(`${right.courseName}${right.className}`, 'zh-CN'));
}

function establishedClasses(students = []) {
  return studentClassGroups(students)
    .filter((group) => group.className)
    .map(({ students: _students, ...group }) => group);
}

function renderImportClassPicker(students) {
  const picker = $('#import-class-picker');
  const selected = new Set($$('[name="linkedClass"]:checked').map((input) => input.value));
  const classes = establishedClasses(students);
  picker.innerHTML = classes.length ? classes.map((item) => `<label class="class-choice">
    <input type="checkbox" name="linkedClass" value="${escapeHtml(item.className)}" ${selected.has(item.className) ? 'checked' : ''}>
    <span><strong>${escapeHtml(item.className)}</strong><small>${escapeHtml(item.courseName || '未指定课程')} · ${item.count} 名学生${item.term ? ` · ${escapeHtml(item.term)}` : ''}</small></span>
  </label>`).join('') : '<span class="muted">请先在“学生与班级”中导入选课单建立班级。</span>';
  $$('[name="linkedClass"]').forEach((input) => input.addEventListener('change', () => {
    if (!input.checked) return;
    const item = classes.find((entry) => entry.className === input.value);
    const courseInput = document.querySelector('#import-form [name="courseName"]');
    if (item?.courseName && !courseInput.value.trim()) courseInput.value = item.courseName;
  }));
}

function updateBatchToolbar() {
  $('#batch-toolbar').hidden = !state.batchMode;
  $('#batch-mode-button').textContent = state.batchMode ? '退出批量管理' : '批量管理';
  $('#selected-lesson-count').textContent = state.selectedLessonIds.size;
  $('#batch-delete-button').disabled = !state.selectedLessonIds.size;
  const lessonIds = visibleLessons().map((item) => item.id);
  $('#select-all-lessons').checked = Boolean(lessonIds.length) && lessonIds.every((id) => state.selectedLessonIds.has(id));
}

function renderLessons() {
  const lessons = state.data.lessons || [];
  const groups = lessonGroups(lessons);
  const selectedGroup = groups.find((group) => group.key === state.activeLessonGroupKey) || groups[0] || null;
  state.activeLessonGroupKey = selectedGroup?.key || '';
  const selectedLessons = selectedGroup?.lessons || [];
  $('#metric-total').textContent = lessons.length;
  $('#metric-done').textContent = lessons.filter((item) => item.status === 'done').length;
  $('#metric-processing').textContent = lessons.filter((item) => item.status === 'processing').length;
  $('#lesson-group-list').innerHTML = groups.length ? groups.map((group) => `
    <button class="lesson-group-item${group.key === state.activeLessonGroupKey ? ' active' : ''}" type="button" data-lesson-group-key="${escapeHtml(group.key)}">
      <span><strong>${escapeHtml(group.courseName || '未命名课程')}</strong><small>${escapeHtml(group.classNames.join('、') || '未关联班级')}</small></span>
      <b>${group.count}</b>
    </button>`).join('') : '<div class="lesson-group-empty">还没有课程教案</div>';
  $('#active-lesson-group-name').textContent = selectedGroup?.courseName || (selectedGroup ? '未命名课程' : '教学周');
  $('#active-lesson-group-meta').textContent = selectedGroup
    ? `${selectedGroup.classNames.join('、') || '未关联班级'} · ${selectedGroup.count} 个教学周 · ${selectedGroup.doneCount} 个已完成${selectedGroup.processingCount ? ` · ${selectedGroup.processingCount} 个处理中` : ''}`
    : '请先导入一个教学周或整学期教案';
  $('#lesson-list').innerHTML = selectedLessons.length ? selectedLessons.map((lesson) => `
    <article class="lesson-row${state.batchMode ? ' batch-mode' : ''}" data-lesson-id="${escapeHtml(lesson.id)}">
      ${state.batchMode ? `<label class="lesson-select"><input type="checkbox" data-select-lesson="${escapeHtml(lesson.id)}" ${state.selectedLessonIds.has(lesson.id) ? 'checked' : ''} aria-label="选择第 ${escapeHtml(lesson.teachingWeek)} 周"></label>` : ''}
      <div class="week-badge">第 ${escapeHtml(lesson.teachingWeek)} 周</div>
      <div><h3>${escapeHtml(lesson.title)}</h3><p>${escapeHtml(lesson.courseName || '未填写课程')}${lessonClassLabel(lesson) ? ` · ${escapeHtml(lessonClassLabel(lesson))}` : ''} · ${escapeHtml(lesson.sourceFilename)}</p></div>
      <span class="status ${escapeHtml(lesson.status)}">${escapeHtml(statusLabel(lesson.status, lesson.processingStage, lesson.warning))}</span>
      <span class="date">${escapeHtml(lesson.date || '')}</span>
    </article>`).join('') : '<div class="empty">还没有教案。请先导入一个教学周或整学期教案。</div>';
  $$('[data-lesson-group-key]').forEach((button) => button.addEventListener('click', () => {
    state.activeLessonGroupKey = button.dataset.lessonGroupKey;
    renderLessons();
  }));
  $$('.lesson-row').forEach((row) => row.addEventListener('click', (event) => {
    if (state.batchMode) {
      if (!event.target.matches('[data-select-lesson]')) row.querySelector('[data-select-lesson]').click();
      return;
    }
    openLesson(row.dataset.lessonId);
  }));
  $$('[data-select-lesson]').forEach((checkbox) => checkbox.addEventListener('click', (event) => event.stopPropagation()));
  $$('[data-select-lesson]').forEach((checkbox) => checkbox.addEventListener('change', () => {
    if (checkbox.checked) state.selectedLessonIds.add(checkbox.dataset.selectLesson);
    else state.selectedLessonIds.delete(checkbox.dataset.selectLesson);
    updateBatchToolbar();
  }));
  updateBatchToolbar();
}

function renderSettings() {
  const settings = state.data.settings;
  const form = $('#settings-form');
  form.baseUrl.value = settings.baseUrl || '';
  form.model.value = settings.model || '';
  form.gradingModel.value = settings.gradingModel || settings.model || '';
  form.attendanceTimeoutMinutes.value = settings.attendanceTimeoutMinutes || 1440;
  $('#key-status').textContent = settings.hasApiKey ? '已保存加密 API Key；留空不会覆盖' : '尚未保存 API Key';
  renderModelSelectors(settings);
  updateApiKeyInvite();
  const mailForm = $('#mail-form');
  for (const [key, value] of Object.entries(settings.mail || {})) if (mailForm.elements[key] && key !== 'password') mailForm.elements[key].value = value || '';
  mailForm.password.placeholder = settings.mail?.hasPassword ? '已保存；留空保留当前值' : '请输入授权码 / 密码';
}

function renderModelSelectors(settings) {
  const models = [...new Set((settings.modelOptions || []).map((model) => String(model || '').trim()).filter(Boolean))];
  const options = models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('');
  const mainSelect = $('#model-options-select');
  const gradingSelect = $('#grading-model-options-select');
  mainSelect.innerHTML = `<option value="">${models.length ? `请选择已获取的适用模型（${models.length} 个）` : '尚未获取模型列表'}</option>${options}`;
  gradingSelect.innerHTML = `<option value="">使用主模型</option>${options}`;
  mainSelect.value = models.includes(settings.model) ? settings.model : '';
  const gradingModel = settings.gradingModel || settings.model || '';
  gradingSelect.value = models.includes(gradingModel) ? gradingModel : '';
}

function syncModelSelect(input, select) {
  select.value = [...select.options].some((option) => option.value === input.value) ? input.value : '';
}

function isZenMuxBaseUrl(value) {
  try {
    const hostname = new URL(String(value || '')).hostname.toLowerCase();
    return hostname === 'zenmux.ai' || hostname.endsWith('.zenmux.ai');
  } catch { return false; }
}

function updateApiKeyInvite() {
  const form = $('#settings-form');
  const settings = state.data?.settings || {};
  const currentBaseUrl = String(form.baseUrl.value || '').trim().replace(/\/+$/, '');
  const storedBaseUrl = String(settings.baseUrl || '').trim().replace(/\/+$/, '');
  const hasApplicableKey = Boolean(form.apiKey.value.trim() || (settings.hasApiKey && currentBaseUrl === storedBaseUrl));
  $('#api-key-invite').hidden = Boolean(hasApplicableKey || !isZenMuxBaseUrl(currentBaseUrl));
}

function renderStudents() {
  const students = state.data.students || [];
  const classGroups = studentClassGroups(students);
  const selectedGroup = classGroups.find((group) => group.key === state.activeStudentClassKey) || classGroups[0] || null;
  state.activeStudentClassKey = selectedGroup?.key || '';
  $('#student-total').textContent = students.length;
  $('#class-total').textContent = establishedClasses(students).length;
  $('#submission-total').textContent = state.data.submissionCount || 0;
  renderImportClassPicker(students);
  $('#student-class-list').innerHTML = classGroups.length ? classGroups.map((group) => `
    <button class="student-class-item${group.key === state.activeStudentClassKey ? ' active' : ''}" type="button" data-student-class-key="${escapeHtml(group.key)}">
      <span><strong>${escapeHtml(group.className || '未分班')}</strong><small>${escapeHtml(group.courseName || '未指定课程')}${group.term ? ` · ${escapeHtml(group.term)}` : ''}</small></span>
      <b>${group.count}</b>
    </button>`).join('') : '<div class="student-class-empty">还没有班级</div>';
  $('#active-student-class-name').textContent = selectedGroup?.className || (selectedGroup ? '未分班学生' : '学生名单');
  $('#active-student-class-meta').textContent = selectedGroup
    ? `${selectedGroup.courseName || '未指定课程'} · ${selectedGroup.count} 名学生${selectedGroup.term ? ` · ${selectedGroup.term}` : ''}`
    : '请先添加学生或导入选课单';
  $('#student-list').innerHTML = selectedGroup ? selectedGroup.students.map((student) => `
    <article class="student-card">
      <div><h3>${escapeHtml(student.name)} <span class="badge">${escapeHtml(student.studentId)}</span></h3><p>${escapeHtml(student.courseName || '未指定课程')} · ${escapeHtml(student.className || '未分班')} · ${escapeHtml(student.email || '未填写邮箱')}</p></div>
      <div class="student-card-actions"><button class="button secondary" data-report-student="${escapeHtml(student.studentId)}">AI 报告</button><button class="button secondary" data-target-student="${escapeHtml(student.studentId)}">个性化习题</button><button class="button secondary" data-email-student="${escapeHtml(student.studentId)}">发送报告</button><button class="button danger" data-delete-student="${escapeHtml(student.studentId)}">删除</button></div>
    </article>`).join('') : '<div class="empty">还没有学生，请手动添加或导入名册。</div>';
  $$('[data-student-class-key]').forEach((button) => button.addEventListener('click', () => {
    state.activeStudentClassKey = button.dataset.studentClassKey;
    renderStudents();
  }));
  $$('[data-delete-student]').forEach((button) => button.addEventListener('click', async () => {
    if (!confirm(`确认删除学生 ${button.dataset.deleteStudent}？`)) return;
    try { await api(`/api/students/${encodeURIComponent(button.dataset.deleteStudent)}`, { method: 'DELETE' }); toast('学生已删除'); await refresh(); } catch (error) { toast(error.message, true); }
  }));
  $$('[data-report-student]').forEach((button) => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await api(`/api/students/${encodeURIComponent(button.dataset.reportStudent)}/report`, { method: 'POST' });
      const student = students.find((item) => item.studentId === button.dataset.reportStudent);
      $('#report-title').textContent = `${student?.name || button.dataset.reportStudent} · 学习诊断`;
      RichText.render($('#report-content'), result.report.markdown, '暂无报告内容。');
      $('#report-dialog').showModal();
    }
    catch (error) { toast(error.message, true); } finally { button.disabled = false; }
  }));
  $$('[data-target-student]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { const result = await api(`/api/students/${encodeURIComponent(button.dataset.targetStudent)}/exercises`, { method: 'POST' }); toast(`已生成并发放 ${result.count} 道个性化习题`); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } }));
  $$('[data-email-student]').forEach((button) => button.addEventListener('click', async () => { button.disabled = true; try { await api(`/api/students/${encodeURIComponent(button.dataset.emailStudent)}/email-report`, { method: 'POST' }); toast('学生报告邮件已发送'); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } }));
  $('#class-material-list').innerHTML = (state.data.classMaterials || []).map((item) => `<div class="student-card"><div><h3>${escapeHtml(item.filename)}</h3><p>${escapeHtml(item.courseName || '')} · ${escapeHtml(item.className || '')}</p></div><button class="button danger" data-delete-class-material="${escapeHtml(item.id)}">删除</button></div>`).join('');
  $$('[data-delete-class-material]').forEach((button) => button.addEventListener('click', async () => { try { await api(`/api/materials/${button.dataset.deleteClassMaterial}`, { method: 'DELETE' }); await refresh(); } catch (error) { toast(error.message, true); } }));
}

function analyticsOption(value, label, selected) {
  return `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
}

function setRateRing(selector, value, color) {
  const rate = Math.max(0, Math.min(100, Number(value) || 0));
  $(selector).style.background = `conic-gradient(${color} ${rate * 3.6}deg, #edf1f7 0)`;
}

function renderTrendChart(items) {
  const node = $('#analytics-trend-chart');
  if (!items.length) {
    node.innerHTML = '<div class="empty">当前范围没有可展示的教学周数据。</div>';
    return;
  }
  const width = 720; const height = 260; const left = 54; const right = 24; const top = 24; const bottom = 48;
  const plotWidth = width - left - right; const plotHeight = height - top - bottom;
  const x = (index) => items.length === 1 ? left + plotWidth / 2 : left + (index / (items.length - 1)) * plotWidth;
  const y = (rate) => top + ((100 - Math.max(0, Math.min(100, rate))) / 100) * plotHeight;
  const series = [
    { key: 'attendanceRate', color: '#5b4df0' },
    { key: 'completionRate', color: '#18a779' },
    { key: 'accuracyRate', color: '#f59f37' },
  ];
  const grid = [0, 50, 100].map((rate) => `<line x1="${left}" y1="${y(rate)}" x2="${width - right}" y2="${y(rate)}"/><text x="${left - 12}" y="${y(rate) + 4}" text-anchor="end">${rate}%</text>`).join('');
  const lines = series.map((item) => {
    const points = items.map((row, index) => `${x(index)},${y(row[item.key])}`).join(' ');
    const dots = items.map((row, index) => `<circle cx="${x(index)}" cy="${y(row[item.key])}" r="4"><title>${escapeHtml(row.title)}：${row[item.key]}%</title></circle>`).join('');
    return `<g style="--series:${item.color}"><polyline points="${points}"/>${dots}</g>`;
  }).join('');
  const labels = items.map((row, index) => `<text class="week-label" x="${x(index)}" y="${height - 16}" text-anchor="middle">第 ${escapeHtml(row.week || '-')} 周</text>`).join('');
  node.innerHTML = `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="教学周签到、作答完成率和正确率趋势图"><g class="chart-grid">${grid}</g>${lines}${labels}</svg>`;
}

function renderKnowledgeChart(items) {
  const node = $('#analytics-knowledge-chart');
  if (!items.length) {
    node.innerHTML = '<div class="empty">还没有带知识点标注的实际作答，暂不能判断掌握度。</div>';
    return;
  }
  node.innerHTML = items.slice(0, 10).map((item) => {
    const level = item.masteryRate < 60 ? 'weak' : (item.masteryRate < 80 ? 'medium' : 'strong');
    return `<div class="knowledge-row ${level}"><div><strong>${escapeHtml(item.name)}</strong><span>${item.correct}/${item.attempts} 次正确</span></div><div class="knowledge-track"><i style="width:${item.masteryRate}%"></i></div><b>${item.masteryRate}%</b></div>`;
  }).join('');
}

function renderAnalytics() {
  const analytics = state.analytics;
  if (!analytics) return;
  const { filters, summary, trends, knowledgePoints, students, latestReport } = analytics;
  $('#analytics-course').innerHTML = filters.courses.length
    ? filters.courses.map((course) => analyticsOption(course, course, filters.courseName)).join('')
    : analyticsOption('', '暂无已完成课程', '', true);
  $('#analytics-class').innerHTML = analyticsOption('', '全部班级', filters.className)
    + filters.classes.map((className) => analyticsOption(className, className, filters.className)).join('');
  $('#analytics-lesson').innerHTML = analyticsOption('', '全部教学周', filters.lessonId)
    + filters.lessons.map((lesson) => analyticsOption(lesson.id, `第 ${lesson.teachingWeek || '-'} 周${lesson.date ? ` · ${lesson.date}` : ''}`, filters.lessonId)).join('');

  $('#analytics-students').textContent = summary.studentCount;
  $('#analytics-student-note').textContent = `${summary.lessonCount} 个课次 · ${summary.publishedExerciseCount} 道已发放题目`;
  $('#analytics-attendance').textContent = `${summary.attendanceRate}%`;
  $('#analytics-attendance-note').textContent = `${summary.attendancePresent} / ${summary.attendanceExpected} 人次`;
  $('#analytics-completion').textContent = `${summary.completionRate}%`;
  $('#analytics-completion-note').textContent = `${summary.answeredCount} / ${summary.assignmentCount} 题次`;
  $('#analytics-accuracy').textContent = `${summary.accuracyRate}%`;
  $('#analytics-accuracy-note').textContent = `${summary.correctCount} / ${summary.answeredCount} 次作答`;
  setRateRing('#analytics-attendance-ring', summary.attendanceRate, '#5b4df0');
  setRateRing('#analytics-completion-ring', summary.completionRate, '#18a779');
  setRateRing('#analytics-accuracy-ring', summary.accuracyRate, '#f59f37');
  renderTrendChart(trends);
  renderKnowledgeChart(knowledgePoints);

  $('#analytics-student-table').innerHTML = students.length ? `<table class="analytics-table"><thead><tr><th>学生</th><th>签到</th><th>完成</th><th>正确</th><th>薄弱知识点</th></tr></thead><tbody>${students.map((student) => `<tr><td><strong>${escapeHtml(student.name)}</strong><small>${escapeHtml(student.studentId)}</small></td><td><span class="metric-pill ${student.attendanceRate < 80 ? 'risk' : ''}">${student.attendanceRate}%</span><small>${student.attendancePresent}/${student.attendanceExpected} 人次</small></td><td><span class="metric-pill ${student.completionRate < 80 ? 'risk' : ''}">${student.completionRate}%</span><small>${student.answeredCount}/${student.assignmentCount} 题次</small></td><td><span class="metric-pill ${student.answeredCount && student.accuracyRate < 60 ? 'risk' : ''}">${student.accuracyRate}%</span><small>${student.correctCount}/${student.answeredCount} 次</small></td><td>${student.weakPoints.length ? student.weakPoints.map((point) => `<span class="weak-chip">${escapeHtml(point)}</span>`).join('') : '<span class="muted">暂无实际错题</span>'}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">当前筛选范围没有学生。</div>';
  $('#analytics-report-meta').textContent = latestReport?.createdAt
    ? `生成于 ${new Date(latestReport.createdAt).toLocaleString()} · 基于当前范围保存`
    : '尚未生成报告；AI 会严格依据上方真实统计给出分析与建议';
  RichText.render($('#analytics-report-content'), latestReport?.markdown || '', '点击“AI 生成学情报告”，获取薄弱知识点、重点关注学生与下一阶段教学建议。');
}

async function loadAnalytics(overrides = {}) {
  state.analyticsFilters = { ...state.analyticsFilters, ...overrides };
  const query = new URLSearchParams();
  for (const key of ['courseName', 'className', 'lessonId']) if (state.analyticsFilters[key]) query.set(key, state.analyticsFilters[key]);
  state.analytics = await api(`/api/analytics${query.size ? `?${query}` : ''}`);
  state.analyticsFilters = {
    courseName: state.analytics.filters.courseName,
    className: state.analytics.filters.className,
    lessonId: state.analytics.filters.lessonId,
  };
  renderAnalytics();
}

function renderNetwork() {
  const urls = state.data.lanUrls || [];
  $('#network-urls').innerHTML = urls.length ? urls.map((url) => `<div class="network-url"><code>${escapeHtml(url)}</code><button class="button secondary" data-copy="${escapeHtml(url)}">复制</button></div>`).join('') : '<div class="empty">没有检测到可用的局域网 IPv4 地址。</div>';
  $$('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
    await navigator.clipboard.writeText(button.dataset.copy);
    toast('局域网地址已复制');
  }));
}

async function refresh() {
  state.data = await api('/api/state');
  renderLessons();
  renderSettings();
  renderStudents();
  renderNetwork();
  const hasProcessing = state.data.lessons.some((item) => ['queued', 'processing'].includes(item.status));
  clearTimeout(state.poller);
  if (hasProcessing) state.poller = setTimeout(refresh, 2500);
}

function closeLessonStream() {
  if (state.lessonStream) state.lessonStream.close();
  state.lessonStream = null;
}

function watchLessonStream(id) {
  closeLessonStream();
  const stream = new EventSource(`/api/lessons/${encodeURIComponent(id)}/stream`);
  state.lessonStream = stream;
  stream.onmessage = (event) => {
    if (!state.activeLesson || state.activeLesson.id !== id) return;
    try {
      const update = JSON.parse(event.data);
      Object.assign(state.activeLesson, update);
      const listItem = state.data?.lessons?.find((item) => item.id === id);
      if (listItem) Object.assign(listItem, update);
      if (['ai', 'exercises'].includes(state.activeTab)) renderDialogContent();
      if (!['queued', 'processing'].includes(update.status)) {
        closeLessonStream();
        refresh().catch((error) => toast(error.message, true));
      }
    } catch { /* Ignore malformed stream events and keep the connection alive. */ }
  };
}

async function openLesson(id) {
  closeLessonStream();
  state.activeLesson = await api(`/api/lessons/${encodeURIComponent(id)}`);
  state.activeTab = 'ai';
  $('#dialog-week').textContent = `第 ${state.activeLesson.teachingWeek}/${state.activeLesson.totalWeeks} 周`;
  $('#dialog-title').textContent = state.activeLesson.title;
  $('#dialog-meta').textContent = `${state.activeLesson.courseName || '未填写课程'}${lessonClassLabel(state.activeLesson) ? ` · ${lessonClassLabel(state.activeLesson)}` : ''} · ${state.activeLesson.date || '未填写日期'} · ${state.activeLesson.sourceFilename}`;
  const notice = state.activeLesson.error || state.activeLesson.warning || '';
  $('#dialog-error').hidden = !notice;
  $('#dialog-error').textContent = notice;
  $('#dialog-error').classList.toggle('warning', Boolean(state.activeLesson.warning && !state.activeLesson.error));
  $('#courseware-button').textContent = state.activeLesson.materials?.some((item) => item.type === 'ai_generated') ? '重新生成 AI 课件' : '生成 AI 课件';
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === 'ai'));
  renderDialogContent();
  if (!$('#lesson-dialog').open) $('#lesson-dialog').showModal();
  if (['queued', 'processing'].includes(state.activeLesson.status)) watchLessonStream(id);
}

const exerciseTypes = [
  { value: 'choice', label: '选择题', defaultCount: 4, defaultDifficulty: 'medium' },
  { value: 'short_answer', label: '简答题', defaultCount: 2, defaultDifficulty: 'medium' },
  { value: 'application', label: '实践 / 应用题', defaultCount: 0, defaultDifficulty: 'hard' },
];
const difficultyOptions = [
  { value: 'mixed', label: '混合难度' }, { value: 'easy', label: '简单' },
  { value: 'medium', label: '中等' }, { value: 'hard', label: '困难' },
];

function exerciseConfigRows(prefix, configured = []) {
  const byType = new Map((configured || []).map((item) => [item.type === 'coding' ? 'application' : item.type, item]));
  return exerciseTypes.map((type) => {
    const current = byType.get(type.value) || { count: type.defaultCount, difficulty: type.defaultDifficulty };
    return `<div class="exercise-config-row"><strong>${type.label}</strong><label><span>数量</span><input type="number" name="${prefix}${type.value}_count" min="0" max="30" value="${Number(current.count) || 0}" required></label><label><span>难度</span><select name="${prefix}${type.value}_difficulty">${difficultyOptions.map((item) => `<option value="${item.value}" ${item.value === current.difficulty ? 'selected' : ''}>${item.label}</option>`).join('')}</select></label></div>`;
  }).join('');
}

function exerciseCoverage(exercises, configured) {
  const actual = new Map(exerciseTypes.map((type) => [type.value, 0]));
  for (const exercise of exercises || []) {
    const type = exercise.type === 'coding' ? 'application' : exercise.type;
    if (actual.has(type)) actual.set(type, actual.get(type) + 1);
  }
  const expected = new Map((configured || []).map((item) => [item.type === 'coding' ? 'application' : item.type, Math.max(0, Number(item.count) || 0)]));
  const rows = exerciseTypes.map((type) => ({
    ...type,
    expected: expected.has(type.value) ? expected.get(type.value) : type.defaultCount,
    actual: actual.get(type.value) || 0,
    difficulty: (configured || []).find((item) => (item.type === 'coding' ? 'application' : item.type) === type.value)?.difficulty || type.defaultDifficulty,
  }));
  return {
    rows,
    missing: rows.filter((item) => item.actual < item.expected),
    missingConfigs: rows.map((item) => ({ type: item.value, count: Math.max(0, item.expected - item.actual), difficulty: item.difficulty })),
  };
}

function readExerciseBlueprint(form, prefix) {
  const typeConfigs = exerciseTypes.map((type) => ({
    type: type.value,
    count: Number(form.get(`${prefix}${type.value}_count`)) || 0,
    difficulty: form.get(`${prefix}${type.value}_difficulty`) || 'mixed',
  }));
  const total = typeConfigs.reduce((sum, item) => sum + item.count, 0);
  if (total < 1 || total > 30) throw new Error('每个章节的题目总数必须在 1–30 道之间');
  return typeConfigs;
}

function renderDialogContent() {
  const lesson = state.activeLesson;
  if (!lesson) return;
  const content = $('#dialog-content');
  if (state.activeTab === 'source') RichText.render(content, lesson.rawText, '没有原文');
  else if (state.activeTab === 'exercises') {
    const exercises = lesson.exercises || [];
    const configured = lesson.exerciseOptions?.typeConfigs || [];
    const coverage = exerciseCoverage(exercises, configured);
    const formConfigs = coverage.missing.length ? coverage.missingConfigs : configured;
    const coverageText = coverage.rows.map((item) => `${item.label} ${item.actual}/${item.expected}`).join(' · ');
    const generating = lesson.status === 'processing' && lesson.processingStage === 'exercises';
    const progress = lesson.exerciseProgress;
    const progressText = progress
      ? `正在生成${exerciseTypeLabel(progress.type)}：本批已收到 ${progress.actual}/${progress.expected} 道`
      : '正在连接 AI 并准备本周题库…';
    content.innerHTML = `<form id="exercise-generator-form" class="exercise-generator">
      <div class="exercise-generator-heading"><strong>${generating ? '正在生成本周题库' : (coverage.missing.length ? '补齐当前章节题库' : '为当前章节继续出题')}</strong><small>${escapeHtml(coverageText)}</small></div>
      ${generating ? `<div class="exercise-live-progress"><span class="streaming-dot"></span><strong>${escapeHtml(progressText)}</strong><small>已完成的题目会立即显示在下方，无需离开或刷新页面。</small></div>` : (coverage.missing.length ? `<div class="exercise-coverage-warning">当前题库还缺：${escapeHtml(coverage.missing.map((item) => `${item.label} ${item.expected - item.actual} 道`).join('、'))}。下方已自动填写缺少数量。</div>` : '')}
      <div class="exercise-config-grid">${exerciseConfigRows('manual_', formConfigs)}</div>
      <div class="exercise-generator-actions"><small>每种题型可分别设置数量与难度，单次合计不超过 30 道</small><button class="button primary" type="submit" ${generating ? 'disabled' : ''}>${generating ? '题库生成中…' : (coverage.missing.length ? '补齐缺少题目' : '确认参数并生成')}</button></div>
    </form><div class="exercise-list">${exercises.length ? exercises.map((item, index) => `<div class="exercise-item"><div class="exercise-meta"><span class="badge">${escapeHtml(exerciseTypeLabel(item.type))}</span><span>${escapeHtml(item.difficulty)}</span><span>${escapeHtml(item.knowledgePoint || '')}</span><span>${item.published ? '已发放' : '待发放'}</span></div><div class="exercise-question"><span class="exercise-index">${index + 1}</span><div class="markdown-body">${richHtml(item.question)}</div></div><div class="muted answer-block"><strong>参考答案：</strong><div class="markdown-body">${richHtml(item.answer)}</div></div><div class="exercise-actions"><button class="button ${item.published ? 'danger' : 'primary'}" data-toggle-exercise="${escapeHtml(item.id)}" data-published="${item.published}">${item.published ? '撤回' : '发放'}</button></div></div>`).join('') : `<div class="empty">${generating ? '<strong>AI 正在生成第一批题目…</strong><br>收到后会自动出现在这里。' : '暂无题目，请在上方选择参数后生成。'}</div>`}</div>`;
    RichText.typeset(content);
    $('#exercise-generator-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const form = new FormData(event.currentTarget);
      button.disabled = true;
      try {
        const typeConfigs = readExerciseBlueprint(form, 'manual_');
        const request = api(`/api/lessons/${encodeURIComponent(lesson.id)}/generate-exercises`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ typeConfigs, preserveExerciseOptions: true }),
        });
        Object.assign(state.activeLesson, { status: 'processing', processingStage: 'exercises', exerciseProgress: null });
        renderDialogContent();
        watchLessonStream(lesson.id);
        const result = await request;
        toast(result.warning || `已生成 ${result.exercises.length} 道题`, false, Boolean(result.warning));
        state.activeLesson = await api(`/api/lessons/${encodeURIComponent(lesson.id)}`);
        state.activeTab = 'exercises';
        renderDialogContent();
      } catch (error) { toast(error.message, true); }
      finally { button.disabled = false; }
    });
    $$('[data-toggle-exercise]').forEach((button) => button.addEventListener('click', async () => {
      const action = button.dataset.published === 'true' ? 'unpublish' : 'publish';
      try { await api(`/api/lessons/${encodeURIComponent(lesson.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exerciseIds: [button.dataset.toggleExercise] }) }); await openLesson(lesson.id); }
      catch (error) { toast(error.message, true); }
    }));
  } else if (state.activeTab === 'attendance') {
    const rows = lesson.attendance || [];
    content.innerHTML = rows.length ? `<table class="attendance-table"><thead><tr><th>学号</th><th>状态</th><th>签到时间</th></tr></thead><tbody>${rows.map((item) => `<tr><td>${escapeHtml(item.studentId)}</td><td>到课</td><td>${escapeHtml(new Date(item.signedAt).toLocaleString())}</td></tr>`).join('')}</tbody></table>` : '<div class="empty">本教学周暂无签到记录。</div>';
  } else if (state.activeTab === 'materials') {
    const materials = lesson.materials || [];
    content.innerHTML = `<div class="exercise-list"><form id="lesson-material-form" class="inline"><input type="file" name="materialFile" required><button class="button primary">上传本周资料</button></form>${materials.length ? materials.map((item) => `<div class="student-card"><div><h3>${escapeHtml(item.filename)}</h3><p>${item.type === 'ai_generated' ? 'AI 课件 · 支持 Markdown 与 LaTeX' : escapeHtml(item.type || '资料')}</p></div><div class="student-card-actions">${item.type === 'ai_generated' ? `<button class="button primary" data-preview-material="${escapeHtml(item.id)}">预览课件</button>` : ''}<a class="button secondary" href="/api/materials/${escapeHtml(item.id)}/download?download=1">下载</a><button class="button danger" data-delete-material="${escapeHtml(item.id)}">删除</button></div></div>`).join('') : '<div class="empty">暂无课件资料。</div>'}</div>`;
    $('#lesson-material-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); form.set('lessonId', lesson.id); try { await api('/api/materials', { method: 'POST', body: form }); toast('资料已上传'); await openLesson(lesson.id); } catch (error) { toast(error.message, true); } });
    $$('[data-delete-material]').forEach((button) => button.addEventListener('click', async () => { try { await api(`/api/materials/${button.dataset.deleteMaterial}`, { method: 'DELETE' }); await openLesson(lesson.id); } catch (error) { toast(error.message, true); } }));
    $$('[data-preview-material]').forEach((button) => button.addEventListener('click', () => previewCourseware(button.dataset.previewMaterial)));
  } else if (lesson.status === 'queued') {
    content.innerHTML = '<div class="empty"><strong>本教学周已进入队列</strong><br><span class="muted">程序会先完成所有前序教学周的方案与题库，然后自动处理本周。刷新或重启程序不会丢失队列。</span></div>';
  } else if (lesson.status === 'processing') {
    RichText.render(content, lesson.aiResult, lesson.processingStage === 'exercises' ? '教学周方案已完成，正在生成题库…' : 'AI 正在流式整理本教学周方案，请稍候…');
    const indicator = document.createElement('div');
    indicator.className = 'streaming-indicator';
    indicator.textContent = lesson.processingStage === 'exercises' ? '正在生成本周题库…' : '正在接收 AI 内容…';
    content.append(indicator);
    content.scrollTop = content.scrollHeight;
  }
  else RichText.render(content, lesson.aiResult, '尚未生成 AI 教学周方案。可点击“AI 重新整理”。');
}

$$('.nav-item').forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));
$$('[data-go]').forEach((item) => item.addEventListener('click', () => showView(item.dataset.go)));
$('#refresh-button').addEventListener('click', async () => {
  try {
    await refresh();
    if ($('.nav-item.active')?.dataset.view === 'analytics') await loadAnalytics();
  } catch (error) { toast(error.message, true); }
});
$('#analytics-course').addEventListener('change', (event) => loadAnalytics({ courseName: event.target.value, className: '', lessonId: '' }).catch((error) => toast(error.message, true)));
$('#analytics-class').addEventListener('change', (event) => loadAnalytics({ className: event.target.value }).catch((error) => toast(error.message, true)));
$('#analytics-lesson').addEventListener('change', (event) => loadAnalytics({ lessonId: event.target.value }).catch((error) => toast(error.message, true)));
$('#analytics-refresh-button').addEventListener('click', (event) => {
  event.currentTarget.disabled = true;
  loadAnalytics().catch((error) => toast(error.message, true)).finally(() => { event.currentTarget.disabled = false; });
});
$('#analytics-report-button').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'AI 正在分析…';
  try {
    await api('/api/analytics/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.analyticsFilters),
    });
    await loadAnalytics();
    toast('学情分析报告已生成并保存');
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = 'AI 生成学情报告'; }
});

function renderImportExerciseSettings() {
  const semester = document.querySelector('input[name="scope"]:checked')?.value === 'semester';
  const mode = semester ? $('#exercise-mode').value : 'uniform';
  $('#exercise-mode').value = mode;
  $('#exercise-mode-field').hidden = !semester;
  if (!$('#uniform-exercise-settings').innerHTML) $('#uniform-exercise-settings').innerHTML = exerciseConfigRows('exercise_');
  $('#uniform-exercise-settings').hidden = mode === 'per_week';
  $('#per-week-exercise-settings').hidden = mode !== 'per_week';
  if (mode === 'per_week') {
    const totalWeeks = Math.min(40, Math.max(1, Number(document.querySelector('[name="totalWeeks"]').value) || 16));
    $('#per-week-exercise-settings').innerHTML = Array.from({ length: totalWeeks }, (_, index) => `<details class="week-exercise-card" ${index === 0 ? 'open' : ''}><summary>第 ${index + 1} 章节 / 教学周</summary><div class="exercise-config-grid">${exerciseConfigRows(`week_${index + 1}_`)}</div></details>`).join('');
  }
}

$('#batch-mode-button').addEventListener('click', () => {
  state.batchMode = !state.batchMode;
  state.selectedLessonIds.clear();
  renderLessons();
});
$('#batch-cancel-button').addEventListener('click', () => {
  state.batchMode = false;
  state.selectedLessonIds.clear();
  renderLessons();
});
$('#select-all-lessons').addEventListener('change', (event) => {
  const ids = visibleLessons().map((item) => item.id);
  if (event.target.checked) ids.forEach((id) => state.selectedLessonIds.add(id));
  else ids.forEach((id) => state.selectedLessonIds.delete(id));
  renderLessons();
});
$('#batch-delete-button').addEventListener('click', async () => {
  const ids = [...state.selectedLessonIds];
  if (!ids.length || !confirm(`确认永久删除所选的 ${ids.length} 个教案及其关联题库、作答、签到和课件资料？此操作无法撤销。`)) return;
  const button = $('#batch-delete-button');
  button.disabled = true;
  try {
    const result = await api('/api/lessons/batch-delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
    state.batchMode = false;
    state.selectedLessonIds.clear();
    toast(`已删除 ${result.deleted} 个教案`);
    await refresh();
  } catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});

$$('input[name="scope"]').forEach((radio) => radio.addEventListener('change', () => {
  const semester = radio.value === 'semester' && radio.checked;
  $$('.scope-card').forEach((card) => card.classList.toggle('selected', card.querySelector('input').checked));
  $('#week-number-field').hidden = semester;
  $('#total-weeks-field').hidden = !semester;
  $('#date-label').textContent = semester ? '第一教学周日期' : '上课日期';
  $('#scope-help').textContent = semester ? '一次导入即可：程序会自动拆分全部教学周，按周顺序生成方案和题库；未轮到的周会稳定显示为“排队中”。' : '文件将保存为一个教学周；若已配置 API Key，会自动生成教学周方案及题库。';
  renderImportExerciseSettings();
}));

$('#exercise-mode').addEventListener('change', renderImportExerciseSettings);
document.querySelector('[name="totalWeeks"]').addEventListener('change', renderImportExerciseSettings);

$('#lesson-file').addEventListener('change', (event) => {
  $('#file-label').textContent = event.target.files[0]?.name || '选择教案文件';
});

$('#import-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('#import-button');
  button.disabled = true;
  button.textContent = '正在读取教案…';
  try {
    const form = new FormData(event.currentTarget);
    form.set('classNames', JSON.stringify($$('[name="linkedClass"]:checked').map((input) => input.value)));
    const mode = form.get('scope') === 'semester' ? form.get('exerciseMode') : 'uniform';
    if (mode === 'per_week') {
      const totalWeeks = Number(form.get('totalWeeks')) || 1;
      for (let week = 1; week <= totalWeeks; week += 1) readExerciseBlueprint(form, `week_${week}_`);
    } else readExerciseBlueprint(form, 'exercise_');
    form.set('lessonFile', $('#lesson-file').files[0]);
    const result = await api('/api/import', { method: 'POST', body: form });
    toast(`已导入 ${result.count} 个教学周${result.processing ? '，已进入顺序处理队列' : '；配置 API Key 后会自动整理并生成题库'}`);
    await refresh();
    showView('lessons');
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '导入并处理';
  }
});

$('#settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const form = new FormData(formElement);
  try {
    await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(form)) });
    toast('AI 设置已保存');
    formElement.apiKey.value = '';
    await refresh();
  } catch (error) { toast(error.message, true); }
});

$('#password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try { await api('/api/settings/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); formElement.reset(); toast('教师密码已修改'); }
  catch (error) { toast(error.message, true); }
});

$('#mail-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try { await api('/api/settings/mail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); formElement.password.value = ''; toast('邮箱设置已保存'); await refresh(); }
  catch (error) { toast(error.message, true); }
});

$('#test-mail-button').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try { await api('/api/settings/mail/test', { method: 'POST' }); toast('测试邮件已发送'); }
  catch (error) { toast(error.message, true); } finally { event.target.disabled = false; }
});

$('#student-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try { await api('/api/students', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(formElement))) }); formElement.reset(); toast('学生已保存'); await refresh(); }
  catch (error) { toast(error.message, true); }
});

$('#roster-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const button = $('#roster-import-button');
  const status = $('#roster-import-status');
  const file = $('#roster-file').files[0];
  if (!file) return;
  button.disabled = true;
  button.textContent = '正在识别选课单…';
  status.hidden = false;
  status.className = 'roster-import-status loading';
  status.textContent = `正在读取 ${file.name}，识别课程、班级和学生名单…`;
  try {
    const result = await api('/api/students/import', { method: 'POST', body: new FormData(formElement) });
    status.className = `roster-import-status success${result.warning ? ' warning' : ''}`;
    status.innerHTML = `<strong>班级建立完成</strong><span>${escapeHtml(result.courseName || '未命名课程')} · ${escapeHtml(result.className || '未命名班级')}</span><small>共 ${result.count} 名学生：新增 ${result.added} 名，更新 ${result.updated} 名${result.term ? ` · ${escapeHtml(result.term)}` : ''}</small>${result.warning ? `<em>${escapeHtml(result.warning)}</em>` : ''}`;
    toast(`已建立 ${result.className || '班级'}，导入 ${result.count} 名学生`, false, Boolean(result.warning));
    $('#roster-file').value = '';
    $('#roster-file-label').textContent = '继续选择另一份选课单';
    await refresh();
  } catch (error) {
    status.className = 'roster-import-status error';
    status.textContent = error.message;
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = '导入选课单并建立班级';
  }
});

$('#roster-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  $('#roster-file-label').textContent = file?.name || '选择选课单，一键建立班级';
  if (file) $('#roster-form').requestSubmit();
});

$('#class-material-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try { await api('/api/materials', { method: 'POST', body: new FormData(formElement) }); formElement.reset(); toast('班级资料已上传'); await refresh(); }
  catch (error) { toast(error.message, true); }
});

$('#test-button').addEventListener('click', async (event) => {
  event.target.disabled = true;
  try { const result = await api('/api/test-connection', { method: 'POST' }); toast(`连接成功：${result.message}`); }
  catch (error) { toast(error.message, true); }
  finally { event.target.disabled = false; }
});

$('#models-button').addEventListener('click', async (event) => {
  const button = event.target;
  const formElement = $('#settings-form');
  button.disabled = true;
  button.textContent = '正在筛选…';
  try {
    const result = await api('/api/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: formElement.baseUrl.value, apiKey: formElement.apiKey.value }),
    });
    await refresh();
    $('#model-filter-status').childNodes[0].textContent = `已获取 ${result.models.length} 个适用模型，已排除 ${result.excluded} 个不适合教学工作流的模型。`;
    toast(`已获取 ${result.models.length} 个适用模型，已排除 ${result.excluded} 个不适合教学工作流的模型`);
    $('#model-options-select').focus();
  }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = '获取适用模型'; }
});

$('#settings-form').baseUrl.addEventListener('input', updateApiKeyInvite);
$('#settings-form').apiKey.addEventListener('input', updateApiKeyInvite);
$('#model-options-select').addEventListener('change', (event) => {
  if (event.currentTarget.value) $('#settings-form').model.value = event.currentTarget.value;
});
$('#grading-model-options-select').addEventListener('change', (event) => {
  $('#settings-form').gradingModel.value = event.currentTarget.value;
});
$('#settings-form').model.addEventListener('input', (event) => syncModelSelect(event.currentTarget, $('#model-options-select')));
$('#settings-form').gradingModel.addEventListener('input', (event) => syncModelSelect(event.currentTarget, $('#grading-model-options-select')));

$('#dialog-close').addEventListener('click', () => { closeLessonStream(); $('#lesson-dialog').close(); });
$('#report-close').addEventListener('click', () => $('#report-dialog').close());
$('#courseware-preview-close').addEventListener('click', () => $('#courseware-preview-dialog').close());
$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  state.activeTab = tab.dataset.tab;
  $$('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  renderDialogContent();
}));

$('#process-button').addEventListener('click', async () => {
  if (!state.activeLesson) return;
  try {
    await api(`/api/lessons/${encodeURIComponent(state.activeLesson.id)}/process`, { method: 'POST' });
    toast('已加入按周顺序处理队列');
    state.activeLesson = await api(`/api/lessons/${encodeURIComponent(state.activeLesson.id)}`);
    renderDialogContent();
    watchLessonStream(state.activeLesson.id);
    await refresh();
  } catch (error) { toast(error.message, true); }
});

async function previewCourseware(materialId) {
  try {
    const result = await api(`/api/materials/${encodeURIComponent(materialId)}/preview`);
    $('#courseware-preview-title').textContent = result.filename || '课件预览';
    RichText.render($('#courseware-preview-content'), result.markdown, '暂无课件内容。');
    if (!$('#courseware-preview-dialog').open) $('#courseware-preview-dialog').showModal();
  } catch (error) { toast(error.message, true); }
}

function openCoursewareClassDialog() {
  if (!state.activeLesson) return;
  const selected = new Set((Array.isArray(state.activeLesson.classNames) ? state.activeLesson.classNames : [state.activeLesson.className]).filter(Boolean));
  const classes = establishedClasses(state.data?.students || []);
  $('#courseware-class-picker').innerHTML = classes.length ? classes.map((item) => `<label class="class-choice">
    <input type="checkbox" name="coursewareClass" value="${escapeHtml(item.className)}" ${selected.has(item.className) ? 'checked' : ''}>
    <span><strong>${escapeHtml(item.className)}</strong><small>${escapeHtml(item.courseName || '未指定课程')} · ${item.count} 名学生</small></span>
  </label>`).join('') : '<div class="empty">还没有已建立班级。请先从“学生与班级”导入选课单。</div>';
  if (!$('#courseware-class-dialog').open) $('#courseware-class-dialog').showModal();
}

$('#courseware-button').addEventListener('click', openCoursewareClassDialog);
$('#courseware-class-close').addEventListener('click', () => $('#courseware-class-dialog').close());
$('#courseware-class-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.activeLesson) return;
  const button = $('#courseware-generate-button');
  const lessonId = state.activeLesson.id;
  button.disabled = true;
  button.textContent = '正在保存并生成课件…';
  try {
    const classNames = $$('[name="coursewareClass"]:checked').map((input) => input.value);
    await api(`/api/lessons/${encodeURIComponent(lessonId)}/classes`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ classNames }),
    });
    const result = await api(`/api/lessons/${encodeURIComponent(lessonId)}/courseware`, { method: 'POST' });
    state.activeLesson = await api(`/api/lessons/${encodeURIComponent(lessonId)}`);
    const listItem = state.data?.lessons?.find((item) => item.id === lessonId);
    if (listItem) Object.assign(listItem, { classNames: state.activeLesson.classNames, className: state.activeLesson.className });
    state.activeTab = 'materials';
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === 'materials'));
    renderDialogContent();
    renderLessons();
    $('#courseware-class-dialog').close();
    toast(result.replaced ? 'AI 课件已重新生成并替换旧版本' : 'AI 课件已生成');
    await previewCourseware(result.material.id);
  } catch (error) { toast(error.message, true); }
  finally {
    button.disabled = false;
    button.textContent = '保存班级并生成 AI 课件';
    $('#courseware-button').textContent = state.activeLesson?.materials?.some((item) => item.type === 'ai_generated') ? '重新生成 AI 课件' : '生成 AI 课件';
  }
});
async function sendLessonPackage(test, button) { if (!state.activeLesson) return; button.disabled = true; try { const result = await api(`/api/lessons/${encodeURIComponent(state.activeLesson.id)}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test }) }); toast(test ? '测试邮件已发送' : `已发送给 ${result.count} 名学生`); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } }
$('#test-package-button').addEventListener('click', (event) => sendLessonPackage(true, event.target));
$('#send-package-button').addEventListener('click', (event) => { if (confirm('确认把本周讲义和已发放习题发送给全班？')) sendLessonPackage(false, event.target); });

$('#delete-button').addEventListener('click', async () => {
  if (!state.activeLesson || !confirm(`确认删除“${state.activeLesson.title}”？`)) return;
  try {
    await api(`/api/lessons/${encodeURIComponent(state.activeLesson.id)}`, { method: 'DELETE' });
    closeLessonStream();
    $('#lesson-dialog').close();
    toast('教案已删除');
    await refresh();
  } catch (error) { toast(error.message, true); }
});

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    await api('/api/auth/admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) });
    $('#admin-login').close();
    await refresh();
  } catch (error) { toast(error.message, true); }
});

document.querySelector('input[name="startDate"]').value = new Date().toISOString().slice(0, 10);
renderImportExerciseSettings();
(async function boot() {
  const auth = await api('/api/auth/status');
  if (auth.role === 'admin') await refresh(); else $('#admin-login').showModal();
})().catch((error) => toast(error.message, true));
