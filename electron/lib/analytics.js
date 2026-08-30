function text(value) {
  return String(value || '').trim();
}

function percentage(numerator, denominator) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function unique(values) {
  return [...new Set(values.map(text).filter(Boolean))].sort((left, right) => left.localeCompare(right, 'zh-CN'));
}

function reportScopeKey({ courseName = '', className = '', lessonId = '' } = {}) {
  return [text(courseName), text(className), text(lessonId)].join('\u241f');
}

function buildLearningAnalytics(state = {}, requestedFilters = {}) {
  const allLessons = Array.isArray(state.lessons) ? state.lessons : [];
  const allStudents = Array.isArray(state.students) ? state.students : [];
  const allExercises = Array.isArray(state.exercises) ? state.exercises : [];
  const allSubmissions = Array.isArray(state.submissions) ? state.submissions : [];
  const allAttendance = Array.isArray(state.attendance) ? state.attendance : [];
  const allReports = Array.isArray(state.classReports) ? state.classReports : [];

  const completedLessons = allLessons.filter((lesson) => lesson.status === 'done');
  const courses = unique([
    ...completedLessons.map((lesson) => lesson.courseName),
    ...allStudents.map((student) => student.courseName),
  ]);
  const requestedCourse = text(requestedFilters.courseName);
  const courseName = courses.includes(requestedCourse) ? requestedCourse : (requestedCourse || courses[0] || '');
  const classes = unique(allStudents
    .filter((student) => !courseName || !text(student.courseName) || text(student.courseName) === courseName)
    .map((student) => student.className));
  const requestedClass = text(requestedFilters.className);
  const className = classes.includes(requestedClass) ? requestedClass : requestedClass;
  const requestedLessonId = text(requestedFilters.lessonId);

  const courseLessons = completedLessons
    .filter((lesson) => !courseName || text(lesson.courseName) === courseName)
    .sort((left, right) => (Number(left.teachingWeek) || 0) - (Number(right.teachingWeek) || 0)
      || text(left.date).localeCompare(text(right.date)));
  const lessonId = requestedLessonId && courseLessons.some((lesson) => lesson.id === requestedLessonId) ? requestedLessonId : '';
  const lessons = courseLessons.filter((lesson) => !lessonId || lesson.id === lessonId);
  const lessonIds = new Set(lessons.map((lesson) => lesson.id));

  const students = allStudents
    .filter((student) => (!courseName || !text(student.courseName) || text(student.courseName) === courseName)
      && (!className || text(student.className) === className))
    .sort((left, right) => text(left.studentId).localeCompare(text(right.studentId), 'zh-CN'));
  const studentIds = new Set(students.map((student) => student.studentId));
  const exercises = allExercises.filter((exercise) => lessonIds.has(exercise.lessonId) && exercise.published);
  const exerciseById = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  const submissions = allSubmissions.filter((submission) => studentIds.has(submission.studentId) && exerciseById.has(submission.exerciseId));
  const submissionByAssignment = new Map(submissions.map((submission) => [`${submission.studentId}\u241f${submission.exerciseId}`, submission]));
  const attendanceKeys = new Set(allAttendance
    .filter((record) => record.status === 'present' && studentIds.has(record.studentId) && lessonIds.has(record.lessonId))
    .map((record) => `${record.studentId}\u241f${record.lessonId}`));

  const assignmentsFor = (studentId, scopedExercises = exercises) => scopedExercises
    .filter((exercise) => !exercise.targetStudentId || exercise.targetStudentId === studentId);
  const submissionsFor = (studentId, scopedExercises = exercises) => assignmentsFor(studentId, scopedExercises)
    .map((exercise) => submissionByAssignment.get(`${studentId}\u241f${exercise.id}`))
    .filter(Boolean);

  const studentRows = students.map((student) => {
    const assignments = assignmentsFor(student.studentId);
    const answered = submissionsFor(student.studentId);
    const correct = answered.filter((submission) => submission.correct).length;
    const present = lessons.filter((lesson) => attendanceKeys.has(`${student.studentId}\u241f${lesson.id}`)).length;
    const weakPoints = unique(answered
      .filter((submission) => !submission.correct)
      .map((submission) => exerciseById.get(submission.exerciseId)?.knowledgePoint));
    return {
      studentId: student.studentId,
      name: student.name,
      className: student.className || '',
      attendancePresent: present,
      attendanceExpected: lessons.length,
      attendanceRate: percentage(present, lessons.length),
      answeredCount: answered.length,
      assignmentCount: assignments.length,
      completionRate: percentage(answered.length, assignments.length),
      correctCount: correct,
      accuracyRate: percentage(correct, answered.length),
      weakPoints,
    };
  });

  const knowledge = new Map();
  for (const submission of submissions) {
    const name = text(exerciseById.get(submission.exerciseId)?.knowledgePoint);
    if (!name) continue;
    const current = knowledge.get(name) || { name, attempts: 0, correct: 0 };
    current.attempts += 1;
    if (submission.correct) current.correct += 1;
    knowledge.set(name, current);
  }
  const knowledgePoints = [...knowledge.values()]
    .map((item) => ({ ...item, masteryRate: percentage(item.correct, item.attempts) }))
    .sort((left, right) => left.masteryRate - right.masteryRate || right.attempts - left.attempts || left.name.localeCompare(right.name, 'zh-CN'));

  const trends = lessons.map((lesson) => {
    const lessonExercises = exercises.filter((exercise) => exercise.lessonId === lesson.id);
    const assignmentCount = students.reduce((sum, student) => sum + assignmentsFor(student.studentId, lessonExercises).length, 0);
    const answered = students.flatMap((student) => submissionsFor(student.studentId, lessonExercises));
    const correct = answered.filter((submission) => submission.correct).length;
    const present = students.filter((student) => attendanceKeys.has(`${student.studentId}\u241f${lesson.id}`)).length;
    return {
      lessonId: lesson.id,
      week: Number(lesson.teachingWeek) || 0,
      title: lesson.title || `第 ${lesson.teachingWeek || '-'} 周`,
      date: lesson.date || '',
      attendanceRate: percentage(present, students.length),
      completionRate: percentage(answered.length, assignmentCount),
      accuracyRate: percentage(correct, answered.length),
    };
  });

  const attendancePresent = attendanceKeys.size;
  const attendanceExpected = students.length * lessons.length;
  const assignmentCount = studentRows.reduce((sum, student) => sum + student.assignmentCount, 0);
  const answeredCount = studentRows.reduce((sum, student) => sum + student.answeredCount, 0);
  const correctCount = studentRows.reduce((sum, student) => sum + student.correctCount, 0);
  const scopeKey = reportScopeKey({ courseName, className, lessonId });
  const latestReport = allReports
    .filter((report) => report.scopeKey === scopeKey
      || (text(report.courseName) === courseName && text(report.className) === className && text(report.lessonId) === lessonId))
    .sort((left, right) => text(right.createdAt).localeCompare(text(left.createdAt)))[0] || null;

  return {
    filters: {
      courseName,
      className,
      lessonId,
      courses,
      classes,
      lessons: courseLessons.map((lesson) => ({
        id: lesson.id,
        title: lesson.title || `第 ${lesson.teachingWeek || '-'} 周`,
        teachingWeek: Number(lesson.teachingWeek) || 0,
        date: lesson.date || '',
      })),
    },
    summary: {
      studentCount: students.length,
      lessonCount: lessons.length,
      publishedExerciseCount: exercises.length,
      attendancePresent,
      attendanceExpected,
      attendanceRate: percentage(attendancePresent, attendanceExpected),
      answeredCount,
      assignmentCount,
      completionRate: percentage(answeredCount, assignmentCount),
      correctCount,
      accuracyRate: percentage(correctCount, answeredCount),
    },
    trends,
    knowledgePoints,
    students: studentRows,
    latestReport,
  };
}

module.exports = { buildLearningAnalytics, reportScopeKey };
