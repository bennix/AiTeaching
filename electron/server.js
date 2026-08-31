const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const Busboy = require('busboy');
const nodemailer = require('nodemailer');
const readXlsxFile = require('read-excel-file/node');
const { JsonStore } = require('./lib/store');
const { buildLessonRecords, extractDocumentText } = require('./lib/documents');
const { normalizeUploadFilename } = require('./lib/filenames');
const { buildLearningAnalytics, reportScopeKey } = require('./lib/analytics');
const {
  fetchModelCatalog,
  generateExercises,
  generateExercisesForBlueprint,
  generateClassLearningReport,
  generateStudentReport,
  generateWeeklyPlan,
  gradeAnswer,
  normalizeExerciseBlueprint,
  testConnection,
} = require('./lib/ai');

const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

function sendJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  response.end(JSON.stringify(body));
}

function cookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2));
}

function studentCourseCatalog(store) {
  const courses = new Map();
  for (const lesson of store.state.lessons.filter((item) => item.status === 'done')) {
    const courseName = String(lesson.courseName || '').trim();
    if (!courseName) continue;
    for (const className of lessonClassNames(lesson)) {
      const id = Buffer.from(JSON.stringify([courseName, className]), 'utf8').toString('base64url');
      if (!courses.has(id)) courses.set(id, { id, courseName, className, label: className ? `${courseName} · ${className}` : courseName });
    }
  }
  return [...courses.values()].sort((left, right) => left.label.localeCompare(right.label, 'zh-CN'));
}

function lessonClassNames(lesson = {}) {
  const names = Array.isArray(lesson.classNames) ? lesson.classNames : [lesson.className];
  const unique = [...new Set(names.map((item) => String(item || '').trim()).filter(Boolean))];
  return unique.length ? unique : [''];
}

function parseClassNames(value, fallback = '') {
  let values = [];
  try { values = JSON.parse(String(value || '[]')); } catch { values = String(value || '').split(/[、,，\n]/); }
  if (!Array.isArray(values)) values = [];
  const fallbackName = String(fallback || '').trim();
  return [...new Set([...values, fallbackName].map((item) => String(item || '').trim()).filter(Boolean))];
}

function resolveStudentCourse(store, student, courseId = '') {
  const courses = studentCourseCatalog(store);
  const requested = courses.find((item) => item.id === courseId);
  if (requested) return requested;
  return courses.find((item) => item.courseName === student.courseName && item.className === student.className)
    || courses.find((item) => item.courseName === student.courseName)
    || courses.find((item) => item.className === student.className)
    || courses[0]
    || null;
}

function visibleLessonsForStudent(store, student, course = null) {
  if (course) {
    return store.state.lessons.filter((lesson) => lesson.status === 'done'
      && lesson.courseName === course.courseName
      && lessonClassNames(lesson).includes(course.className));
  }
  return store.state.lessons.filter((lesson) => lesson.status === 'done'
    && (!student.courseName || !lesson.courseName || lesson.courseName === student.courseName)
    && (!student.className || lessonClassNames(lesson).includes('') || lessonClassNames(lesson).includes(student.className)));
}

function studentsForLesson(store, lesson) {
  return store.state.students.filter((student) => (!student.courseName || !lesson.courseName || student.courseName === lesson.courseName)
    && (!student.className || lessonClassNames(lesson).includes('') || lessonClassNames(lesson).includes(student.className)));
}

function htmlEscape(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function buildCoursewareMarkdown(lesson) {
  const exercises = (lesson.exercises || []).filter((item) => !item.targetStudentId && item.published)
    .map((item, index) => `### 练习 ${index + 1}\n\n${item.question}`)
    .join('\n\n');
  return `# ${lesson.title || `${lesson.courseName || '课程'} · 第 ${lesson.teachingWeek} 周`}\n\n> ${lesson.courseName || '课程'} · 第 ${lesson.teachingWeek}/${lesson.totalWeeks} 教学周${lesson.date ? ` · ${lesson.date}` : ''}\n\n${lesson.aiResult || lesson.structuredNotes || lesson.rawText || '暂无教学内容'}${exercises ? `\n\n## 课堂练习\n\n${exercises}` : ''}`;
}

function inlineBrowserScript(filePath) {
  return fs.readFileSync(filePath, 'utf8').replace(/<\/script/gi, '<\\/script');
}

function standaloneKatexCss(rendererDir) {
  const katexDir = path.join(rendererDir, 'vendor', 'katex');
  return fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8').replace(/url\((?:['"])?fonts\/([^)'"?]+)(?:['"])?\)/g, (source, filename) => {
    const fontPath = path.join(katexDir, 'fonts', filename);
    if (!fs.existsSync(fontPath)) return source;
    const extension = path.extname(filename).slice(1).toLowerCase();
    const mime = extension === 'woff2' ? 'font/woff2' : (extension === 'woff' ? 'font/woff' : 'font/ttf');
    return `url(data:${mime};base64,${fs.readFileSync(fontPath).toString('base64')})`;
  });
}

function buildStandaloneCoursewareHtml({ rendererDir, title, markdown }) {
  const embeddedMarkdown = JSON.stringify(markdown).replace(/</g, '\\u003c');
  const styles = `${standaloneKatexCss(rendererDir)}\n${fs.readFileSync(path.join(rendererDir, 'rich-text.css'), 'utf8')}\nbody{font:17px/1.8 system-ui;max-width:1100px;margin:auto;padding:4vw;color:#172033;background:#f5f7fb}main{background:white;padding:clamp(24px,5vw,64px);border-radius:24px;box-shadow:0 18px 60px #17203312}`.replace(/<\/style/gi, '<\\/style');
  const scripts = [
    path.join(rendererDir, 'vendor', 'marked.umd.js'),
    path.join(rendererDir, 'vendor', 'purify.min.js'),
    path.join(rendererDir, 'vendor', 'katex', 'katex.min.js'),
    path.join(rendererDir, 'vendor', 'katex', 'auto-render.min.js'),
    path.join(rendererDir, 'markdown.js'),
  ].map((filePath) => `<script>${inlineBrowserScript(filePath)}</script>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; font-src data:; img-src data:"><title>${htmlEscape(title)}</title><style>${styles}</style></head><body><main id="courseware" class="markdown-body"></main>${scripts}<script>RichText.render(document.getElementById('courseware'),${embeddedMarkdown},'暂无课件内容');</script></body></html>`;
}

function materialPreviewMarkdown(store, material) {
  if (material.markdown) return material.markdown;
  if (material.type !== 'ai_generated') return '';
  const lesson = store.getLessonDetail(material.lessonId);
  return lesson ? buildCoursewareMarkdown(lesson) : '';
}

function exerciseRecords(generated, lessonId, { targetStudentId = null, published = false } = {}) {
  return generated.map((item) => ({
    id: crypto.randomUUID(), lessonId, targetStudentId, published,
    type: ['choice', 'short_answer', 'application', 'coding'].includes(item.type) ? item.type : 'short_answer',
    question: String(item.question || '').replace(/^\s*(?:第?\s*\d+\s*[题.、:：)]|[（(]\s*\d+\s*[）)])\s*/, ''),
    answer: String(item.answer || ''), explanation: String(item.explanation || ''),
    difficulty: ['easy', 'medium', 'hard'].includes(item.difficulty) ? item.difficulty : 'medium',
    knowledgePoint: String(item.knowledgePoint || ''), createdAt: new Date().toISOString(),
  })).filter((item) => item.question && item.answer);
}

