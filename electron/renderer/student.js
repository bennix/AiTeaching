const studentState = { data: null, lessonId: '', courseName: '', loginCatalog: [] };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const richHtml = (value, options) => RichText.html(value, options);
const exerciseTypeLabel = (type) => ({ choice: '选择题', short_answer: '简答题', application: '实践 / 应用题', coding: '编程题' }[type] || type);
async function api(url, options = {}) { const response = await fetch(url, options); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || '请求失败'); return body; }
function toast(message, error = false) { const node = $('#student-toast'); node.textContent = message; node.classList.toggle('error', error); node.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3200); }

function selectedLesson() { return studentState.data.lessons.find((item) => item.id === studentState.lessonId) || studentState.data.lessons[0]; }
function courseNames(courses = []) { return [...new Set(courses.map((item) => item.courseName).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN')); }
function classesForCourse(courses, courseName) { return courses.filter((item) => item.courseName === courseName).sort((left, right) => left.className.localeCompare(right.className, 'zh-CN')); }
function renderLoginClasses(courseName) {
  const classes = classesForCourse(studentState.loginCatalog, courseName);
  const select = $('#student-class-select');
  select.innerHTML = classes.length
    ? `<option value="">请选择班级</option>${classes.map((item) => `<option value="${esc(item.id)}" data-class-name="${esc(item.className)}">${esc(item.className)}</option>`).join('')}`
    : '<option value="">该课程暂无可用班级</option>';
  select.disabled = !classes.length;
  $('#student-login-form button').disabled = !classes.length;
}
function feedbackMarkup(submission) {
  if (!submission.reason && !submission.correctApproach) return `<div class="markdown-body">${richHtml(submission.feedback)}</div>`;
  return `<div class="feedback-detail"><strong>判定理由</strong><div class="markdown-body">${richHtml(submission.reason || '暂无')}</div><strong>正确思路</strong><div class="markdown-body">${richHtml(submission.correctApproach || '暂无')}</div>${submission.suggestion ? `<strong>改进建议</strong><div class="markdown-body">${richHtml(submission.suggestion)}</div>` : ''}</div>`;
}
function render() {
  const data = studentState.data; const student = data.student;
  const selectedCourse = data.availableCourses.find((item) => item.id === data.selectedCourseId);
  const names = courseNames(data.availableCourses);
  if (!names.includes(studentState.courseName)) studentState.courseName = selectedCourse?.courseName || names[0] || '';
  $('#student-identity').textContent = `${student.name} · ${student.className || '未分班'}${selectedCourse ? ` · ${selectedCourse.courseName}` : ''}`;
  $('#student-welcome').textContent = `${student.name}，你好`;
  const courseSelect = $('#student-course-select');
  courseSelect.innerHTML = names.length
    ? names.map((courseName) => `<option value="${esc(courseName)}" ${courseName === studentState.courseName ? 'selected' : ''}>${esc(courseName)}</option>`).join('')
    : '<option value="">暂无已发布课程</option>';
  courseSelect.disabled = !names.length;
  const classSelect = $('#student-course-class-select');
  const availableClasses = classesForCourse(data.availableCourses, studentState.courseName);
  classSelect.innerHTML = availableClasses.length
    ? availableClasses.map((item) => `<option value="${esc(item.id)}" ${item.id === data.selectedCourseId ? 'selected' : ''}>${esc(item.className)}</option>`).join('')
    : '<option value="">暂无可用班级</option>';
  classSelect.disabled = !availableClasses.length;
  const select = $('#student-lesson-select');
  select.innerHTML = data.lessons.map((item) => `<option value="${esc(item.id)}" ${item.id === studentState.lessonId ? 'selected' : ''}>第 ${item.teachingWeek} 周 · ${esc(item.title)}</option>`).join('');
  const lesson = selectedLesson();
  if (lesson) studentState.lessonId = lesson.id;
  $('#student-lesson-title').textContent = lesson?.title || '暂无教学周';
  $('#student-lesson-meta').textContent = lesson ? `${lesson.date} · 第 ${lesson.teachingWeek}/${lesson.totalWeeks} 周` : '';
  RichText.render($('#student-notes'), lesson?.aiResult, '老师尚未发布教学内容。');
  const attended = lesson && data.attendance.some((item) => item.lessonId === lesson.id);
  $('#attendance-button').disabled = !lesson || attended;
  $('#attendance-button').textContent = attended ? '✓ 已签到' : '本课签到';
  const exercises = lesson ? data.exercises.filter((item) => item.lessonId === lesson.id) : [];
  const submissions = new Map(data.submissions.map((item) => [item.exerciseId, item]));
  $('#exercise-progress').textContent = `${exercises.filter((item) => submissions.has(item.id)).length}/${exercises.length} 已完成`;
  $('#student-exercises').innerHTML = exercises.length ? exercises.map((item, index) => {
    const submission = submissions.get(item.id);
    const choices = item.type === 'choice' ? String(item.question).split('\n').filter((line) => /^[A-D][.、]/.test(line.trim())) : [];
    const stem = choices.length ? String(item.question).split('\n').filter((line) => !/^[A-D][.、]/.test(line.trim())).join('\n') : item.question;
    return `<form class="student-exercise" data-exercise-form="${esc(item.id)}"><span class="badge">${index + 1} · ${esc(item.knowledgePoint || exerciseTypeLabel(item.type))}</span><div class="markdown-body">${richHtml(stem)}</div>${submission ? `<div class="feedback ${submission.correct ? 'correct' : 'wrong'}"><strong>${submission.correct ? '✓ 回答正确' : '✕ 回答有误'}</strong>${feedbackMarkup(submission)}</div>` : choices.length ? `<div class="choice-options">${choices.map((choice) => `<label><input type="radio" name="answer" value="${esc(choice.trim()[0])}" required><span class="markdown-body">${richHtml(choice, { inline: true })}</span></label>`).join('')}</div><button class="button primary" type="submit">提交答案</button>` : `<textarea name="answer" required placeholder="支持 Markdown 与 LaTeX，例如：$E=mc^2$"></textarea><button class="button primary" type="submit">提交答案</button>`}</form>`;
  }).join('') : '<div class="empty">老师尚未发放本周练习。</div>';
  RichText.typeset($('#student-exercises'));
  $$('[data-exercise-form]').forEach((form) => form.addEventListener('submit', submitAnswer));
  const lessonById = new Map(data.lessons.map((item) => [item.id, item]));
  const materials = [
    ...data.classMaterials.map((item) => ({ ...item, scope: '课程公共资料' })),
    ...data.materials.map((item) => ({ ...item, scope: lessonById.has(item.lessonId) ? `第 ${lessonById.get(item.lessonId).teachingWeek} 周资料` : '课程资料' })),
  ];
  $('#student-materials').innerHTML = materials.length ? materials.map((item) => `<article class="material-card"><strong>${esc(item.filename)}</strong><span>${esc(item.scope)}${item.type === 'ai_generated' ? ' · Markdown / LaTeX' : ''}</span><div class="material-actions">${item.type === 'ai_generated' ? `<button class="button primary" data-student-preview="${esc(item.id)}">预览课件</button>` : ''}<a class="button secondary" href="/api/student/material/${esc(item.id)}/download">下载</a></div></article>`).join('') : '<div class="empty">老师尚未发布课程资料。</div>';
  $$('[data-student-preview]').forEach((button) => button.addEventListener('click', () => previewStudentCourseware(button.dataset.studentPreview)));
  $('#student-history').innerHTML = data.submissions.length ? [...data.submissions].reverse().map((submission) => { const exercise = data.exercises.find((item) => item.id === submission.exerciseId); return `<div class="history-card"><span class="badge">${submission.correct ? '正确' : '待巩固'}</span><div class="markdown-body">${richHtml(exercise?.question || '题目')}</div><div><strong>我的答案：</strong><div class="markdown-body">${richHtml(submission.answer)}</div></div><div class="muted markdown-body">${richHtml(submission.feedback)}</div></div>`; }).join('') : '<div class="empty">还没有作答记录。</div>';
  RichText.typeset($('#student-history'));
  RichText.render($('#student-report'), data.report?.markdown, '老师尚未生成学习诊断报告。');
}

async function load() { studentState.data = await api('/api/student/state'); if (!studentState.lessonId) studentState.lessonId = studentState.data.lessons[0]?.id || ''; render(); }
async function switchStudentCourse(courseId) { await api('/api/student/course', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ courseId }) }); studentState.lessonId = ''; await load(); toast('课程与班级已切换'); }
async function previewStudentCourseware(materialId) { try { const result = await api(`/api/student/material/${encodeURIComponent(materialId)}/preview`); $('#student-courseware-title').textContent = result.filename || '课件预览'; RichText.render($('#student-courseware-content'), result.markdown, '暂无课件内容。'); if (!$('#student-courseware-preview').open) $('#student-courseware-preview').showModal(); } catch (error) { toast(error.message, true); } }
async function submitAnswer(event) { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); if (button) button.disabled = true; try { const result = await api('/api/student/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exerciseId: form.dataset.exerciseForm, answer: new FormData(form).get('answer') }) }); toast(result.submission.correct ? '回答正确，已显示判定理由' : '答案需要调整，已显示原因和正确思路'); await load(); } catch (error) { toast(error.message, true); } finally { if (button) button.disabled = false; } }
$$('.student-nav[data-student-view]').forEach((button) => button.addEventListener('click', () => { $$('.student-nav').forEach((item) => item.classList.toggle('active', item === button)); $$('.student-view').forEach((view) => view.classList.toggle('active', view.id === `student-view-${button.dataset.studentView}`)); }));
$('#student-lesson-select').addEventListener('change', (event) => { studentState.lessonId = event.target.value; render(); });
$('#student-course-select').addEventListener('change', async (event) => { studentState.courseName = event.target.value; const firstClass = classesForCourse(studentState.data.availableCourses, studentState.courseName)[0]; if (!firstClass) return render(); try { await switchStudentCourse(firstClass.id); } catch (error) { toast(error.message, true); } });
$('#student-course-class-select').addEventListener('change', async (event) => { if (!event.target.value) return; try { await switchStudentCourse(event.target.value); } catch (error) { toast(error.message, true); } });
$('#attendance-button').addEventListener('click', async () => { try { await api('/api/student/attendance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lessonId: studentState.lessonId }) }); toast('签到成功'); await load(); } catch (error) { toast(error.message, true); } });
$('#student-logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
$('#student-courseware-close').addEventListener('click', () => $('#student-courseware-preview').close());
$('#student-login-form').addEventListener('submit', async (event) => { event.preventDefault(); const selected = studentState.loginCatalog.find((item) => item.id === $('#student-class-select').value); try { await api('/api/auth/student', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ studentId: new FormData(event.currentTarget).get('studentId'), courseId: selected?.id || '', className: selected?.className || '' }) }); studentState.courseName = selected?.courseName || ''; $('#student-login').close(); await load(); } catch (error) { toast(error.message, true); } });
$('#student-login-course-select').addEventListener('change', (event) => renderLoginClasses(event.target.value));
(async function boot() { const auth = await api('/api/auth/status'); if (auth.role === 'student') return load(); const catalog = await api('/api/public/courses'); studentState.loginCatalog = catalog.courses; const names = courseNames(catalog.courses); $('#student-login-course-select').innerHTML = names.length ? `<option value="">请选择课程</option>${names.map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join('')}` : '<option value="">暂无已发布课程</option>'; $('#student-login-course-select').disabled = !names.length; $('#student-login-form button').disabled = true; $('#student-login').showModal(); })().catch((error) => toast(error.message, true));
