const state = { data: null, activeLesson: null, activeTab: 'ai', poller: null };
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

function statusLabel(status) {
  return { done: '✓ AI 已整理', processing: '● AI 处理中', error: '! 处理失败', ready: '待 AI 整理' }[status] || status;
}

function renderLessons() {
  const lessons = state.data.lessons || [];
  $('#metric-total').textContent = lessons.length;
  $('#metric-done').textContent = lessons.filter((item) => item.status === 'done').length;
  $('#metric-processing').textContent = lessons.filter((item) => item.status === 'processing').length;
  $('#lesson-list').innerHTML = lessons.length ? lessons.map((lesson) => `
    <article class="lesson-row" data-lesson-id="${escapeHtml(lesson.id)}">
      <div class="week-badge">第 ${escapeHtml(lesson.teachingWeek)} 周</div>
      <div><h3>${escapeHtml(lesson.title)}</h3><p>${escapeHtml(lesson.courseName || '未填写课程')}${lesson.className ? ` · ${escapeHtml(lesson.className)}` : ''} · ${escapeHtml(lesson.sourceFilename)}</p></div>
      <span class="status ${escapeHtml(lesson.status)}">${escapeHtml(statusLabel(lesson.status))}</span>
      <span class="date">${escapeHtml(lesson.date || '')}</span>
    </article>`).join('') : '<div class="empty">还没有教案。请先导入一个教学周或整学期教案。</div>';
  $$('.lesson-row').forEach((row) => row.addEventListener('click', () => openLesson(row.dataset.lessonId)));
}

function renderSettings() {
  const settings = state.data.settings;
  const form = $('#settings-form');
  form.baseUrl.value = settings.baseUrl || '';
  form.model.value = settings.model || '';
  form.gradingModel.value = settings.gradingModel || settings.model || '';
  form.attendanceTimeoutMinutes.value = settings.attendanceTimeoutMinutes || 1440;
  $('#key-status').textContent = settings.hasApiKey ? '已保存加密 API Key；留空不会覆盖' : '尚未保存 API Key';
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
  const hasProcessing = state.data.lessons.some((item) => item.status === 'processing');
  clearTimeout(state.poller);
  if (hasProcessing) state.poller = setTimeout(refresh, 2500);
}

async function openLesson(id) {
  state.activeLesson = await api(`/api/lessons/${encodeURIComponent(id)}`);
  state.activeTab = 'ai';
  $('#dialog-week').textContent = `第 ${state.activeLesson.teachingWeek}/${state.activeLesson.totalWeeks} 周`;
  $('#dialog-title').textContent = state.activeLesson.title;
  $('#dialog-meta').textContent = `${state.activeLesson.courseName || '未填写课程'} · ${state.activeLesson.date || '未填写日期'} · ${state.activeLesson.sourceFilename}`;
  $('#dialog-error').hidden = !state.activeLesson.error;
  $('#dialog-error').textContent = state.activeLesson.error || '';
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === 'ai'));
  renderDialogContent();
  if (!$('#lesson-dialog').open) $('#lesson-dialog').showModal();
}

function renderDialogContent() {
  const lesson = state.activeLesson;
  if (!lesson) return;
  const content = $('#dialog-content');
  if (state.activeTab === 'source') RichText.render(content, lesson.rawText, '没有原文');
  else if (state.activeTab === 'exercises') {
    const exercises = lesson.exercises || [];
    content.innerHTML = `<form id="exercise-generator-form" class="exercise-generator">
      <div><strong>AI 出题</strong><small>按本周教学内容生成，可组合多种题型</small></div>
      <fieldset><legend>题型</legend><label><input type="checkbox" name="types" value="choice" checked> 选择题</label><label><input type="checkbox" name="types" value="short_answer" checked> 简答题</label><label><input type="checkbox" name="types" value="coding"> 编程题</label></fieldset>
      <label><span>数量</span><input type="number" name="count" min="1" max="30" value="6" required></label>
      <label><span>难度</span><select name="difficulty"><option value="mixed">混合难度</option><option value="easy">简单</option><option value="medium">中等</option><option value="hard">困难</option></select></label>
      <button class="button primary" type="submit">按参数生成</button>
    </form><div class="exercise-list">${exercises.length ? exercises.map((item, index) => `<div class="exercise-item"><div class="exercise-meta"><span class="badge">${escapeHtml(item.type)}</span><span>${escapeHtml(item.difficulty)}</span><span>${escapeHtml(item.knowledgePoint || '')}</span><span>${item.published ? '已发放' : '待发放'}</span></div><div class="exercise-question"><strong>${index + 1}.</strong><div class="markdown-body">${richHtml(item.question)}</div></div><div class="muted answer-block"><strong>参考答案：</strong><div class="markdown-body">${richHtml(item.answer)}</div></div><div class="exercise-actions"><button class="button ${item.published ? 'danger' : 'primary'}" data-toggle-exercise="${escapeHtml(item.id)}" data-published="${item.published}">${item.published ? '撤回' : '发放'}</button></div></div>`).join('') : '<div class="empty">暂无题目，请在上方选择参数后生成。</div>'}</div>`;
    RichText.typeset(content);
    $('#exercise-generator-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = event.currentTarget.querySelector('button[type="submit"]');
      const form = new FormData(event.currentTarget);
      const types = form.getAll('types');
      if (!types.length) return toast('请至少选择一种题型', true);
      button.disabled = true;
      try {
        const result = await api(`/api/lessons/${encodeURIComponent(lesson.id)}/generate-exercises`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ types, count: Number(form.get('count')), difficulty: form.get('difficulty') }),
        });
        toast(`已生成 ${result.exercises.length} 道题`);
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
    content.innerHTML = `<div class="exercise-list"><form id="lesson-material-form" class="inline"><input type="file" name="materialFile" required><button class="button primary">上传本周资料</button></form>${materials.length ? materials.map((item) => `<div class="student-card"><div><h3>${escapeHtml(item.filename)}</h3><p>${escapeHtml(item.type || '资料')}</p></div><button class="button danger" data-delete-material="${escapeHtml(item.id)}">删除</button></div>`).join('') : '<div class="empty">暂无课件资料。</div>'}</div>`;
    $('#lesson-material-form').addEventListener('submit', async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); form.set('lessonId', lesson.id); try { await api('/api/materials', { method: 'POST', body: form }); toast('资料已上传'); await openLesson(lesson.id); } catch (error) { toast(error.message, true); } });
    $$('[data-delete-material]').forEach((button) => button.addEventListener('click', async () => { try { await api(`/api/materials/${button.dataset.deleteMaterial}`, { method: 'DELETE' }); await openLesson(lesson.id); } catch (error) { toast(error.message, true); } }));
  } else if (lesson.status === 'processing') RichText.render(content, 'AI 正在整理本教学周方案，请稍候…');
  else RichText.render(content, lesson.aiResult, '尚未生成 AI 教学周方案。可点击“AI 重新整理”。');
}

