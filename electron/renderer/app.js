const state = { data: null, activeLesson: null, activeTab: 'ai', poller: null, lessonStream: null, batchMode: false, selectedLessonIds: new Set() };
const viewMeta = {
  lessons: ['教案与教学周', '管理单周教案与整学期教学安排'],
  import: ['导入教案', '支持 PDF、Word 和 Markdown 教案'],
  students: ['学生与班级', '管理名单、学习记录与个性化诊断'],
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

function toast(message, isError = false) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 3600);
}

function showView(name) {
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === name));
  $$('.view').forEach((item) => item.classList.toggle('active', item.id === `view-${name}`));
  $('#page-title').textContent = viewMeta[name][0];
  $('#page-subtitle').textContent = viewMeta[name][1];
}

function statusLabel(status, stage, warning = '') {
  if (status === 'processing') return stage === 'exercises' ? '● 正在生成题库' : '● 正在流式整理';
  if (status === 'done' && warning) return '✓ 方案完成 · 题库需补充';
  return { done: '✓ 方案与题库已完成', queued: '◷ 排队中', blocked: '! 等待前序周', error: '! 处理失败', ready: '等待 API Key' }[status] || status;
}

function updateBatchToolbar() {
  $('#batch-toolbar').hidden = !state.batchMode;
  $('#batch-mode-button').textContent = state.batchMode ? '退出批量管理' : '批量管理';
  $('#selected-lesson-count').textContent = state.selectedLessonIds.size;
  $('#batch-delete-button').disabled = !state.selectedLessonIds.size;
  const lessonIds = (state.data?.lessons || []).map((item) => item.id);
  $('#select-all-lessons').checked = Boolean(lessonIds.length) && lessonIds.every((id) => state.selectedLessonIds.has(id));
}

function renderLessons() {
  const lessons = state.data.lessons || [];
  $('#metric-total').textContent = lessons.length;
  $('#metric-done').textContent = lessons.filter((item) => item.status === 'done').length;
  $('#metric-processing').textContent = lessons.filter((item) => item.status === 'processing').length;
  $('#lesson-list').innerHTML = lessons.length ? lessons.map((lesson) => `
    <article class="lesson-row${state.batchMode ? ' batch-mode' : ''}" data-lesson-id="${escapeHtml(lesson.id)}">
      ${state.batchMode ? `<label class="lesson-select"><input type="checkbox" data-select-lesson="${escapeHtml(lesson.id)}" ${state.selectedLessonIds.has(lesson.id) ? 'checked' : ''} aria-label="选择第 ${escapeHtml(lesson.teachingWeek)} 周"></label>` : ''}
      <div class="week-badge">第 ${escapeHtml(lesson.teachingWeek)} 周</div>
      <div><h3>${escapeHtml(lesson.title)}</h3><p>${escapeHtml(lesson.courseName || '未填写课程')}${lesson.className ? ` · ${escapeHtml(lesson.className)}` : ''} · ${escapeHtml(lesson.sourceFilename)}</p></div>
      <span class="status ${escapeHtml(lesson.status)}">${escapeHtml(statusLabel(lesson.status, lesson.processingStage, lesson.warning))}</span>
      <span class="date">${escapeHtml(lesson.date || '')}</span>
    </article>`).join('') : '<div class="empty">还没有教案。请先导入一个教学周或整学期教案。</div>';
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
  $('#api-key-invite').hidden = Boolean(settings.hasApiKey);
  $('#model-options').innerHTML = (settings.modelOptions || []).map((model) => `<option value="${escapeHtml(model)}"></option>`).join('');
  const mailForm = $('#mail-form');
  for (const [key, value] of Object.entries(settings.mail || {})) if (mailForm.elements[key] && key !== 'password') mailForm.elements[key].value = value || '';
  mailForm.password.placeholder = settings.mail?.hasPassword ? '已保存；留空保留当前值' : '请输入授权码 / 密码';
}

