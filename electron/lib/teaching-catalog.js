const { catalogPairKey, normalizeCatalogName, sameCatalogName } = require('./catalog-identity');

function lessonClassNames(lesson = {}) {
  const values = Array.isArray(lesson.classNames) && lesson.classNames.length ? lesson.classNames : [lesson.className];
  const names = new Map();
  for (const value of values) {
    const name = String(value || '').trim();
    if (name) names.set(normalizeCatalogName(name), name);
  }
  return names.size ? [...names.values()] : [''];
}

// The roster defines existing course/class pairs; lesson processing never creates a class.
function establishedCourseClasses(state) {
  const courses = new Map();
  for (const student of state.students) {
    const className = String(student.className || '').trim();
    const courseName = String(state.lessons.find((lesson) => sameCatalogName(lesson.courseName, student.courseName))?.courseName || student.courseName || '').trim();
    if (!courseName || !className) continue;
    const identity = catalogPairKey(courseName, className);
    if (!courses.has(identity)) courses.set(identity, {
      id: Buffer.from(identity, 'utf8').toString('base64url'),
      courseName, className, label: `${courseName} · ${className}`,
    });
  }
  return [...courses.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-CN'));
}

function linkPendingLessons(state) {
  const catalog = establishedCourseClasses(state);
  const linked = [];
  for (const lesson of state.lessons) {
    // Deliberately detached and legacy unknown records require teacher selection.
    if (lesson.classAssociation !== 'pending' || lessonClassNames(lesson).some(Boolean)) continue;
    const candidates = catalog.filter((item) => sameCatalogName(item.courseName, lesson.courseName));
    if (candidates.length !== 1) continue;
    lesson.className = candidates[0].className;
    lesson.classNames = [candidates[0].className];
    lesson.classAssociation = 'linked';
    lesson.updatedAt = new Date().toISOString();
    linked.push(lesson.id);
  }
  return linked;
}

module.exports = { establishedCourseClasses, lessonClassNames, linkPendingLessons };
