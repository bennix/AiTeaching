function endpoint(baseUrl, suffix) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (suffix === '/chat/completions' && /\/chat\/completions$/i.test(clean)) return clean;
  if (suffix === '/models' && /\/chat\/completions$/i.test(clean)) {
    return clean.replace(/\/chat\/completions$/i, '/models');
  }
  return `${clean}${suffix}`;
}

async function requestJson(url, options, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || raw.slice(0, 300) || response.statusText;
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

function assistantText(payload, streaming = false) {
  const content = streaming ? payload?.choices?.[0]?.delta?.content : payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((item) => typeof item === 'string' ? item : item?.text || '').join('');
  return '';
}

async function requestChatStream(url, options, onDelta, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) {
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      const detail = payload?.error?.message || payload?.message || raw.slice(0, 300) || response.statusText;
      throw new Error(`HTTP ${response.status}: ${detail}`);
    }

    if (/application\/json/i.test(response.headers.get('content-type') || '')) {
      const payload = await response.json();
      const text = assistantText(payload);
      if (text) onDelta?.(text);
      return cleanAiText(text);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new Error('AI 服务没有返回可读取的流');
    const decoder = new TextDecoder();
    let buffer = '';
    let result = '';
    let finished = false;
    const consumeLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') { if (data === '[DONE]') finished = true; return; }
      try {
        const delta = assistantText(JSON.parse(data), true);
        if (delta) { result += delta; onDelta?.(result); }
      } catch { /* Ignore incomplete or provider-specific SSE metadata. */ }
    };

    while (!finished) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
      if (done) break;
    }
    if (buffer) consumeLine(buffer);
    return cleanAiText(result);
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection(settings) {
  const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), {
    method: 'POST',
    headers: authHeaders(settings.apiKey),
    body: JSON.stringify({
      model: settings.model,
      messages: [{ role: 'user', content: '只回复 OK' }],
      max_tokens: 8,
    }),
  }, 20000);
  return payload?.choices?.[0]?.message?.content || '连接成功';
}

async function fetchModels(settings) {
  const payload = await requestJson(endpoint(settings.baseUrl, '/models'), {
    method: 'GET',
    headers: authHeaders(settings.apiKey),
  }, 20000);
  const items = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  return items.map((item) => typeof item === 'string' ? item : item?.id).filter(Boolean).sort();
}

function cleanAiText(value) {
  const text = String(value || '').trim();
  return text.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function parseJsonLoose(value, fallback) {
  const text = cleanAiText(value);
  const first = Math.min(...['{', '['].map((char) => { const index = text.indexOf(char); return index < 0 ? Infinity : index; }));
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  try { return JSON.parse(Number.isFinite(first) && last >= first ? text.slice(first, last + 1) : text); }
  catch { return fallback; }
}

async function generateWeeklyPlan(settings, lesson, { semesterContext = '', previousPlans = '', onDelta } = {}) {
  const prompt = `你是一名教学设计助手。请依据导入的教案，为第 ${lesson.teachingWeek}/${lesson.totalWeeks} 教学周整理一份可直接使用的教学周方案。

课程：${lesson.courseName || '未填写'}
班级：${lesson.className || '未填写'}
日期：${lesson.date || '未填写'}

请使用 Markdown，严格包含：
1. 本周主题
2. 学习目标（知识、能力、素养）
3. 重点与难点
4. 教学流程（含建议时长）
5. 课堂活动与提问
6. 作业与评价
7. 教学资源准备

不要编造教案中没有依据的事实；如果原文不足，请明确标注“建议教师补充”。

整学期教学整体内容（用于把握进度、避免割裂）：
${String(semesterContext || lesson.semesterContext || '未提供整学期纲要').slice(0, 16000)}

此前教学周已完成内容（当前周必须承接，不得无故重复）：
${String(previousPlans || '这是第一教学周，暂无前序内容。').slice(0, 14000)}

教案原文：
${String(lesson.rawText || '').slice(0, 16000)}`;

  const request = {
    method: 'POST',
    headers: authHeaders(settings.apiKey),
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: '你擅长把课程教案整理成清晰、可执行的教学周计划。' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 4096,
      stream: Boolean(onDelta),
    }),
  };
  if (onDelta) return requestChatStream(endpoint(settings.baseUrl, '/chat/completions'), request, onDelta);
  const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), request);
  return cleanAiText(payload?.choices?.[0]?.message?.content);
}

const EXERCISE_TYPES = ['choice', 'short_answer', 'application'];
const EXERCISE_DIFFICULTIES = ['easy', 'medium', 'hard'];
const DEFAULT_EXERCISE_BLUEPRINT = [
  { type: 'choice', count: 4, difficulty: 'medium' },
  { type: 'short_answer', count: 2, difficulty: 'medium' },
  { type: 'application', count: 0, difficulty: 'hard' },
];

function normalizeExerciseOptions({ types, count, difficulty } = {}) {
  const normalizedTypes = [...new Set((Array.isArray(types) ? types : EXERCISE_TYPES).filter((item) => EXERCISE_TYPES.includes(item)))];
  const normalizedCount = Math.min(30, Math.max(1, Number.parseInt(count, 10) || 6));
  return {
    types: normalizedTypes.length ? normalizedTypes : EXERCISE_TYPES,
    count: normalizedCount,
    difficulty: EXERCISE_DIFFICULTIES.includes(difficulty) ? difficulty : 'mixed',
  };
}