function renderStudents() {
  const students = state.data.students || [];
  $('#student-total').textContent = students.length;
  $('#class-total').textContent = new Set(students.map((item) => item.className).filter(Boolean)).size;
  $('#submission-total').textContent = state.data.submissionCount || 0;
  $('#student-list').innerHTML = students.length ? students.map((student) => `
    <article class="student-card">
      <div><h3>${escapeHtml(student.name)} <span class="badge">${escapeHtml(student.studentId)}</span></h3><p>${escapeHtml(student.courseName || '未指定课程')} · ${escapeHtml(student.className || '未分班')} · ${escapeHtml(student.email || '未填写邮箱')}</p></div>
      <div class="student-card-actions"><button class="button secondary" data-report-student="${escapeHtml(student.studentId)}">AI 报告</button><button class="button secondary" data-target-student="${escapeHtml(student.studentId)}">个性化习题</button><button class="button secondary" data-email-student="${escapeHtml(student.studentId)}">发送报告</button><button class="button danger" data-delete-student="${escapeHtml(student.studentId)}">删除</button></div>
    </article>`).join('') : '<div class="empty">还没有学生，请手动添加或导入名册。</div>';
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
      if (state.activeTab === 'ai') renderDialogContent();
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
  $('#dialog-meta').textContent = `${state.activeLesson.courseName || '未填写课程'} · ${state.activeLesson.date || '未填写日期'} · ${state.activeLesson.sourceFilename}`;
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
    content.innerHTML = `<form id="exercise-generator-form" class="exercise-generator">
      <div><strong>为当前章节继续出题</strong><small>每种题型分别设置数量与难度，合计不超过 30 道</small></div>
      <div class="exercise-config-grid">${exerciseConfigRows('manual_', configured)}</div>
      <button class="button primary" type="submit">确认参数并生成</button>
    </form><div class="exercise-list">${exercises.length ? exercises.map((item, index) => `<div class="exercise-item"><div class="exercise-meta"><span class="badge">${escapeHtml(exerciseTypeLabel(item.type))}</span><span>${escapeHtml(item.difficulty)}</span><span>${escapeHtml(item.knowledgePoint || '')}</span><span>${item.published ? '已发放' : '待发放'}</span></div><div class="exercise-question"><strong>${index + 1}.</strong><div class="markdown-body">${richHtml(item.question)}</div></div><div class="muted answer-block"><strong>参考答案：</strong><div class="markdown-body">${richHtml(item.answer)}</div></div><div class="exercise-actions"><button class="button ${item.published ? 'danger' : 'primary'}" data-toggle-exercise="${escapeHtml(item.id)}" data-published="${item.published}">${item.published ? '撤回' : '发放'}</button></div></div>`).join('') : '<div class="empty">暂无题目，请在上方选择参数后生成。</div>'}</div>`;
    RichText.typeset(content);
    $('#exercise-generator-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const form = new FormData(event.currentTarget);
      button.disabled = true;
      try {
        const typeConfigs = readExerciseBlueprint(form, 'manual_');
        const result = await api(`/api/lessons/${encodeURIComponent(lesson.id)}/generate-exercises`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ typeConfigs }),
        });
        toast(result.warning || `已生成 ${result.exercises.length} 道题`, Boolean(result.warning));
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
$('#refresh-button').addEventListener('click', () => refresh().catch((error) => toast(error.message, true)));

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
  state.selectedLessonIds = new Set(event.target.checked ? (state.data?.lessons || []).map((item) => item.id) : []);
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
  const form = new FormData(event.currentTarget);
  try { const result = await api('/api/students/import', { method: 'POST', body: form }); toast(`已导入或更新 ${result.count} 名学生`); await refresh(); }
  catch (error) { toast(error.message, true); }
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
  event.target.disabled = true;
  try { const result = await api('/api/models', { method: 'POST' }); toast(`已获取 ${result.models.length} 个模型`); await refresh(); }
  catch (error) { toast(error.message, true); }
  finally { event.target.disabled = false; }
});

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

$('#courseware-button').addEventListener('click', async (event) => {
  if (!state.activeLesson) return;
  const button = event.currentTarget;
  const lessonId = state.activeLesson.id;
  button.disabled = true;
  button.textContent = '正在生成课件…';
  try {
    const result = await api(`/api/lessons/${encodeURIComponent(lessonId)}/courseware`, { method: 'POST' });
    state.activeLesson = await api(`/api/lessons/${encodeURIComponent(lessonId)}`);
    state.activeTab = 'materials';
    $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === 'materials'));
    renderDialogContent();
    toast(result.replaced ? 'AI 课件已重新生成并替换旧版本' : 'AI 课件已生成');
    await previewCourseware(result.material.id);
  } catch (error) { toast(error.message, true); }
  finally {
    button.disabled = false;
    button.textContent = state.activeLesson?.materials?.some((item) => item.type === 'ai_generated') ? '重新生成 AI 课件' : '生成 AI 课件';
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
