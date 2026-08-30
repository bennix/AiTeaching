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
const {
  fetchModels,
  generateExercises,
  generateExercisesForBlueprint,
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

function visibleLessonsForStudent(store, student) {
  return store.state.lessons.filter((lesson) => lesson.status === 'done'
    && (!student.courseName || !lesson.courseName || lesson.courseName === student.courseName)
    && (!student.className || !lesson.className || lesson.className === student.className));
}

function studentsForLesson(store, lesson) {
  return store.state.students.filter((student) => (!student.courseName || !lesson.courseName || student.courseName === lesson.courseName)
    && (!student.className || !lesson.className || student.className === lesson.className));
}

function htmlEscape(value) {
  return String(value || '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
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
  return `course:${lesson.courseName || ''}\u0000${lesson.className || ''}`;
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
    store.updateLesson(lesson.id, { status: 'queued', processingStage: 'queued', error: '' });
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
      store.updateLesson(id, { status: 'processing', processingStage: 'planning', error: '', aiResult: '', structuredNotes: '' });
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
      store.updateLesson(id, { status: 'processing', processingStage: 'exercises', aiResult, structuredNotes: aiResult });
      notify(store.getLesson(id));
      if (!store.state.exercises.some((item) => item.lessonId === id && !item.targetStudentId)) {
        const generated = await generateExercisesForBlueprint(settings, { ...lesson, aiResult }, lesson.exerciseOptions);
        if (!store.getLesson(id)) continue;
        store.addExercises(generated.map((item) => ({
          id: crypto.randomUUID(), lessonId: id, targetStudentId: null, published: false,
          type: ['choice', 'short_answer', 'application', 'coding'].includes(item.type) ? item.type : 'short_answer',
          question: String(item.question || ''), answer: String(item.answer || ''),
          difficulty: ['easy', 'medium', 'hard'].includes(item.difficulty) ? item.difficulty : 'medium',
          knowledgePoint: String(item.knowledgePoint || ''), createdAt: new Date().toISOString(),
        })).filter((item) => item.question && item.answer));
      }
      if (!store.getLesson(id)) continue;
      store.updateLesson(id, { status: 'done', processingStage: '', aiResult, structuredNotes: aiResult });
      notify(store.getLesson(id));
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

  const lessonStreamPayload = (lesson) => JSON.stringify({
    id: lesson.id,
    status: lesson.status,
    processingStage: lesson.processingStage || '',
    aiResult: lesson.aiResult || '',
    error: lesson.error || '',
    updatedAt: lesson.updatedAt,
  });
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
        const token = crypto.randomUUID();
        sessions.set(token, { role: 'student', studentId: student.studentId });
        return sendJson(response, 200, { ok: true, role: 'student' }, { 'Set-Cookie': `aiaid_session=${token}; HttpOnly; SameSite=Lax; Path=/` });
      }
      if (request.method === 'POST' && pathname === '/api/auth/logout') {
        sessions.delete(cookies(request).aiaid_session);
        return sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'aiaid_session=; Max-Age=0; Path=/' });
      }
      if (request.method === 'GET' && pathname === '/api/public/classes') {
        return sendJson(response, 200, { classes: [...new Set(store.state.students.map((item) => item.className).filter(Boolean))].sort() });
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
        const models = await fetchModels(store.getSettings({ includeKey: true }));
        if (!models.length) throw new Error('服务未返回可用模型列表，可直接手动填写模型 ID');
        store.setModelOptions(models);
        return sendJson(response, 200, { ok: true, models });
      }
      if (request.method === 'POST' && pathname === '/api/import') {
        const { fields, file } = await readMultipart(request);
        if (!file) throw new Error('请选择教案文件');
        const text = await extractDocumentText(file.filename, file.buffer);
        const storedName = `${Date.now()}-${file.filename.replace(/[^\p{L}\p{N}._-]+/gu, '_')}`;
        const lessons = buildLessonRecords({ ...fields, filename: file.filename, text });
        for (const lesson of lessons) {
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
        if (!file) throw new Error('请选择 CSV 或 XLSX 名册');
        const extension = path.extname(file.filename).toLowerCase();
        if (!['.csv', '.xlsx'].includes(extension)) throw new Error('名册仅支持 CSV 或 XLSX');
        const rows = extension === '.csv' ? parseCsv(file.buffer.toString('utf8')) : await readXlsxFile(file.buffer);
        if (!rows.length) throw new Error('名册没有数据');
        const headerAliases = {
          studentId: ['学号', 'student_id', 'student id', 'id'], name: ['姓名', 'name'], major: ['专业', 'major'],
          gender: ['性别', 'gender'], email: ['邮箱', 'email', 'mail'], className: ['班级', 'class', 'class_name'], courseName: ['课程', 'course', 'course_name'],
        };
        const normalizedHeader = rows[0].map((item) => String(item).trim().toLowerCase());
        const indexes = Object.fromEntries(Object.entries(headerAliases).map(([key, aliases]) => [key, normalizedHeader.findIndex((item) => aliases.includes(item))]));
        const hasHeader = indexes.studentId >= 0 && indexes.name >= 0;
        const positions = hasHeader ? indexes : { studentId: 0, name: 1, major: 2, gender: 3, email: 4, className: 5, courseName: 6 };
        let count = 0;
        for (const row of rows.slice(hasHeader ? 1 : 0)) {
          const value = (key) => positions[key] >= 0 ? String(row[positions[key]] || '').trim() : '';
          if (!value('studentId') || !value('name')) continue;
          store.upsertStudent({
            studentId: value('studentId'), name: value('name'), major: value('major'), gender: value('gender'), email: value('email'),
            className: String(fields.className || '').trim() || value('className'), courseName: String(fields.courseName || '').trim() || value('courseName'),
          });
          count += 1;
        }
        return sendJson(response, 201, { ok: true, count });
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
        store.updateLesson(lesson.id, { exerciseOptions: { mode: 'current', typeConfigs: normalized } });
        const generated = await generateExercisesForBlueprint(store.getSettings({ includeKey: true }), lesson, blueprint);
        const records = generated.map((item) => ({ id: crypto.randomUUID(), lessonId: lesson.id, targetStudentId: null, published: false, type: item.type || 'short_answer', question: item.question, answer: item.answer, difficulty: item.difficulty || 'medium', knowledgePoint: item.knowledgePoint || '', createdAt: new Date().toISOString() }));
        store.addExercises(records);
        return sendJson(response, 201, { ok: true, exercises: records });
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
        const records = generated.map((item) => ({ id: crypto.randomUUID(), lessonId: lesson.id, targetStudentId: studentId, published: true, type: item.type || 'short_answer', question: item.question, answer: item.answer, difficulty: item.difficulty || 'medium', knowledgePoint: item.knowledgePoint || '', createdAt: new Date().toISOString() }));
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
      const coursewareMatch = pathname.match(/^\/api\/lessons\/([^/]+)\/courseware$/);
      if (request.method === 'POST' && coursewareMatch) {
        const lesson = store.getLessonDetail(coursewareMatch[1]);
        if (!lesson) return sendJson(response, 404, { error: '未找到课次' });
        const filename = `第${lesson.teachingWeek}周_${String(lesson.title).replace(/[^\p{L}\p{N}_-]+/gu, '_')}.html`;
        const filePath = path.join(store.uploadDir, `${Date.now()}-${filename}`);
        const exerciseHtml = lesson.exercises.map((item, index) => `<section><h3>练习 ${index + 1}</h3><pre>${htmlEscape(item.question)}</pre></section>`).join('');
        fs.writeFileSync(filePath, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${htmlEscape(lesson.title)}</title><style>body{font:18px/1.8 system-ui;max-width:1000px;margin:auto;padding:5vw;color:#172033}header{padding:5vw;border-radius:24px;background:#17213a;color:white}main{padding:3vw}pre{white-space:pre-wrap;background:#f3f5fa;padding:18px;border-radius:12px}</style><header><small>第 ${lesson.teachingWeek} 教学周</small><h1>${htmlEscape(lesson.title)}</h1><p>${htmlEscape(lesson.courseName)}</p></header><main><pre>${htmlEscape(lesson.aiResult)}</pre>${exerciseHtml}</main></html>`, 'utf8');
        const material = { id: crypto.randomUUID(), lessonId: lesson.id, type: 'ai_generated', filename, filePath, createdAt: new Date().toISOString() };
        store.state.materials.push(material); store.save();
        return sendJson(response, 201, { ok: true, material: { ...material, filePath: undefined } });
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

      const materialDownloadMatch = pathname.match(/^\/api\/student\/material\/([^/]+)\/download$/);
      if (request.method === 'GET' && materialDownloadMatch) {
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const lessons = visibleLessonsForStudent(store, student);
        const lessonIds = new Set(lessons.map((item) => item.id));
        const material = store.state.materials.find((item) => item.id === materialDownloadMatch[1] && lessonIds.has(item.lessonId))
          || store.state.classMaterials.find((item) => item.id === materialDownloadMatch[1] && (!item.className || item.className === student.className) && (!item.courseName || item.courseName === student.courseName));
        if (!material || !fs.existsSync(material.filePath)) return sendJson(response, 404, { error: '资料不存在' });
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(material.filename)}`,
        });
        return fs.createReadStream(material.filePath).pipe(response);
      }

      if (request.method === 'GET' && pathname === '/api/student/state') {
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const lessons = visibleLessonsForStudent(store, student);
        const lessonIds = new Set(lessons.map((item) => item.id));
        const exercises = store.state.exercises.filter((item) => lessonIds.has(item.lessonId) && item.published && (!item.targetStudentId || item.targetStudentId === student.studentId));
        const submissions = store.state.submissions.filter((item) => item.studentId === student.studentId);
        const materials = store.state.materials.filter((item) => lessonIds.has(item.lessonId)).map(({ filePath, ...item }) => item);
        const classMaterials = store.state.classMaterials.filter((item) => (!item.className || item.className === student.className) && (!item.courseName || item.courseName === student.courseName)).map(({ filePath, ...item }) => item);
        return sendJson(response, 200, { student, lessons, exercises, submissions, attendance: store.state.attendance.filter((item) => item.studentId === student.studentId), materials, classMaterials, report: store.state.studentReports.find((item) => item.studentId === student.studentId) || null });
      }
      if (request.method === 'POST' && pathname === '/api/student/attendance') {
        const body = await readJson(request);
        const student = store.state.students.find((item) => item.studentId === session.studentId);
        const lesson = visibleLessonsForStudent(store, student).find((item) => item.id === body.lessonId);
        if (!lesson) throw new Error('当前课次不可签到');
        store.addAttendance({ id: crypto.randomUUID(), lessonId: lesson.id, studentId: student.studentId, status: 'present', signedAt: new Date().toISOString() });
        return sendJson(response, 200, { ok: true });
      }
      if (request.method === 'POST' && pathname === '/api/student/submit') {
        const body = await readJson(request);
        const exercise = store.state.exercises.find((item) => item.id === body.exerciseId && item.published && (!item.targetStudentId || item.targetStudentId === session.studentId));
        if (!exercise) throw new Error('题目不可提交');
        const existing = store.state.submissions.find((item) => item.studentId === session.studentId && item.exerciseId === exercise.id);
        if (existing) throw new Error('该题已经提交过');
        const result = await gradeAnswer(store.getSettings({ includeKey: true }), exercise, body.answer);
        const submission = { id: crypto.randomUUID(), studentId: session.studentId, exerciseId: exercise.id, answer: String(body.answer || ''), correct: result.correct, feedback: result.feedback, submittedAt: new Date().toISOString() };
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
    const pendingIds = store.state.lessons.filter((item) => ['ready', 'queued', 'processing'].includes(item.status)).map((item) => item.id);
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

module.exports = { buildTeachingContext, createLanServer, exerciseBlueprintFromFields, findLessonPrerequisite, getLanUrls, parseCsv, processLessons };
