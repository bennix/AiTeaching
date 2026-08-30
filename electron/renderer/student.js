const studentState = { data: null, lessonId: '' };
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const richHtml = (value, options) => RichText.html(value, options);
async function api(url, options = {}) { const response = await fetch(url, options); const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || '请求失败'); return body; }
function toast(message, error = false) { const node = $('#student-toast'); node.textContent = message; node.classList.toggle('error', error); node.hidden = false; clearTimeout(toast.timer); toast.timer = setTimeout(() => { node.hidden = true; }, 3200); }

function selectedLesson() { return studentState.data.lessons.find((item) => item.id === studentState.lessonId) || studentState.data.lessons[0]; }
function render() {
  const data = studentState.data; const student = data.student;
  $('#student-identity').textContent = `${student.name} · ${student.className || '未分班'}`;
  $('#student-welcome').textContent = `${student.name}，你好`;
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
    return `<form class="student-exercise" data-exercise-form="${esc(item.id)}"><span class="badge">${index + 1} · ${esc(item.knowledgePoint || item.type)}</span><div class="markdown-body">${richHtml(stem)}</div>${submission ? `<div class="feedback ${submission.correct ? 'correct' : 'wrong'}"><strong>${submission.correct ? '✓ 回答正确' : '✕ 需要再想一想'}</strong><div class="markdown-body">${richHtml(submission.feedback)}</div></div>` : choices.length ? `<div class="choice-options">${choices.map((choice) => `<label><input type="radio" name="answer" value="${esc(choice.trim()[0])}" required><span class="markdown-body">${richHtml(choice, { inline: true })}</span></label>`).join('')}</div><button class="button primary" type="submit">提交答案</button>` : `<textarea name="answer" required placeholder="支持 Markdown 与 LaTeX，例如：$E=mc^2$"></textarea><button class="button primary" type="submit">提交答案</button>`}</form>`;
  }).join('') : '<div class="empty">老师尚未发放本周练习。</div>';
  RichText.typeset($('#student-exercises'));
  $$('[data-exercise-form]').forEach((form) => form.addEventListener('submit', submitAnswer));
  const materials = [...data.classMaterials.map((item) => ({ ...item, scope: '班级资料' })), ...data.materials.filter((item) => !lesson || item.lessonId === lesson.id).map((item) => ({ ...item, scope: '本周资料' }))];
  $('#student-materials').innerHTML = materials.length ? materials.map((item) => `<a class="material-card" href="/api/student/material/${esc(item.id)}/download"><strong>${esc(item.filename)}</strong><span>${esc(item.scope)}</span></a>`).join('') : '<div class="empty">老师尚未发布课程资料。</div>';
  $('#student-history').innerHTML = data.submissions.length ? [...data.submissions].reverse().map((submission) => { const exercise = data.exercises.find((item) => item.id === submission.exerciseId); return `<div class="history-card"><span class="badge">${submission.correct ? '正确' : '待巩固'}</span><div class="markdown-body">${richHtml(exercise?.question || '题目')}</div><div><strong>我的答案：</strong><div class="markdown-body">${richHtml(submission.answer)}</div></div><div class="muted markdown-body">${richHtml(submission.feedback)}</div></div>`; }).join('') : '<div class="empty">还没有作答记录。</div>';
  RichText.typeset($('#student-history'));
  RichText.render($('#student-report'), data.report?.markdown, '老师尚未生成学习诊断报告。');
}

async function load() { studentState.data = await api('/api/student/state'); if (!studentState.lessonId) studentState.lessonId = studentState.data.lessons[0]?.id || ''; render(); }
async function submitAnswer(event) { event.preventDefault(); const form = event.currentTarget; const button = form.querySelector('button'); if (button) button.disabled = true; try { await api('/api/student/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ exerciseId: form.dataset.exerciseForm, answer: new FormData(form).get('answer') }) }); toast('答案已提交'); await load(); } catch (error) { toast(error.message, true); } finally { if (button) button.disabled = false; } }
$$('.student-nav[data-student-view]').forEach((button) => button.addEventListener('click', () => { $$('.student-nav').forEach((item) => item.classList.toggle('active', item === button)); $$('.student-view').forEach((view) => view.classList.toggle('active', view.id === `student-view-${button.dataset.studentView}`)); }));
$('#student-lesson-select').addEventListener('change', (event) => { studentState.lessonId = event.target.value; render(); });
$('#attendance-button').addEventListener('click', async () => { try { await api('/api/student/attendance', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lessonId: studentState.lessonId }) }); toast('签到成功'); await load(); } catch (error) { toast(error.message, true); } });
$('#student-logout').addEventListener('click', async () => { await api('/api/auth/logout', { method: 'POST' }); location.reload(); });
$('#student-login-form').addEventListener('submit', async (event) => { event.preventDefault(); try { await api('/api/auth/student', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.fromEntries(new FormData(event.currentTarget))) }); $('#student-login').close(); await load(); } catch (error) { toast(error.message, true); } });
(async function boot() { const auth = await api('/api/auth/status'); if (auth.role === 'student') return load(); const classes = await api('/api/public/classes'); $('#student-class-select').innerHTML += classes.classes.map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join(''); $('#student-login').showModal(); })().catch((error) => toast(error.message, true));