$$('.nav-item').forEach((item) => item.addEventListener('click', () => showView(item.dataset.view)));
$$('[data-go]').forEach((item) => item.addEventListener('click', () => showView(item.dataset.go)));
$('#refresh-button').addEventListener('click', () => refresh().catch((error) => toast(error.message, true)));

$$('input[name="scope"]').forEach((radio) => radio.addEventListener('change', () => {
  const semester = radio.value === 'semester' && radio.checked;
  $$('.scope-card').forEach((card) => card.classList.toggle('selected', card.querySelector('input').checked));
  $('#week-number-field').hidden = semester;
  $('#total-weeks-field').hidden = !semester;
  $('#date-label').textContent = semester ? '第一教学周日期' : '上课日期';
  $('#scope-help').textContent = semester ? '优先识别“第 N 周”标题；若原文没有周标题，将按内容量拆分为指定周数。' : '文件将保存为一个教学周；若已配置 API Key，会自动生成教学周方案。';
}));

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
    form.set('lessonFile', $('#lesson-file').files[0]);
    const result = await api('/api/import', { method: 'POST', body: form });
    toast(`已导入 ${result.count} 个教学周${result.processing ? '，AI 正在依次处理' : ''}`);
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

$('#dialog-close').addEventListener('click', () => $('#lesson-dialog').close());
$('#report-close').addEventListener('click', () => $('#report-dialog').close());
$$('.tab').forEach((tab) => tab.addEventListener('click', () => {
  state.activeTab = tab.dataset.tab;
  $$('.tab').forEach((item) => item.classList.toggle('active', item === tab));
  renderDialogContent();
}));

$('#process-button').addEventListener('click', async () => {
  if (!state.activeLesson) return;
  try {
    await api(`/api/lessons/${encodeURIComponent(state.activeLesson.id)}/process`, { method: 'POST' });
    toast('已加入 AI 处理队列');
    $('#lesson-dialog').close();
    await refresh();
  } catch (error) { toast(error.message, true); }
});

$('#courseware-button').addEventListener('click', async (event) => { if (!state.activeLesson) return; event.target.disabled = true; try { await api(`/api/lessons/${encodeURIComponent(state.activeLesson.id)}/courseware`, { method: 'POST' }); toast('AI HTML 课件已生成'); await openLesson(state.activeLesson.id); } catch (error) { toast(error.message, true); } finally { event.target.disabled = false; } });
async function sendLessonPackage(test, button) { if (!state.activeLesson) return; button.disabled = true; try { const result = await api(`/api/lessons/${encodeURIComponent(state.activeLesson.id)}/email`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ test }) }); toast(test ? '测试邮件已发送' : `已发送给 ${result.count} 名学生`); } catch (error) { toast(error.message, true); } finally { button.disabled = false; } }
$('#test-package-button').addEventListener('click', (event) => sendLessonPackage(true, event.target));
$('#send-package-button').addEventListener('click', (event) => { if (confirm('确认把本周讲义和已发放习题发送给全班？')) sendLessonPackage(false, event.target); });

$('#delete-button').addEventListener('click', async () => {
  if (!state.activeLesson || !confirm(`确认删除“${state.activeLesson.title}”？`)) return;
  try {
    await api(`/api/lessons/${encodeURIComponent(state.activeLesson.id)}`, { method: 'DELETE' });
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
(async function boot() {
  const auth = await api('/api/auth/status');
  if (auth.role === 'admin') await refresh(); else $('#admin-login').showModal();
})().catch((error) => toast(error.message, true));
