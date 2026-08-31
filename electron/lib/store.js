const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeUploadFilename, repairUtf8Mojibake } = require('./filenames');

const DEFAULT_STATE = {
  settings: {
    baseUrl: 'https://zenmux.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.6',
    modelOptions: [
      'anthropic/claude-sonnet-4.6',
      'google/gemini-3.1-pro-preview',
      'openai/gpt-5.4',
    ],
    apiKeyEncrypted: '',
    adminPasswordHash: '',
    gradingModel: '',
    exerciseReviewModel: '',
    attendanceTimeoutMinutes: 1440,
    mail: {
      host: '', port: 465, security: 'ssl', username: '', passwordEncrypted: '',
      senderEmail: '', senderName: 'AI 教学助手', studentEmailSuffix: '', testRecipient: '',
    },
  },
  lessons: [],
  students: [],
  exercises: [],
  submissions: [],
  attendance: [],
  materials: [],
  classMaterials: [],
  studentReports: [],
  classReports: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function exerciseCoverageForLesson(lesson, exercises) {
  const configs = Array.isArray(lesson?.exerciseOptions?.typeConfigs) ? lesson.exerciseOptions.typeConfigs : [];
  const counts = new Map();
  for (const exercise of exercises) {
    if (exercise.lessonId !== lesson.id || exercise.targetStudentId) continue;
    const type = exercise.type === 'coding' ? 'application' : exercise.type;
    counts.set(type, (counts.get(type) || 0) + 1);
  }
  const rows = configs
    .map((item) => ({
      type: item?.type === 'coding' ? 'application' : item?.type,
      expected: Math.max(0, Number(item?.count) || 0),
    }))
    .filter((item) => item.type && item.expected > 0)
    .map((item) => ({ ...item, actual: counts.get(item.type) || 0 }));
  return {
    configured: rows.length > 0,
    complete: rows.length > 0 && rows.every((item) => item.actual >= item.expected),
    expectedTotal: rows.reduce((sum, item) => sum + item.expected, 0),
    actualTotal: [...counts.values()].reduce((sum, count) => sum + count, 0),
    rows,
  };
}

class JsonStore {
  constructor(runtimeDir) {
    this.runtimeDir = runtimeDir;
    this.dataPath = path.join(runtimeDir, 'teaching-data.json');
    this.keyPath = path.join(runtimeDir, '.data-key');
    this.uploadDir = path.join(runtimeDir, 'uploads');
    fs.mkdirSync(this.uploadDir, { recursive: true });
    this.encryptionKey = this.#loadOrCreateKey();
    this.#backupExistingState();
    this.state = this.#load();
    const filenamesRepaired = this.#repairStoredFilenames();
    const coursewareDeduplicated = this.#deduplicateGeneratedCourseware();
    const lessonStatesRepaired = this.#repairCompletedLessonStates();
    if (filenamesRepaired || coursewareDeduplicated || lessonStatesRepaired) this.save();
  }

  #loadOrCreateKey() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    if (fs.existsSync(this.keyPath)) return fs.readFileSync(this.keyPath);
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    return key;
  }

  #backupExistingState() {
    if (!fs.existsSync(this.dataPath)) return;
    try {
      const day = new Date().toISOString().slice(0, 10);
      const backupDir = path.join(this.runtimeDir, 'automatic-backups', day);
      if (fs.existsSync(path.join(backupDir, 'teaching-data.json'))) return;
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(this.dataPath, path.join(backupDir, 'teaching-data.json'));
      if (fs.existsSync(this.keyPath)) {
        const backupKeyPath = path.join(backupDir, '.data-key');
        fs.copyFileSync(this.keyPath, backupKeyPath);
        fs.chmodSync(backupKeyPath, 0o600);
      }
    } catch { /* A backup failure must not prevent the application from starting. */ }
  }

  #load() {
    if (!fs.existsSync(this.dataPath)) return clone(DEFAULT_STATE);
    try {
      const saved = JSON.parse(fs.readFileSync(this.dataPath, 'utf8'));
      return {
        settings: { ...clone(DEFAULT_STATE.settings), ...(saved.settings || {}) },
        lessons: Array.isArray(saved.lessons) ? saved.lessons : [],
        students: Array.isArray(saved.students) ? saved.students : [],
        exercises: Array.isArray(saved.exercises) ? saved.exercises : [],
        submissions: Array.isArray(saved.submissions) ? saved.submissions : [],
        attendance: Array.isArray(saved.attendance) ? saved.attendance : [],
        materials: Array.isArray(saved.materials) ? saved.materials : [],
        classMaterials: Array.isArray(saved.classMaterials) ? saved.classMaterials : [],
        studentReports: Array.isArray(saved.studentReports) ? saved.studentReports : [],
        classReports: Array.isArray(saved.classReports) ? saved.classReports : [],
      };
    } catch {
      return clone(DEFAULT_STATE);
    }
  }

  #repairStoredFilenames() {
    let changed = false;
    for (const lesson of this.state.lessons) {
      const sourceFilename = normalizeUploadFilename(lesson.sourceFilename);
      const title = repairUtf8Mojibake(lesson.title).normalize('NFC');
      if (sourceFilename !== lesson.sourceFilename) { lesson.sourceFilename = sourceFilename; changed = true; }
      if (title !== lesson.title) { lesson.title = title; changed = true; }
    }
    for (const material of [...this.state.materials, ...this.state.classMaterials]) {
      const filename = normalizeUploadFilename(material.filename);
      if (filename !== material.filename) { material.filename = filename; changed = true; }
    }
    return changed;
  }

  #deduplicateGeneratedCourseware() {
    const latestByLesson = new Map();
    const duplicates = [];
    for (const material of this.state.materials.filter((item) => item.type === 'ai_generated')) {
      const existing = latestByLesson.get(material.lessonId);
      if (!existing) { latestByLesson.set(material.lessonId, material); continue; }
      const keepCurrent = String(material.createdAt || '').localeCompare(String(existing.createdAt || '')) >= 0;
      duplicates.push(keepCurrent ? existing : material);
      if (keepCurrent) latestByLesson.set(material.lessonId, material);
    }
    if (!duplicates.length) return false;
    const duplicateIds = new Set(duplicates.map((item) => item.id));
    this.state.materials = this.state.materials.filter((item) => !duplicateIds.has(item.id));
    for (const material of duplicates) {
      try { if (material.filePath && fs.existsSync(material.filePath)) fs.unlinkSync(material.filePath); } catch { /* Database cleanup should continue if an obsolete file is already gone. */ }
    }
    return true;
  }

  #repairCompletedLessonStates() {
    let changed = false;
    for (const lesson of this.state.lessons) {
      const hasPlan = Boolean(String(lesson.aiResult || lesson.structuredNotes || '').trim());
      const hasExercises = this.state.exercises.some((item) => item.lessonId === lesson.id && !item.targetStudentId);
      if (lesson.status === 'error' && hasPlan && hasExercises) {
        lesson.status = 'done';
        lesson.processingStage = '';
        lesson.planCompletedAt = lesson.planCompletedAt || lesson.updatedAt || new Date().toISOString();
        lesson.warning = lesson.warning || '教学方案和已生成题目均已保留；此前后续 AI 请求中断，可在题库中继续补充。';
        lesson.error = '';
        changed = true;
      }
    }
    return changed;
  }

  save() {
    const tempPath = `${this.dataPath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tempPath, this.dataPath);
  }

  encryptSecret(value) {
    if (!value) return '';
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }

  decryptSecret(payload) {
    if (!payload) return '';
    try {
      const data = Buffer.from(payload, 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
      return '';
    }
  }

  getSettings({ includeKey = false } = {}) {
    const settings = this.state.settings;
    return {
      baseUrl: settings.baseUrl,
      model: settings.model,
      modelOptions: settings.modelOptions,
      gradingModel: settings.gradingModel || settings.model,
      exerciseReviewModel: settings.exerciseReviewModel || '',
      attendanceTimeoutMinutes: settings.attendanceTimeoutMinutes || 1440,
      hasApiKey: Boolean(settings.apiKeyEncrypted),
      hasCustomAdminPassword: Boolean(settings.adminPasswordHash),
      mail: {
        ...(settings.mail || DEFAULT_STATE.settings.mail),
        passwordEncrypted: undefined,
        hasPassword: Boolean(settings.mail?.passwordEncrypted),
      },
      ...(includeKey ? { apiKey: this.decryptSecret(settings.apiKeyEncrypted) } : {}),
    };
  }

  updateSettings(values) {
    const baseUrl = String(values.baseUrl || '').trim().replace(/\/+$/, '');
    const model = String(values.model || '').trim();
    const exerciseReviewModel = Object.hasOwn(values, 'exerciseReviewModel')
      ? String(values.exerciseReviewModel || '').trim()
      : String(this.state.settings.exerciseReviewModel || '').trim();
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('BaseURL 必须以 http:// 或 https:// 开头');
    if (!model) throw new Error('请选择或填写模型名称');
    if (exerciseReviewModel && exerciseReviewModel === model) throw new Error('题目复核模型必须与主模型不同');
    const previousBaseUrl = String(this.state.settings.baseUrl || '').trim().replace(/\/+$/, '');
    this.state.settings.baseUrl = baseUrl;
    this.state.settings.model = model;
    if (!this.state.settings.modelOptions.includes(model)) this.state.settings.modelOptions.unshift(model);
    if (String(values.apiKey || '').trim()) {
      this.state.settings.apiKeyEncrypted = this.encryptSecret(String(values.apiKey).trim());
    } else if (baseUrl !== previousBaseUrl) {
      this.state.settings.apiKeyEncrypted = '';
    }
    if (Object.hasOwn(values, 'gradingModel')) this.state.settings.gradingModel = String(values.gradingModel || '').trim();
    if (Object.hasOwn(values, 'exerciseReviewModel')) this.state.settings.exerciseReviewModel = exerciseReviewModel;
    if (values.attendanceTimeoutMinutes) this.state.settings.attendanceTimeoutMinutes = Math.max(1, Number(values.attendanceTimeoutMinutes));
    this.save();
    return this.getSettings();
  }

  verifyAdminPassword(password) {
    const stored = this.state.settings.adminPasswordHash;
    if (!stored) return String(password) === 'admin';
    const [salt, expected] = stored.split(':');
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(String(password), salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
  }

  setAdminPassword(password) {
    if (String(password).length < 4) throw new Error('教师密码至少需要 4 个字符');
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
    this.state.settings.adminPasswordHash = `${salt}:${hash}`;
    this.save();
  }

  updateMailSettings(values) {
    const current = this.state.settings.mail || clone(DEFAULT_STATE.settings.mail);
    this.state.settings.mail = {
      ...current,
      host: String(values.host || '').trim(),
      port: Number(values.port) || 465,
      security: String(values.security || 'ssl'),
      username: String(values.username || '').trim(),
      senderEmail: String(values.senderEmail || '').trim(),
      senderName: String(values.senderName || '').trim() || 'AI 教学助手',
      studentEmailSuffix: String(values.studentEmailSuffix || '').trim(),
      testRecipient: String(values.testRecipient || '').trim(),
    };
    if (String(values.password || '').trim()) current.passwordEncrypted = this.encryptSecret(String(values.password).trim());
    this.state.settings.mail.passwordEncrypted = current.passwordEncrypted || '';
    this.save();
  }

  getMailSettings({ includePassword = false } = {}) {
    const mail = this.state.settings.mail || clone(DEFAULT_STATE.settings.mail);
    return { ...mail, ...(includePassword ? { password: this.decryptSecret(mail.passwordEncrypted) } : {}), passwordEncrypted: undefined };
  }

  setModelOptions(models) {
    this.state.settings.modelOptions = [...new Set(models.filter(Boolean))].slice(0, 200);
    this.save();
  }

  listLessons() {
    return this.state.lessons
      .map(({ rawText, sourceStoredName, ...item }) => ({
        ...item,
        sourceLength: String(rawText || '').length,
        exerciseCoverage: exerciseCoverageForLesson(item, this.state.exercises),
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.createdAt.localeCompare(a.createdAt));
  }

  getLesson(id) {
    return this.state.lessons.find((item) => item.id === id) || null;
  }

  getLessonDetail(id) {
    const lesson = this.getLesson(id);
    if (!lesson) return null;
    const exercises = this.state.exercises.filter((item) => item.lessonId === id);
    const submissions = this.state.submissions.filter((item) => exercises.some((exercise) => exercise.id === item.exerciseId));
    const attendance = this.state.attendance.filter((item) => item.lessonId === id);
    const materials = this.state.materials.filter((item) => item.lessonId === id);
    const { sourceStoredName, ...visibleLesson } = lesson;
    return {
      ...visibleLesson,
      exercises,
      submissions,
      attendance,
      materials,
      exerciseCoverage: exerciseCoverageForLesson(lesson, this.state.exercises),
    };
  }

  addLessons(lessons) {
    this.state.lessons.push(...lessons);
    this.save();
  }

  updateLesson(id, changes) {
    const lesson = this.getLesson(id);
    if (!lesson) return null;
    Object.assign(lesson, changes, { updatedAt: new Date().toISOString() });
    this.save();
    return lesson;
  }

  deleteLesson(id) {
    return this.deleteLessons([id]) === 1;
  }

  deleteLessons(ids) {
    const requested = new Set((Array.isArray(ids) ? ids : []).map(String));
    const existingIds = new Set(this.state.lessons.filter((item) => requested.has(item.id)).map((item) => item.id));
    if (!existingIds.size) return 0;
    const relatedMaterials = this.state.materials.filter((item) => existingIds.has(item.lessonId));
    const relatedSourceNames = new Set(this.state.lessons.filter((item) => existingIds.has(item.id)).map((item) => item.sourceStoredName).filter(Boolean));
    const exerciseIds = new Set(this.state.exercises.filter((item) => existingIds.has(item.lessonId)).map((item) => item.id));
    this.state.lessons = this.state.lessons.filter((item) => !existingIds.has(item.id));
    this.state.exercises = this.state.exercises.filter((item) => !existingIds.has(item.lessonId));
    this.state.submissions = this.state.submissions.filter((item) => !exerciseIds.has(item.exerciseId));
    this.state.attendance = this.state.attendance.filter((item) => !existingIds.has(item.lessonId));
    this.state.materials = this.state.materials.filter((item) => !existingIds.has(item.lessonId));
    for (const material of relatedMaterials) {
      try { if (material.filePath && fs.existsSync(material.filePath)) fs.unlinkSync(material.filePath); } catch { /* Keep data deletion reliable even if an attachment was moved externally. */ }
    }
    for (const sourceStoredName of relatedSourceNames) {
      if (this.state.lessons.some((item) => item.sourceStoredName === sourceStoredName)) continue;
      try {
        const sourcePath = path.join(this.uploadDir, path.basename(sourceStoredName));
        if (fs.existsSync(sourcePath)) fs.unlinkSync(sourcePath);
      } catch { /* A missing source copy must not prevent deleting its database records. */ }
    }
    this.save();
    return existingIds.size;
  }

  upsertStudent(student) {
    const studentId = String(student.studentId || '').trim();
    if (!studentId || !String(student.name || '').trim()) throw new Error('学号和姓名不能为空');
    const existing = this.state.students.find((item) => item.studentId === studentId);
    const record = { id: existing?.id || crypto.randomUUID(), ...existing, ...student, studentId, name: String(student.name).trim(), updatedAt: new Date().toISOString() };
    if (existing) Object.assign(existing, record); else this.state.students.push(record);
    this.save();
    return record;
  }

  upsertStudents(students) {
    let added = 0;
    let updated = 0;
    for (const student of students) {
      const studentId = String(student.studentId || '').trim();
      const name = String(student.name || '').trim();
      if (!studentId || !name) continue;
      const existing = this.state.students.find((item) => item.studentId === studentId);
      const record = { id: existing?.id || crypto.randomUUID(), ...existing, ...student, studentId, name, updatedAt: new Date().toISOString() };
      if (existing) { Object.assign(existing, record); updated += 1; }
      else { this.state.students.push(record); added += 1; }
    }
    this.save();
    return { added, updated };
  }

  deleteStudent(studentId) {
    this.state.students = this.state.students.filter((item) => item.studentId !== studentId);
    this.state.submissions = this.state.submissions.filter((item) => item.studentId !== studentId);
    this.state.attendance = this.state.attendance.filter((item) => item.studentId !== studentId);
    this.state.exercises = this.state.exercises.filter((item) => item.targetStudentId !== studentId);
    this.save();
  }

  deleteClass(courseName, className) {
    const normalizedCourse = String(courseName || '').trim();
    const normalizedClass = String(className || '').trim();
    if (!normalizedCourse || !normalizedClass) throw new Error('课程和班级不能为空');
    const studentIds = new Set(this.state.students
      .filter((item) => item.courseName === normalizedCourse && item.className === normalizedClass)
      .map((item) => item.studentId));
    const relatedMaterials = this.state.classMaterials
      .filter((item) => item.courseName === normalizedCourse && item.className === normalizedClass);

    this.state.students = this.state.students.filter((item) => !(item.courseName === normalizedCourse && item.className === normalizedClass));
    this.state.submissions = this.state.submissions.filter((item) => !studentIds.has(item.studentId));
    this.state.attendance = this.state.attendance.filter((item) => !studentIds.has(item.studentId));
    this.state.exercises = this.state.exercises.filter((item) => !studentIds.has(item.targetStudentId));
    this.state.studentReports = this.state.studentReports.filter((item) => !studentIds.has(item.studentId));
    this.state.classReports = this.state.classReports.filter((item) => !(item.courseName === normalizedCourse && item.className === normalizedClass));
    this.state.classMaterials = this.state.classMaterials.filter((item) => !(item.courseName === normalizedCourse && item.className === normalizedClass));
    let unlinkedLessons = 0;
    for (const lesson of this.state.lessons.filter((item) => item.courseName === normalizedCourse)) {
      const names = [...new Set([...(Array.isArray(lesson.classNames) ? lesson.classNames : []), lesson.className]
        .map((item) => String(item || '').trim()).filter(Boolean))];
      if (!names.includes(normalizedClass)) continue;
      const remaining = names.filter((item) => item !== normalizedClass);
      lesson.classNames = remaining;
      lesson.className = remaining[0] || '';
      lesson.updatedAt = new Date().toISOString();
      unlinkedLessons += 1;
    }
    for (const material of relatedMaterials) {
      try { if (material.filePath && fs.existsSync(material.filePath)) fs.unlinkSync(material.filePath); } catch { /* Missing class files must not block deleting the class. */ }
    }
    this.save();
    return { students: studentIds.size, lessons: unlinkedLessons, materials: relatedMaterials.length };
  }

  deleteCourse(courseName) {
    const normalizedCourse = String(courseName || '').trim();
    if (!normalizedCourse) throw new Error('课程不能为空');
    const lessonIds = this.state.lessons.filter((item) => item.courseName === normalizedCourse).map((item) => item.id);
    const studentIds = new Set(this.state.students.filter((item) => item.courseName === normalizedCourse).map((item) => item.studentId));
    const relatedMaterials = this.state.classMaterials.filter((item) => item.courseName === normalizedCourse);
    const deletedLessons = this.deleteLessons(lessonIds);

    this.state.students = this.state.students.filter((item) => item.courseName !== normalizedCourse);
    this.state.submissions = this.state.submissions.filter((item) => !studentIds.has(item.studentId));
    this.state.attendance = this.state.attendance.filter((item) => !studentIds.has(item.studentId));
    this.state.exercises = this.state.exercises.filter((item) => !studentIds.has(item.targetStudentId));
    this.state.studentReports = this.state.studentReports.filter((item) => !studentIds.has(item.studentId));
    this.state.classReports = this.state.classReports.filter((item) => item.courseName !== normalizedCourse);
    this.state.classMaterials = this.state.classMaterials.filter((item) => item.courseName !== normalizedCourse);
    for (const material of relatedMaterials) {
      try { if (material.filePath && fs.existsSync(material.filePath)) fs.unlinkSync(material.filePath); } catch { /* Missing course files must not block deleting the course. */ }
    }
    this.save();
    return { lessons: deletedLessons, students: studentIds.size, materials: relatedMaterials.length };
  }

  addExercises(items) { this.state.exercises.push(...items); this.save(); }
  updateExercise(id, changes) { const item = this.state.exercises.find((row) => row.id === id); if (!item) return null; Object.assign(item, changes); this.save(); return item; }
  addSubmission(item) { this.state.submissions.push(item); this.save(); }
  addAttendance(item) { if (!this.state.attendance.some((row) => row.lessonId === item.lessonId && row.studentId === item.studentId)) this.state.attendance.push(item); this.save(); }
}

module.exports = { JsonStore };