function parseCsv(text) {
  const rows = [[]];
  let value = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"' && quoted && text[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { rows.at(-1).push(value); value = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[index + 1] === '\n') index += 1;
      rows.at(-1).push(value); value = '';
      if (rows.at(-1).some((item) => String(item).trim())) rows.push([]); else rows[rows.length - 1] = [];
    } else value += char;
  }
  rows.at(-1).push(value);
  return rows.filter((row) => row.some((item) => String(item).trim()));
}

function parseRosterRows(rows, overrides = {}) {
  if (Array.isArray(rows) && rows.length && !Array.isArray(rows[0]) && Array.isArray(rows[0]?.data)) {
    const rosterSheet = rows.find((sheet) => sheet.data.some((row) => Array.isArray(row)
      && row.some((cell) => String(cell ?? '').trim() === '学号')
      && row.some((cell) => String(cell ?? '').trim() === '姓名')));
    rows = (rosterSheet || rows[0]).data;
  }
  if (!Array.isArray(rows) || !rows.length) throw new Error('选课单没有数据');
  const aliases = {
    studentId: ['学号', 'student_id', 'student id', 'id'],
    name: ['姓名', 'name'],
    major: ['专业', 'major'],
    department: ['管理院系', '院系', 'department'],
    gender: ['性别', 'gender'],
    email: ['邮箱', 'email', 'mail'],
    className: ['班级', '教学班', 'class', 'class_name'],
    courseName: ['课程', '课程名称', 'course', 'course_name'],
  };
  const normalize = (value) => String(value ?? '').trim().toLowerCase();
  let headerIndex = -1;
  let positions = {};
  for (let rowIndex = 0; rowIndex < Math.min(rows.length, 30); rowIndex += 1) {
    const header = (rows[rowIndex] || []).map(normalize);
    const indexes = Object.fromEntries(Object.entries(aliases).map(([key, names]) => [key, header.findIndex((item) => names.includes(item))]));
    if (indexes.studentId >= 0 && indexes.name >= 0) { headerIndex = rowIndex; positions = indexes; break; }
  }

  const metadataText = rows.slice(0, headerIndex >= 0 ? headerIndex : Math.min(rows.length, 4))
    .flat().map((item) => String(item ?? '').trim()).filter(Boolean).join('  ');
  const match = (pattern) => metadataText.match(pattern)?.[1]?.trim() || '';
  const courseCode = match(/(?:序号|课程代码)[：:]\s*([^\s]+)/i);
  const detectedCourse = match(/课程名称[：:]\s*(.+?)(?=\s+(?:开课院系|授课教师|是否包含)[：:]|$)/i);
  const department = match(/开课院系[：:]\s*(.+?)(?=\s+(?:授课教师|是否包含)[：:]|$)/i);
  const teacher = match(/授课教师[：:]\s*(.+?)(?=\s+(?:是否包含)[：:]|$)/i);
  const term = match(/上课点名表[（(]([^）)]+)[）)]/i);
  const expectedCount = Number(match(/选课总人数[：:]\s*(\d+)/i)) || 0;
  const courseName = String(overrides.courseName || detectedCourse || '').trim();
  const className = String(overrides.className || (courseCode ? `教学班 ${courseCode}` : courseName ? `${courseName}教学班` : '')).trim();

  if (headerIndex < 0) {
    headerIndex = -1;
    positions = { studentId: 0, name: 1, major: 2, gender: 3, email: 4, className: 5, courseName: 6, department: -1 };
  }
  const students = [];
  const seen = new Set();
  for (const row of rows.slice(headerIndex + 1)) {
    const value = (key) => positions[key] >= 0 ? String(row?.[positions[key]] ?? '').trim() : '';
    const studentId = value('studentId').replace(/^\*+/, '').trim();
    const name = value('name');
    if (!studentId || !name || /^(备注|带\*)/.test(studentId)) continue;
    if (seen.has(studentId)) continue;
    seen.add(studentId);
    students.push({
      studentId,
      name,
      major: value('major'),
      department: value('department') || department,
      gender: value('gender'),
      email: value('email'),
      className: className || value('className'),
      courseName: courseName || value('courseName'),
      courseCode,
      term,
    });
  }
  if (!students.length) throw new Error('没有识别到包含“学号”和“姓名”的学生记录');
  return {
    students,
    courseName: courseName || students[0].courseName || '',
    className: className || students[0].className || '',
    courseCode,
    department,
    teacher,
    term,
    expectedCount,
  };
}

async function sendConfiguredMail(store, { to, subject, text }) {
  const mail = store.getMailSettings({ includePassword: true });
  if (!mail.host || !mail.senderEmail || !mail.password) throw new Error('请先完整配置 SMTP 主机、发件邮箱和授权码');
  const transporter = nodemailer.createTransport({
    host: mail.host, port: mail.port, secure: mail.security === 'ssl',
    auth: { user: mail.username || mail.senderEmail, pass: mail.password },
    ...(mail.security === 'starttls' ? { requireTLS: true } : {}),
  });
  return transporter.sendMail({ from: `"${mail.senderName}" <${mail.senderEmail}>`, to, subject, text });
}

function readJson(request, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求内容过大'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('JSON 格式无效')); }
    });
    request.on('error', reject);
  });
}

function readMultipart(request) {
  return new Promise((resolve, reject) => {
    const fields = {};
    let uploadedFile = null;
    let failed = false;
    const busboy = Busboy({
      headers: request.headers,
      defParamCharset: 'utf8',
      limits: { fileSize: 30 * 1024 * 1024, files: 1 },
    });
    busboy.on('field', (name, value) => { fields[name] = value; });
    busboy.on('file', (_name, stream, info) => {
      const chunks = [];
      stream.on('data', (chunk) => chunks.push(chunk));
      stream.on('limit', () => {
        failed = true;
        reject(new Error('文件不能超过 30 MB'));
      });
      stream.on('end', () => {
        if (!failed) uploadedFile = { filename: normalizeUploadFilename(info.filename), buffer: Buffer.concat(chunks) };
      });
    });
    busboy.on('finish', () => {
      if (!failed) resolve({ fields, file: uploadedFile });
    });
    busboy.on('error', reject);
    request.pipe(busboy);
  });
}

