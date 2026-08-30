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
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class JsonStore {
  constructor(runtimeDir) {
    this.runtimeDir = runtimeDir;
    this.dataPath = path.join(runtimeDir, 'teaching-data.json');
    this.keyPath = path.join(runtimeDir, '.data-key');
    this.uploadDir = path.join(runtimeDir, 'uploads');
    fs.mkdirSync(this.uploadDir, { recursive: true });
    this.encryptionKey = this.#loadOrCreateKey();
    this.state = this.#load();
    if (this.#repairStoredFilenames()) this.save();
  }

  #loadOrCreateKey() {
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    if (fs.existsSync(this.keyPath)) return fs.readFileSync(this.keyPath);
    const key = crypto.randomBytes(32);
    fs.writeFileSync(this.keyPath, key, { mode: 0o600 });
    return key;
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
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error('BaseURL 必须以 http:// 或 https:// 开头');
    if (!model) throw new Error('请选择或填写模型名称');
    this.state.settings.baseUrl = baseUrl;
    this.state.settings.model = model;
    if (!this.state.settings.modelOptions.includes(model)) this.state.settings.modelOptions.unshift(model);
    if (String(values.apiKey || '').trim()) {
      this.state.settings.apiKeyEncrypted = this.encryptSecret(String(values.apiKey).trim());
    }
    if (values.gradingModel) this.state.settings.gradingModel = String(values.gradingModel).trim();
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
    if (!this.state.settings.modelOptions.includes(this.state.settings.model)) {
      this.state.settings.modelOptions.unshift(this.state.settings.model);
    }
    this.save();
  }

  listLessons() {
    return this.state.lessons
      .map(({ rawText, sourceStoredName, ...item }) => ({ ...item, sourceLength: String(rawText || '').length }))
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
    return { ...visibleLesson, exercises, submissions, attendance, materials };
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

  deleteStudent(studentId) {
    this.state.students = this.state.students.filter((item) => item.studentId !== studentId);
    this.state.submissions = this.state.submissions.filter((item) => item.studentId !== studentId);
    this.state.attendance = this.state.attendance.filter((item) => item.studentId !== studentId);
    this.state.exercises = this.state.exercises.filter((item) => item.targetStudentId !== studentId);
    this.save();
  }

  addExercises(items) { this.state.exercises.push(...items); this.save(); }
  updateExercise(id, changes) { const item = this.state.exercises.find((row) => row.id === id); if (!item) return null; Object.assign(item, changes); this.save(); return item; }
  addSubmission(item) { this.state.submissions.push(item); this.save(); }
  addAttendance(item) { if (!this.state.attendance.some((row) => row.lessonId === item.lessonId && row.studentId === item.studentId)) this.state.attendance.push(item); this.save(); }
}

module.exports = { JsonStore };