function normalizeExerciseBlueprint({ typeConfigs } = {}) {
  if (typeConfigs === undefined) return DEFAULT_EXERCISE_BLUEPRINT.filter((item) => item.count > 0).map((item) => ({ ...item }));
  const byType = new Map((Array.isArray(typeConfigs) ? typeConfigs : []).map((item) => [item?.type === 'coding' ? 'application' : item?.type, item]));
  let remaining = 30;
  return EXERCISE_TYPES.map((type) => {
    const item = byType.get(type) || {};
    const requested = Math.min(30, Math.max(0, Number.parseInt(item.count, 10) || 0));
    const count = Math.min(requested, remaining);
    remaining -= count;
    return {
      type,
      count,
      difficulty: [...EXERCISE_DIFFICULTIES, 'mixed'].includes(item.difficulty) ? item.difficulty : 'mixed',
    };
  }).filter((item) => item.count > 0);
}

async function generateExercises(settings, lesson, { targetStudentId = null, weakPoints = '', types, count, difficulty } = {}) {
  const options = normalizeExerciseOptions({ types, count, difficulty });
  const typeLabel = { choice: '选择题', short_answer: '简答题', application: '实践/应用题' };
  const difficultyLabel = { easy: '简单', medium: '中等', hard: '困难', mixed: '由易到难的混合难度' };
  const prompt = `请根据以下教学周内容生成恰好 ${options.count} 道练习题。只返回 JSON 数组，不要代码围栏。
允许的题型仅限：${options.types.map((item) => `${item}（${typeLabel[item]}）`).join('、')}。
难度要求：${difficultyLabel[options.difficulty]}。${options.difficulty === 'mixed' ? '请合理分配 easy、medium、hard。' : `每道题的 difficulty 必须是 ${options.difficulty}。`}
题目必须忠实适配课程学科。除非课程名称或教学内容明确属于编程、软件开发或计算机调试，否则禁止出现代码、Debug、调试程序等编程场景；application 表示适合当前学科的实践题、计算题、案例题、实验题或综合应用题。
格式：[{
  "type":"choice|short_answer|application",
  "question":"题目；选择题须包含 A-D 四个选项",
  "answer":"参考答案；选择题仅写字母",
  "difficulty":"easy|medium|hard",
  "knowledgePoint":"知识点"
}]
${targetStudentId ? `这是给学生 ${targetStudentId} 的个性化练习，重点补强：${weakPoints || '近期薄弱知识点'}。` : ''}
课程：${lesson.courseName || ''}，第 ${lesson.teachingWeek} 周
教学内容：
${String(lesson.aiResult || lesson.rawText || '').slice(0, 12000)}`;
  const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), {
    method: 'POST', headers: authHeaders(settings.apiKey),
    body: JSON.stringify({ model: settings.gradingModel || settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096 }),
  });
  const parsed = parseJsonLoose(payload?.choices?.[0]?.message?.content, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) => item && options.types.includes(item.type) && item.question && item.answer).map((item) => ({
    ...item,
    type: item.type,
    difficulty: options.difficulty === 'mixed' && EXERCISE_DIFFICULTIES.includes(item.difficulty) ? item.difficulty : (options.difficulty === 'mixed' ? 'medium' : options.difficulty),
    question: String(item.question),
    answer: String(item.answer),
    knowledgePoint: String(item.knowledgePoint || ''),
  })).slice(0, options.count);
}

async function generateExercisesForBlueprint(settings, lesson, blueprint) {
  const configs = normalizeExerciseBlueprint(blueprint);
  const batches = await Promise.all(configs.map((item) => generateExercises(settings, lesson, {
    types: [item.type], count: item.count, difficulty: item.difficulty,
  })));
  for (let index = 0; index < configs.length; index += 1) {
    if (batches[index].length !== configs[index].count) {
      throw new Error(`AI 返回的${configs[index].type}题数量不足（需要 ${configs[index].count}，实际 ${batches[index].length}）`);
    }
  }
  return batches.flat();
}

async function gradeAnswer(settings, exercise, answer) {
  if (exercise.type === 'choice') {
    const normalize = (value) => String(value || '').trim().toUpperCase().match(/[A-D]/)?.[0] || '';
    const correct = normalize(answer) === normalize(exercise.answer);
    return { correct, feedback: correct ? '回答正确。' : `回答不正确，参考答案为 ${exercise.answer}。` };
  }
  const prompt = `请批改学生答案，只返回 JSON：{"correct":true或false,"feedback":"简短、具体、鼓励式反馈"}\n题目：${exercise.question}\n参考答案：${exercise.answer}\n学生答案：${answer}`;
  const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), {
    method: 'POST', headers: authHeaders(settings.apiKey),
    body: JSON.stringify({ model: settings.gradingModel || settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 600 }),
  });
  const result = parseJsonLoose(payload?.choices?.[0]?.message?.content, {});
  return { correct: Boolean(result.correct), feedback: String(result.feedback || '批改完成。') };
}

async function generateStudentReport(settings, student, records) {
  const prompt = `请根据学生的学习记录生成 Markdown 学习诊断报告，包含：学习概况、薄弱点、具体指导、练习顺序、下一周行动建议。语气温和具体。\n学生：${student.name}（${student.studentId}）\n课程：${student.courseName || ''}\n作答记录：\n${JSON.stringify(records).slice(0, 14000)}`;
  const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), {
    method: 'POST', headers: authHeaders(settings.apiKey),
    body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 3000 }),
  });
  return cleanAiText(payload?.choices?.[0]?.message?.content);
}

module.exports = {
  endpoint,
  fetchModels,
  generateExercises,
  generateExercisesForBlueprint,
  generateStudentReport,
  generateWeeklyPlan,
  gradeAnswer,
  normalizeExerciseBlueprint,
  normalizeExerciseOptions,
  testConnection,
};