function getLanUrls(port) {
  const urls = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) urls.push(`http://${address.address}:${port}`);
    }
  }
  return [...new Set(urls)];
}

const activeLessonIds = new WeakMap();
const EXERCISE_TYPES = ['choice', 'short_answer', 'application'];

function exerciseBlueprintFromFields(fields, teachingWeek) {
  const mode = fields.exerciseMode === 'per_week' ? 'per_week' : 'uniform';
  const hasConfiguration = EXERCISE_TYPES.some((type) => Object.hasOwn(fields, `exercise_${type}_count`))
    || EXERCISE_TYPES.some((type) => Object.hasOwn(fields, `week_${teachingWeek}_${type}_count`));
  if (!hasConfiguration) return undefined;
  const prefix = mode === 'per_week' ? `week_${teachingWeek}_` : 'exercise_';
  const typeConfigs = EXERCISE_TYPES.map((type) => ({
    type,
    count: Number.parseInt(fields[`${prefix}${type}_count`], 10) || 0,
    difficulty: fields[`${prefix}${type}_difficulty`] || 'mixed',
  }));
  const requestedTotal = typeConfigs.reduce((sum, item) => sum + Math.max(0, item.count), 0);
  if (requestedTotal > 30) throw new Error(`第 ${teachingWeek} 周题目总数不能超过 30 道`);
  const normalized = normalizeExerciseBlueprint({ typeConfigs });
  if (!normalized.length) throw new Error(`第 ${teachingWeek} 周至少需要配置 1 道题`);
  return { mode, typeConfigs: normalized };
}

function lessonSeriesKey(lesson) {
  if (lesson.sourceScope === 'semester' && lesson.batchId) return `semester:${lesson.batchId}`;
  return `course:${lesson.courseName || ''}\u0000${lessonClassNames(lesson).filter(Boolean).sort().join('\u241f')}`;
}

function lessonsInSeries(store, lesson) {
  const key = lessonSeriesKey(lesson);
  return store.state.lessons.filter((item) => lessonSeriesKey(item) === key);
}

function findLessonPrerequisite(store, lesson) {
  if (!lesson || Number(lesson.teachingWeek) <= 1) return null;
  const latestByWeek = new Map();
  const candidates = lessonsInSeries(store, lesson)
    .filter((item) => item.id !== lesson.id && Number(item.teachingWeek) < Number(lesson.teachingWeek))
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));
  for (const item of candidates) if (!latestByWeek.has(Number(item.teachingWeek))) latestByWeek.set(Number(item.teachingWeek), item);
  for (let week = 1; week < Number(lesson.teachingWeek); week += 1) {
    const previous = latestByWeek.get(week);
    if (!previous) return { week, status: 'missing', message: `请先导入并整理第 ${week} 周教案，再处理第 ${lesson.teachingWeek} 周。` };
    if (previous.status !== 'done') return { week, status: previous.status, lessonId: previous.id, message: `请先完成第 ${week} 周教案整理，再处理第 ${lesson.teachingWeek} 周。` };
  }
  return null;
}

function buildTeachingContext(store, lesson) {
  const previous = lessonsInSeries(store, lesson)
    .filter((item) => Number(item.teachingWeek) < Number(lesson.teachingWeek) && item.status === 'done')
    .sort((a, b) => Number(a.teachingWeek) - Number(b.teachingWeek));
  const previousPlans = previous.map((item) => `## 第 ${item.teachingWeek} 周\n${String(item.aiResult || item.rawText || '').slice(0, 2800)}`).join('\n\n');
  const semesterContext = String(lesson.semesterContext || lessonsInSeries(store, lesson).map((item) => item.rawText || '').join('\n\n')).slice(0, 16000);
  return { semesterContext, previousPlans };
}

async function processLessons(store, lessonIds, { onUpdate } = {}) {
  const settings = store.getSettings({ includeKey: true });
  if (!settings.apiKey) return { processed: 0, failed: 0 };
  if (!activeLessonIds.has(store)) activeLessonIds.set(store, new Set());
  const active = activeLessonIds.get(store);
  const lessons = [...new Set(lessonIds)]
    .filter((id) => store.getLesson(id) && !active.has(id))
    .map((id) => store.getLesson(id))
    .sort((a, b) => lessonSeriesKey(a).localeCompare(lessonSeriesKey(b)) || Number(a.teachingWeek) - Number(b.teachingWeek));
  const notify = (lesson) => { try { onUpdate?.({ ...lesson }); } catch { /* A disconnected viewer must not stop processing. */ } };
  for (const lesson of lessons) {
    active.add(lesson.id);
    store.updateLesson(lesson.id, { status: 'queued', processingStage: 'queued', error: '', warning: '' });
    notify(store.getLesson(lesson.id));
  }

  let processed = 0;
  let failed = 0;
  for (const queuedLesson of lessons) {
    const id = queuedLesson.id;
    const lesson = store.getLesson(id);
    if (!lesson) { active.delete(id); continue; }
    try {
      const prerequisite = findLessonPrerequisite(store, lesson);
      if (prerequisite) {
        const blocked = prerequisite.status !== 'missing';
        store.updateLesson(id, {
          status: blocked ? 'blocked' : 'error',
          processingStage: '',
          error: prerequisite.message,
        });
        notify(store.getLesson(id));
        failed += 1;
        continue;
      }
      store.updateLesson(id, { status: 'processing', processingStage: 'planning', error: '', warning: '', aiResult: '', structuredNotes: '', planCompletedAt: '' });
      notify(store.getLesson(id));
      const context = buildTeachingContext(store, lesson);
      let lastSavedAt = 0;
      const aiResult = await generateWeeklyPlan(settings, lesson, {
        ...context,
        onDelta: (partial) => {
          const current = store.getLesson(id);
          if (!current) return;
          Object.assign(current, { aiResult: partial, structuredNotes: partial, updatedAt: new Date().toISOString() });
          if (Date.now() - lastSavedAt >= 250) { store.save(); lastSavedAt = Date.now(); }
          notify(current);
        },
      });
      if (!store.getLesson(id)) continue;
      store.updateLesson(id, {
        status: 'processing', processingStage: 'exercises', aiResult, structuredNotes: aiResult,
        planCompletedAt: new Date().toISOString(), exerciseProgress: null,
      });
      notify(store.getLesson(id));
      let exerciseWarning = '';
      if (!store.state.exercises.some((item) => item.lessonId === id && !item.targetStudentId)) {
        try {
          await generateExercisesForBlueprint(settings, { ...lesson, aiResult }, lesson.exerciseOptions, {
            onProgress: (fresh, progress) => {
              if (!store.getLesson(id)) return;
              const records = exerciseRecords(fresh, id);
              if (records.length) store.addExercises(records);
              store.updateLesson(id, { exerciseProgress: progress });
              notify(store.getLessonDetail(id));
            },
          });
        } catch (error) {
          exerciseWarning = error.kind === 'shortage'
            ? `教学方案已完成；题库未完全达到设定数量。${error.message}。可在“题库”中继续补充。`
            : `教学方案已完成；题库生成暂时中断。${error.message}。已保留本周方案，可在“题库”中重试。`;
        }
      }
      if (!store.getLesson(id)) continue;
      store.updateLesson(id, { status: 'done', processingStage: '', aiResult, structuredNotes: aiResult, warning: exerciseWarning, exerciseProgress: null });
      notify(store.getLessonDetail(id));
      processed += 1;
    } catch (error) {
      failed += 1;
      store.updateLesson(id, { status: 'error', processingStage: '', error: error.message });
      notify(store.getLesson(id));
    } finally {
      active.delete(id);
    }
  }
  return { processed, failed };
}

function listen(server, preferredPort) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      if (error.code === 'EADDRINUSE' && preferredPort !== 0) {
        server.off('error', onError);
        server.listen(0, '0.0.0.0', () => resolve(server.address().port));
      } else {
        reject(error);
      }
    };
    server.once('error', onError);
    server.listen(preferredPort, '0.0.0.0', () => {
      server.off('error', onError);
      resolve(server.address().port);
    });
  });
}

async function createLanServer({ runtimeDir, rendererDir, preferredPort = 5000 }) {
  const store = new JsonStore(runtimeDir);
  const sessions = new Map();
  const lessonSubscribers = new Map();
  let activePort = preferredPort;

  const lessonStreamPayload = (lesson) => {
    const detail = store.getLessonDetail(lesson.id);
    return JSON.stringify({
      id: lesson.id,
      status: lesson.status,
      processingStage: lesson.processingStage || '',
      exerciseProgress: lesson.exerciseProgress || null,
      exercises: detail?.exercises || [],
      aiResult: lesson.aiResult || '',
      error: lesson.error || '',
      warning: lesson.warning || '',
      updatedAt: lesson.updatedAt,
    });
  };
  const broadcastLesson = (lesson) => {
    for (const response of lessonSubscribers.get(lesson.id) || []) {
      try { response.write(`data: ${lessonStreamPayload(lesson)}\n\n`); } catch { /* Closed streams are removed by the request close handler. */ }
    }
  };
  const startProcessing = (ids) => processLessons(store, ids, { onUpdate: broadcastLesson }).catch(() => {});

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      });
      response.end();
      return;
    }

    try {
      if (request.method === 'GET' && pathname === '/api/health') {
        return sendJson(response, 200, { ok: true, port: activePort });
      }
      if (request.method === 'GET' && pathname === '/api/auth/status') {
        const session = sessions.get(cookies(request).aiaid_session);
        return sendJson(response, 200, session || { role: 'guest' });
      }
      if (request.method === 'POST' && pathname === '/api/auth/admin') {
        const body = await readJson(request);
        if (!store.verifyAdminPassword(body.password)) return sendJson(response, 401, { error: '教师密码错误' });
        const token = crypto.randomUUID();
        sessions.set(token, { role: 'admin' });
        return sendJson(response, 200, { ok: true, role: 'admin' }, { 'Set-Cookie': `aiaid_session=${token}; HttpOnly; SameSite=Lax; Path=/` });
      }
      if (request.method === 'POST' && pathname === '/api/auth/student') {
        const body = await readJson(request);
        const student = store.state.students.find((item) => item.studentId === String(body.studentId || '').trim()
          && (!body.className || item.className === body.className));
        if (!student) return sendJson(response, 401, { error: '学号或班级不匹配' });
        const course = resolveStudentCourse(store, student, String(body.courseId || ''));
        if (body.courseId && course?.id !== body.courseId) return sendJson(response, 400, { error: '所选课程不存在或尚未完成发布' });
        const token = crypto.randomUUID();
        sessions.set(token, { role: 'student', studentId: student.studentId, courseId: course?.id || '' });
        return sendJson(response, 200, { ok: true, role: 'student', selectedCourseId: course?.id || '' }, { 'Set-Cookie': `aiaid_session=${token}; HttpOnly; SameSite=Lax; Path=/` });
      }
      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        sessions.delete(cookies(request).aiaid_session);
        return sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'aiaid_session=; Max-Age=0; Path=/' });
      }
      if (request.method === 'GET' && pathname === '/api/public/classes') {
        return sendJson(response, 200, { classes: [...new Set(store.state.students.map((item) => item.className).filter(Boolean))].sort() });
      }
      if (request.method === 'GET' && pathname === '/api/public/courses') {
        return sendJson(response, 200, { courses: studentCourseCatalog(store) });
      }

      const session = sessions.get(cookies(request).aiaid_session);
      const isStudentApi = pathname.startsWith('/api/student/');
      if (pathname.startsWith('/api/') && !session) return sendJson(response, 401, { error: '请先登录' });
      if (isStudentApi && session?.role !== 'student') return sendJson(response, 403, { error: '仅学生可访问' });
      if (!isStudentApi && pathname.startsWith('/api/') && session?.role !== 'admin') return sendJson(response, 403, { error: '仅教师可访问' });

      const lessonStreamMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/stream$/);
      if (request.method === 'GET' && lessonStreamMatch) {
        const lesson = store.getLesson(lessonStreamMatch[1]);
        if (!lesson) return sendJson(response, 404, { error: '未找到教案' });
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Content-Type-Options': 'nosniff',
        });
        if (!lessonSubscribers.has(lesson.id)) lessonSubscribers.set(lesson.id, new Set());
        const subscribers = lessonSubscribers.get(lesson.id);
        subscribers.add(response);
        response.write(`data: ${lessonStreamPayload(lesson)}\n\n`);
        const heartbeat = setInterval(() => response.write(': keep-alive\n\n'), 15000);
        request.on('close', () => {
          clearInterval(heartbeat);
          subscribers.delete(response);
          if (!subscribers.size) lessonSubscribers.delete(lesson.id);
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/state') {
        return sendJson(response, 200, {
          settings: store.getSettings(),
          lessons: store.listLessons(),
          students: store.state.students,
          exerciseCount: store.state.exercises.length,
          submissionCount: store.state.submissions.length,
          attendanceCount: store.state.attendance.length,
          classMaterials: store.state.classMaterials.map(({ filePath, ...item }) => item),
          lanUrls: getLanUrls(activePort),
          port: activePort,
        });
      }
      if (request.method === 'GET' && pathname === '/api/analytics') {
        return sendJson(response, 200, buildLearningAnalytics(store.state, {
          courseName: url.searchParams.get('courseName') || '',
          className: url.searchParams.get('className') || '',
          lessonId: url.searchParams.get('lessonId') || '',
        }));
      }
      if (request.method === 'POST' && pathname === '/api/analytics/report') {
        const body = await readJson(request);
        const filters = {
          courseName: body.courseName || '', className: body.className || '', lessonId: body.lessonId || '',
        };
        const analytics = buildLearningAnalytics(store.state, filters);
        if (!analytics.summary.studentCount) throw new Error('当前筛选范围没有学生，无法生成学情报告');
        if (!analytics.summary.lessonCount) throw new Error('当前筛选范围没有已完成课次，无法生成学情报告');
        if (!store.getSettings().hasApiKey) throw new Error('请先在 AI 设置中保存 API Key');
        const markdown = await generateClassLearningReport(store.getSettings({ includeKey: true }), analytics);
        const scope = analytics.filters;
        const scopeKey = reportScopeKey(scope);
        const existing = store.state.classReports.find((report) => report.scopeKey === scopeKey);
        const report = {
          id: existing?.id || crypto.randomUUID(), scopeKey,
          courseName: scope.courseName, className: scope.className, lessonId: scope.lessonId,
          markdown, summary: analytics.summary, createdAt: new Date().toISOString(),
        };
        if (existing) Object.assign(existing, report); else store.state.classReports.push(report);
        store.save();
        return sendJson(response, 200, { ok: true, report });
      }
      if (request.method === 'GET' && pathname.startsWith('/api/lessons/')) {
        const id = pathname.slice('/api/lessons/'.length);
        const lesson = store.getLessonDetail(id);
        return lesson ? sendJson(response, 200, lesson) : sendJson(response, 404, { error: '未找到教案' });
      }
      if (request.method === 'POST' && pathname === '/api/settings') {
        const body = await readJson(request);
        const settings = store.updateSettings(body);
        if (settings.hasApiKey) {
          const pendingIds = store.state.lessons.filter((item) => ['ready', 'queued', 'processing'].includes(item.status)).map((item) => item.id);
          if (pendingIds.length) startProcessing(pendingIds);
        }
        return sendJson(response, 200, { ok: true, settings });
      }
      if (request.method === 'POST' && pathname === '/api/settings/password') {
        const body = await readJson(request);
        if (body.password !== body.confirm) throw new Error('两次输入的密码不一致');
        store.setAdminPassword(body.password);
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/settings/mail') {
        store.updateMailSettings(await readJson(request));
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/settings/mail/test') {
        const mail = store.getMailSettings();
        if (!mail.testRecipient) throw new Error('请先填写并保存测试收件邮箱');
        await sendConfiguredMail(store, { to: mail.testRecipient, subject: 'AI 教学助手测试邮件', text: '邮件配置测试成功。' });
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/test-connection') {
        const result = await testConnection(store.getSettings({ includeKey: true }));
        return sendJson(response, 200, { ok: true, message: result });
      }
      if (request.method === 'POST' && pathname === '/api/models') {
        const body = await readJson(request);
        const storedSettings = store.getSettings({ includeKey: true });
        const baseUrl = String(body.baseUrl || storedSettings.baseUrl || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\//i.test(baseUrl)) throw new Error('请先填写有效的 BaseURL');
        const storedBaseUrl = String(storedSettings.baseUrl || '').trim().replace(/\/+$/, '');
        const catalog = await fetchModelCatalog({
          ...storedSettings,
          baseUrl,
          apiKey: String(body.apiKey || '').trim() || (baseUrl === storedBaseUrl ? storedSettings.apiKey : ''),
        });
        const models = catalog.models.map((item) => item.id);
        if (!models.length) throw new Error('服务未返回可用模型列表，可直接手动填写模型 ID');
        store.setModelOptions(models);
        return sendJson(response, 200, {
          ok: true,
          models,
          total: catalog.total,
          excluded: catalog.excluded,
          minimumContext: catalog.minimumContext,
        });
      }
      if (request.method === 'POST' && pathname === '/api/import') {
        const { fields, file } = await readMultipart(request);
        if (!file) throw new Error('请选择教案文件');
        const text = await extractDocumentText(file.filename, file.buffer);
        const storedName = `${Date.now()}-${file.filename.replace(/[^\p{L}\p{N}._-]+/gu, '_')}`;
        const classNames = parseClassNames(fields.classNames, fields.className);
        const lessons = buildLessonRecords({ ...fields, className: classNames[0] || fields.className, filename: file.filename, text });
        for (const lesson of lessons) {
          lesson.classNames = classNames;
          lesson.sourceStoredName = storedName;
          lesson.exerciseOptions = exerciseBlueprintFromFields(fields, lesson.teachingWeek);
          if (store.getSettings().hasApiKey) Object.assign(lesson, { status: 'queued', processingStage: 'queued' });
        }
        fs.writeFileSync(path.join(store.uploadDir, storedName), file.buffer);
        store.addLessons(lessons);
        const hasApiKey = store.getSettings().hasApiKey;
        if (hasApiKey) startProcessing(lessons.map((item) => item.id));
        return sendJson(response, 201, {
          ok: true,
          count: lessons.length,
          lessonIds: lessons.map((item) => item.id),
          processing: hasApiKey,
        });
      }
      if (request.method === 'POST' && pathname === '/api/students') {
        const student = store.upsertStudent(await readJson(request));
        return sendJson(response, 201, { ok: true, student });
      }
      if (request.method === 'DELETE' && pathname.startsWith('/api/students/')) {
        store.deleteStudent(decodeURIComponent(pathname.slice('/api/students/'.length)));
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/students/import') {
        const { fields, file } = await readMultipart(request);
        if (!file) throw new Error('请选择 CSV 或 XLSX 选课单');
        const extension = path.extname(file.filename).toLowerCase();
        if (!['.csv', '.xlsx'].includes(extension)) throw new Error('选课单仅支持 CSV 或 XLSX');
        const rows = extension === '.csv' ? parseCsv(file.buffer.toString('utf8')) : await readXlsxFile(file.buffer);
        const roster = parseRosterRows(rows, fields);
        const imported = store.upsertStudents(roster.students);
        const warning = roster.expectedCount && roster.expectedCount !== roster.students.length
          ? `表头显示 ${roster.expectedCount} 人，实际识别 ${roster.students.length} 人，请检查选课单。`
          : '';
        return sendJson(response, 201, {
          ok: true,
          count: roster.students.length,
          added: imported.added,
          updated: imported.updated,
          courseName: roster.courseName,
          className: roster.className,
          courseCode: roster.courseCode,
          term: roster.term,
          warning,
        });
      }
      const lessonClassesMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/classes$/);
      if (request.method === 'PUT' && lessonClassesMatch) {
        const lesson = store.getLesson(lessonClassesMatch[1]);
        if (!lesson) return sendJson(response, 404, { error: '未找到课次' });
        const body = await readJson(request);
        const classNames = parseClassNames(body.classNames);
        const updated = store.updateLesson(lesson.id, { classNames, className: classNames[0] || '' });
        return sendJson(response, 200, { ok: true, lesson: updated });
      }
      const notesMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/notes$/);
      if (request.method === 'PUT' && notesMatch) {
        const body = await readJson(request);
        const lesson = store.updateLesson(notesMatch[1], { aiResult: String(body.notes || ''), structuredNotes: String(body.notes || '') });
        return lesson ? sendJson(response, 200, { ok: true, lesson }) : sendJson(response, 404, { error: '未找到课次' });
      }
      const exerciseUpdateMatch = pathname.match(/^\/api\/exercises\/([^/]+)$/);
      if (request.method === 'PUT' && exerciseUpdateMatch) {
        const exercise = store.state.exercises.find((item) => item.id === exerciseUpdateMatch[1]);
        if (!exercise) return sendJson(response, 404, { error: '未找到题目' });
        if (store.state.submissions.some((item) => item.exerciseId === exercise.id)) throw new Error('已有学生提交，不能再修改该题');
        return sendJson(response, 200, { ok: true, exercise: store.updateExercise(exercise.id, await readJson(request)) });
      }
      const publishMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/(publish|unpublish)$/);
      if (request.method === 'POST' && publishMatch) {
        const body = await readJson(request);
        const ids = Array.isArray(body.exerciseIds) ? body.exerciseIds : [];
        for (const exercise of store.state.exercises.filter((item) => item.lessonId === publishMatch[1] && (!ids.length || ids.includes(item.id)))) {
          exercise.published = publishMatch[2] === 'publish';
        }
        store.save();
        return sendJson(response, 200, { ok: true });
      }
      const generateMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/generate-exercises$/);
      if (request.method === 'POST' && generateMatch) {
        const lesson = store.getLesson(generateMatch[1]);
        if (!lesson) return sendJson(response, 404, { error: '未找到课次' });
        const body = await readJson(request);
        const blueprint = { typeConfigs: body.typeConfigs };
        const requestedTotal = (Array.isArray(body.typeConfigs) ? body.typeConfigs : []).reduce((sum, item) => sum + Math.max(0, Number(item?.count) || 0), 0);
        if (requestedTotal > 30) throw new Error('当前章节题目总数不能超过 30 道');
        const normalized = normalizeExerciseBlueprint(blueprint);
        if (!normalized.length) throw new Error('请至少配置 1 道题');
        if (!body.preserveExerciseOptions) store.updateLesson(lesson.id, { exerciseOptions: { mode: 'current', typeConfigs: normalized } });
        const previousStatus = lesson.status;
        const records = [];
        let warning = '';
        store.updateLesson(lesson.id, { status: 'processing', processingStage: 'exercises', error: '', warning: '', exerciseProgress: null });
        broadcastLesson(store.getLessonDetail(lesson.id));
        try {
          await generateExercisesForBlueprint(store.getSettings({ includeKey: true }), lesson, blueprint, {
            onProgress: (fresh, progress) => {
              const batch = exerciseRecords(fresh, lesson.id);
              if (batch.length) { store.addExercises(batch); records.push(...batch); }
              store.updateLesson(lesson.id, { exerciseProgress: progress });
              broadcastLesson(store.getLessonDetail(lesson.id));
            },
          });
        } catch (error) {
          if (!lesson.aiResult && !lesson.structuredNotes) {
            store.updateLesson(lesson.id, { status: previousStatus, processingStage: '', exerciseProgress: null });
            broadcastLesson(store.getLessonDetail(lesson.id));
            throw error;
          }
          warning = `${error.message}；教学方案和已有题目不受影响，可再次生成补充。`;
        }
        if (lesson.aiResult || lesson.structuredNotes) {
          store.updateLesson(lesson.id, {
            status: 'done', processingStage: '', error: '', warning,
            planCompletedAt: lesson.planCompletedAt || new Date().toISOString(), exerciseProgress: null,
          });
          broadcastLesson(store.getLessonDetail(lesson.id));
          const downstream = lessonsInSeries(store, lesson)
            .filter((item) => Number(item.teachingWeek) > Number(lesson.teachingWeek) && ['blocked', 'queued'].includes(item.status))
            .map((item) => item.id);
          if (downstream.length) startProcessing(downstream);
        }
        return sendJson(response, 201, { ok: true, exercises: records, warning });
      }
      const reportMatch = pathname.match(/^\/api\/students\/([^/]+)\/report$/);
      if (request.method === 'POST' && reportMatch) {
        const studentId = decodeURIComponent(reportMatch[1]);
        const student = store.state.students.find((item) => item.studentId === studentId);
        if (!student) return sendJson(response, 404, { error: '未找到学生' });
        const records = store.state.submissions.filter((item) => item.studentId === studentId).map((submission) => ({ ...submission, exercise: store.state.exercises.find((item) => item.id === submission.exerciseId) }));
        const markdown = await generateStudentReport(store.getSettings({ includeKey: true }), student, records);
        const existing = store.state.studentReports.find((item) => item.studentId === studentId);
        const report = { id: existing?.id || crypto.randomUUID(), studentId, markdown, createdAt: new Date().toISOString() };
        if (existing) Object.assign(existing, report); else store.state.studentReports.push(report);
        store.save();
        return sendJson(response, 200, { ok: true, report });
      }
      const targetedMatch = pathname.match(/^\/api\/students\/([^/]+)\/exercises$/);
      if (request.method === 'POST' && targetedMatch) {
        const studentId = decodeURIComponent(targetedMatch[1]);
        const student = store.state.students.find((item) => item.studentId === studentId);
        if (!student) return sendJson(response, 404, { error: '未找到学生' });
        const lesson = visibleLessonsForStudent(store, student).sort((a, b) => String(b.date).localeCompare(String(a.date)))[0];
        if (!lesson) throw new Error('该学生没有可用的已完成课次');
        const wrongExerciseIds = store.state.submissions.filter((item) => item.studentId === studentId && !item.correct).map((item) => item.exerciseId);
        const weakPoints = [...new Set(store.state.exercises.filter((item) => wrongExerciseIds.includes(item.id)).map((item) => item.knowledgePoint).filter(Boolean))].join('、');
        const generated = await generateExercises(store.getSettings({ includeKey: true }), lesson, { targetStudentId: studentId, weakPoints });
        const records = exerciseRecords(generated, lesson.id, { targetStudentId: studentId, published: true });
        store.addExercises(records);
        return sendJson(response, 201, { ok: true, count: records.length });
      }
      const reportEmailMatch = pathname.match(/^\/api\/students\/([^/]+)\/email-report$/);
      if (request.method === 'POST' && reportEmailMatch) {
        const studentId = decodeURIComponent(reportEmailMatch[1]);
        const student = store.state.students.find((item) => item.studentId === studentId);
        const report = store.state.studentReports.find((item) => item.studentId === studentId);
        if (!student?.email) throw new Error('该学生没有邮箱地址');
        if (!report?.markdown) throw new Error('请先生成学生学习诊断报告');
        await sendConfiguredMail(store, { to: student.email, subject: `${student.courseName || '课程'} 学习诊断 - ${student.name}`, text: report.markdown });
        return sendJson(response, 200, { ok: true });
      }
      const materialPreviewMatch = pathname.match(/^\/api\/materials\/([^/]+)\/preview$/);
      if (request.method === 'GET' && materialPreviewMatch) {
        const material = store.state.materials.find((item) => item.id === materialPreviewMatch[1]);
        if (!material) return sendJson(response, 404, { error: '课件不存在' });
        const markdown = materialPreviewMarkdown(store, material);
        if (!markdown) throw new Error('该资料不支持在线预览');
        return sendJson(response, 200, { id: material.id, filename: material.filename, markdown });
      }
      const materialDownloadMatch = pathname.match(/^\/api\/materials\/([^/]+)\/download$/);
      if (request.method === 'GET' && materialDownloadMatch) {
        const material = store.state.materials.find((item) => item.id === materialDownloadMatch[1]);
        if (!material || !fs.existsSync(material.filePath)) return sendJson(response, 404, { error: '课件文件不存在' });
        response.writeHead(200, {
          'Content-Type': path.extname(material.filename).toLowerCase() === '.html' ? 'text/html; charset=utf-8' : 'application/octet-stream',
          'Content-Disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(material.filename)}`,
        });
        return fs.createReadStream(material.filePath).pipe(response);
      }
      const coursewareMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/courseware$/);
      if (request.method === 'POST' && coursewareMatch) {
        const lesson = store.getLessonDetail(coursewareMatch[1]);
        if (!lesson) return sendJson(response, 404, { error: '未找到课次' });
        const filename = `第${lesson.teachingWeek}周_${String(lesson.title).replace(/[^\p{L}\p{N}_-]+/gu, '_')}.html`;
        const filePath = path.join(store.uploadDir, `${Date.now()}-${filename}`);
        const markdown = buildCoursewareMarkdown(lesson);
        fs.writeFileSync(filePath, buildStandaloneCoursewareHtml({ rendererDir, title: lesson.title, markdown }), 'utf8');
        const previous = store.state.materials.filter((item) => item.lessonId === lesson.id && item.type === 'ai_generated');
        const material = { id: crypto.randomUUID(), lessonId: lesson.id, type: 'ai_generated', filename, filePath, markdown, createdAt: new Date().toISOString() };
        store.state.materials = store.state.materials.filter((item) => !(item.lessonId === lesson.id && item.type === 'ai_generated'));
        store.state.materials.push(material);
        store.save();
        for (const obsolete of previous) {
          try { if (obsolete.filePath && obsolete.filePath !== filePath && fs.existsSync(obsolete.filePath)) fs.unlinkSync(obsolete.filePath); } catch { /* The replacement is already saved; stale file cleanup is best effort. */ }
        }
        return sendJson(response, 201, { ok: true, material: { ...material, filePath: undefined }, replaced: previous.length });
      }
      const lessonEmailMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/email$/);
      if (request.method === 'POST' && lessonEmailMatch) {
        const lesson = store.getLessonDetail(lessonEmailMatch[1]);
        if (!lesson) return sendJson(response, 404, { error: '未找到课次' });
        const body = await readJson(request);
        const mail = store.getMailSettings();
        const recipients = body.test ? [mail.testRecipient] : studentsForLesson(store, lesson).map((item) => item.email).filter(Boolean);
        if (!recipients.length) throw new Error(body.test ? '请先配置测试收件邮箱' : '班级中没有可用的学生邮箱');
        const exercises = lesson.exercises.filter((item) => item.published && !item.targetStudentId).map((item, index) => `\n练习 ${index + 1}\n${item.question}`).join('\n');
        await sendConfiguredMail(store, { to: recipients.join(','), subject: `${lesson.courseName || '课程'} 第${lesson.teachingWeek}周资料`, text: `${lesson.aiResult || lesson.rawText}\n\n${exercises}` });
        return sendJson(response, 200, { ok: true, count: recipients.length });
      }
      if (request.method === 'POST' && pathname === '/api/materials') {
        const { fields, file } = await readMultipart(request);
        if (!file) throw new Error('请选择资料文件');
        const storedName = `${Date.now()}-${file.filename.replace(/[^\p{L}\p{N}._-]+/gu, '_')}`;
        const filePath = path.join(store.uploadDir, storedName);
        fs.writeFileSync(filePath, file.buffer);
        const record = { id: crypto.randomUUID(), filename: file.filename, filePath, createdAt: new Date().toISOString() };
        if (fields.lessonId) store.state.materials.push({ ...record, lessonId: fields.lessonId, type: 'manual' });
        else store.state.classMaterials.push({ ...record, courseName: String(fields.courseName || ''), className: String(fields.className || '') });
        store.save();
        return sendJson(response, 201, { ok: true, material: { ...record, filePath: undefined } });
      }
      if (request.method === 'DELETE' && pathname.startsWith('/api/materials/')) {
        const id = pathname.slice('/api/materials/'.length);
        const material = [...store.state.materials, ...store.state.classMaterials].find((item) => item.id === id);
        if (material?.filePath && fs.existsSync(material.filePath)) fs.unlinkSync(material.filePath);
        store.state.materials = store.state.materials.filter((item) => item.id !== id);
        store.state.classMaterials = store.state.classMaterials.filter((item) => item.id !== id);
        store.save();
        return sendJson(response, 200, { ok: true });
      }

      if (request.method === 'POST' && pathname === '/api/student/course') {
        const body = await readJson(request);
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const course = studentCourseCatalog(store).find((item) => item.id === String(body.courseId || ''));
        if (!student || !course) return sendJson(response, 404, { error: '所选课程不存在或尚未完成发布' });
        session.courseId = course.id;
        return sendJson(response, 200, { ok: true, selectedCourseId: course.id });
      }

      const studentMaterialPreviewMatch = pathname.match(/^\/api\/student\/material\/([^/]+)\/preview$/);
      if (request.method === 'GET' && studentMaterialPreviewMatch) {
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const course = resolveStudentCourse(store, student, session.courseId);
        const lessons = visibleLessonsForStudent(store, student, course);
        const lessonIds = new Set(lessons.map((item) => item.id));
        const material = store.state.materials.find((item) => item.id === studentMaterialPreviewMatch[1] && lessonIds.has(item.lessonId));
        if (!material) return sendJson(response, 404, { error: '课件不存在或尚未发布' });
        const markdown = materialPreviewMarkdown(store, material);
        if (!markdown) throw new Error('该资料不支持在线预览');
        return sendJson(response, 200, { id: material.id, filename: material.filename, markdown });
      }
      const studentMaterialDownloadMatch = pathname.match(/^\/api\/student\/material\/([^/]+)\/download$/);
      if (request.method === 'GET' && studentMaterialDownloadMatch) {
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const course = resolveStudentCourse(store, student, session.courseId);
        const lessons = visibleLessonsForStudent(store, student, course);
        const lessonIds = new Set(lessons.map((item) => item.id));
        const material = store.state.materials.find((item) => item.id === studentMaterialDownloadMatch[1] && lessonIds.has(item.lessonId))
          || store.state.classMaterials.find((item) => item.id === studentMaterialDownloadMatch[1] && (!item.className || item.className === course?.className) && (!item.courseName || item.courseName === course?.courseName));
        if (!material || !fs.existsSync(material.filePath)) return sendJson(response, 404, { error: '资料不存在' });
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(material.filename)}`,
        });
        return fs.createReadStream(material.filePath).pipe(response);
      }

      if (request.method === 'GET' && pathname === '/api/student/state') {
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const availableCourses = studentCourseCatalog(store);
        const course = resolveStudentCourse(store, student, session.courseId);
        session.courseId = course?.id || '';
        const lessons = visibleLessonsForStudent(store, student, course);
        const lessonIds = new Set(lessons.map((item) => item.id));
        const exercises = store.state.exercises.filter((item) => lessonIds.has(item.lessonId) && item.published && (!item.targetStudentId || item.targetStudentId === student.studentId));
        const exerciseIds = new Set(exercises.map((item) => item.id));
        const submissions = store.state.submissions.filter((item) => item.studentId === student.studentId && exerciseIds.has(item.exerciseId));
        const materials = store.state.materials.filter((item) => lessonIds.has(item.lessonId)).map(({ filePath, ...item }) => item);
        const classMaterials = store.state.classMaterials.filter((item) => (!item.className || item.className === course?.className) && (!item.courseName || item.courseName === course?.courseName)).map(({ filePath, ...item }) => item);
        return sendJson(response, 200, {
          student, availableCourses, selectedCourseId: course?.id || '', lessons, exercises, submissions,
          attendance: store.state.attendance.filter((item) => item.studentId === student.studentId && lessonIds.has(item.lessonId)),
          materials, classMaterials, report: store.state.studentReports.find((item) => item.studentId === student.studentId) || null,
        });
      }
      if (request.method === 'POST' && pathname === '/api/student/attendance') {
        const body = await readJson(request);
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const course = resolveStudentCourse(store, student, session.courseId);
        const lesson = visibleLessonsForStudent(store, student, course).find((item) => item.id === body.lessonId);
        if (!lesson) throw new Error('当前课次不可签到');
        store.addAttendance({ id: crypto.randomUUID(), lessonId: lesson.id, studentId: student.studentId, status: 'present', signedAt: new Date().toISOString() });
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/student/submit') {
        const body = await readJson(request);
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const course = resolveStudentCourse(store, student, session.courseId);
        const lessonIds = new Set(visibleLessonsForStudent(store, student, course).map((item) => item.id));
        const exercise = store.state.exercises.find((item) => item.id === body.exerciseId && lessonIds.has(item.lessonId) && item.published && (!item.targetStudentId || item.targetStudentId === session.studentId));
        if (!exercise) throw new Error('题目不可提交');
        const existing = store.state.submissions.find((item) => item.studentId === session.studentId && item.exerciseId === exercise.id);
        if (existing) throw new Error('该题已经提交过');
        const result = await gradeAnswer(store.getSettings({ includeKey: true }), exercise, body.answer);
        const submission = {
          id: crypto.randomUUID(), studentId: session.studentId, exerciseId: exercise.id,
          answer: String(body.answer || ''), correct: result.correct, feedback: result.feedback,
          reason: result.reason || '', correctApproach: result.correctApproach || '', suggestion: result.suggestion || '',
          submittedAt: new Date().toISOString(),
        };
        store.addSubmission(submission);
        return sendJson(response, 201, { ok: true, submission });
      }
      const processMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/process$/);
      if (request.method === 'POST' && processMatch) {
        const id = processMatch[1];
        if (!store.getLesson(id)) return sendJson(response, 404, { error: '未找到教案' });
        if (!store.getSettings().hasApiKey) throw new Error('请先在 AI 设置中保存 API Key');
        const prerequisite = findLessonPrerequisite(store, store.getLesson(id));
        if (prerequisite) throw new Error(prerequisite.message);
        const lesson = store.getLesson(id);
        const downstream = lessonsInSeries(store, lesson)
          .filter((item) => Number(item.teachingWeek) > Number(lesson.teachingWeek) && ['blocked', 'queued'].includes(item.status))
          .map((item) => item.id);
        startProcessing([id, ...downstream]);
        return sendJson(response, 202, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/lessons/batch-delete') {
        const body = await readJson(request);
        const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(String))].slice(0, 500);
        if (!ids.length) throw new Error('请至少选择一个教案');
        const deleted = store.deleteLessons(ids);
        for (const id of ids) {
          for (const subscriber of lessonSubscribers.get(id) || []) subscriber.end();
          lessonSubscribers.delete(id);
        }
        return sendJson(response, 200, { ok: true, deleted });
      }
      if (request.method === 'DELETE' && pathname.startsWith('/api/lessons/')) {
        const id = pathname.slice('/api/lessons/'.length);
        return store.deleteLesson(id)
          ? sendJson(response, 200, { ok: true })
          : sendJson(response, 404, { error: '未找到教案' });
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return sendJson(response, 404, { error: '接口不存在' });
      }
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(rendererDir, relativePath);
      if (!filePath.startsWith(path.resolve(rendererDir) + path.sep) && filePath !== path.join(path.resolve(rendererDir), 'index.html')) {
        return sendJson(response, 403, { error: '无权访问' });
      }
      const finalPath = fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? filePath
        : path.join(rendererDir, 'index.html');
      response.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(finalPath)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
      });
      if (request.method === 'HEAD') return response.end();
      fs.createReadStream(finalPath).pipe(response);
    } catch (error) {
      sendJson(response, 400, { error: error.message || '请求失败' });
    }
  });

  activePort = await listen(server, preferredPort);
  if (store.getSettings().hasApiKey) {
    const pendingIds = store.state.lessons.filter((item) => ['ready', 'queued', 'processing', 'blocked'].includes(item.status)).map((item) => item.id);
    if (pendingIds.length) startProcessing(pendingIds);
  }
  return {
    port: activePort,
    store,
    close: () => {
      for (const subscribers of lessonSubscribers.values()) for (const response of subscribers) response.end();
      lessonSubscribers.clear();
      return server.close();
    },
  };
}

module.exports = { buildStandaloneCoursewareHtml, buildTeachingContext, createLanServer, exerciseBlueprintFromFields, findLessonPrerequisite, getLanUrls, lessonClassNames, parseCsv, parseRosterRows, processLessons };
