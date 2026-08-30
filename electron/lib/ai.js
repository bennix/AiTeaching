function endpoint(baseUrl, suffix) {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (suffix === '/chat/completions' && /\/chat\/completions$/i.test(clean)) return clean;
  if (suffix === '/models' && /\/chat\/completions$/i.test(clean)) {
    return clean.replace(/\/chat\/completions$/i, '/models');
  }
  return `${clean}${suffix}`;
}

function aiContentText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(aiContentText).join('');
  if (value && typeof value === 'object') return aiContentText(value.text ?? value.content ?? value.output_text ?? '');
  return String(value ?? '');
}

function friendlyAiRequestError(error) {
  if (error?.name === 'AbortError') return new Error('AI 服务请求超时，请稍后重试或检查 BaseURL 与网络连接');
  if (/^HTTP \d+:/i.test(String(error?.message || ''))) return error;
  if (error instanceof TypeError || /fetch failed|network|socket|ECONN/i.test(String(error?.message || ''))) {
    const code = error?.cause?.code ? `（${error.cause.code}）` : '';
    return new Error(`无法连接 AI 服务${code}，请检查 BaseURL、网络连接或服务状态`);
  }
  return error instanceof Error ? error : new Error('AI 服务请求失败，请稍后重试');
}

async function requestJson(url, options, timeoutMs = 120000) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const raw = await response.text();
      let payload;
      try { payload = JSON.parse(raw); } catch { payload = null; }
      if (!response.ok) {
        const detail = payload?.error?.message || payload?.message || raw.slice(0, 300) || response.statusText;
        const requestError = new Error(`HTTP ${response.status}: ${detail}`);
        requestError.retryable = response.status === 429 || response.status >= 500;
        throw requestError;
      }
      return payload;
    } catch (error) {
      lastError = friendlyAiRequestError(error);
      const retryable = error?.retryable || (error instanceof TypeError && error?.name !== 'AbortError');
      if (!retryable || attempt === 2) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('AI 服务请求失败，请稍后重试');
}

function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

function assistantText(payload, streaming = false) {
  const content = aiContentText(streaming ? payload?.choices?.[0]?.delta?.content : payload?.choices?.[0]?.message?.content);
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
  } catch (error) {
    throw friendlyAiRequestError(error);
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
  return aiContentText(payload?.choices?.[0]?.message?.content) || '连接成功';
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
  return text.replace(/^```(?:json|markdown|md)?\s*/i, '').replace(/\s*```$/, '').trim();
}

function repairJsonStringSyntax(source) {
  let result = '';
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (!inString) {
      result += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }
    if (character === '\\') {
      result += character;
      escaped = true;
      continue;
    }
    if (character === '\n') { result += '\\n'; continue; }
    if (character === '\r') { result += '\\r'; continue; }
    if (character === '\t') { result += '\\t'; continue; }
    if (character !== '"') {
      result += character;
      continue;
    }
    let next = index + 1;
    while (next < source.length && /\s/.test(source[next])) next += 1;
    const nextCharacter = source[next];
    const closesJsonString = next >= source.length || [':', ',', '}', ']'].includes(nextCharacter);
    if (closesJsonString) {
      result += character;
      inString = false;
    } else {
      result += '\\"';
    }
  }
  return result;
}

function parseJsonLoose(value, fallback) {
  const text = cleanAiText(aiContentText(value));
  const first = Math.min(...['{', '['].map((char) => { const index = text.indexOf(char); return index < 0 ? Infinity : index; }));
  const last = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  const candidate = Number.isFinite(first) && last >= first ? text.slice(first, last + 1) : text;
  const withoutTrailingCommas = candidate.replace(/,\s*([}\]])/g, '$1');
  for (const source of [candidate, withoutTrailingCommas, repairJsonStringSyntax(candidate), repairJsonStringSyntax(withoutTrailingCommas)]) {
    try {
      const parsed = JSON.parse(source);
      if (Array.isArray(parsed)) return parsed;
      if (parsed && typeof parsed === 'object') {
        for (const key of ['exercises', 'questions', 'items', 'data', '题目', '练习题']) {
          if (Array.isArray(parsed[key])) return parsed[key];
        }
      }
      return parsed;
    } catch { /* Try the next conservative repair before using the fallback. */ }
  }
  return fallback;
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
  return cleanAiText(aiContentText(payload?.choices?.[0]?.message?.content));
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

function normalizeGeneratedExerciseType(value) {
  const text = String(value || '').trim().toLowerCase();
  if (['choice', 'single_choice', 'multiple_choice', '选择题', '单选题', '多选题'].includes(text) || /选择|choice/.test(text)) return 'choice';
  if (['short_answer', 'short-answer', 'shortanswer', '简答题', '问答题'].includes(text) || /简答|问答|short.?answer/.test(text)) return 'short_answer';
  if (['application', 'practice', 'case_study', 'coding', '应用题', '实践题', '案例题', '计算题', '编程题'].includes(text) || /应用|实践|案例|计算|application|practice/.test(text)) return 'application';
  return text;
}

function normalizedExerciseRecord(item, fallbackType) {
  if (!item || typeof item !== 'object') return null;
  const type = normalizeGeneratedExerciseType(item.type ?? item.questionType ?? item.题型 ?? item.类型 ?? fallbackType);
  let question = String(item.question ?? item.prompt ?? item.题目 ?? item.问题 ?? '').trim();
  const choices = item.options ?? item.choices ?? item.选项;
  if (choices && !/\n\s*[A-D][.、:：)]/i.test(question)) {
    const rows = Array.isArray(choices)
      ? choices.map((value, index) => `${String.fromCharCode(65 + index)}. ${typeof value === 'object' ? (value.text ?? value.content ?? value.value ?? '') : value}`)
      : Object.entries(choices).map(([key, value]) => `${key}. ${typeof value === 'object' ? (value.text ?? value.content ?? value.value ?? '') : value}`);
    if (rows.length) question = `${question}\n${rows.join('\n')}`;
  }
  const answer = String(item.answer ?? item.correctAnswer ?? item.correct_answer ?? item.参考答案 ?? item.答案 ?? '').trim();
  return {
    ...item,
    type,
    question,
    answer,
    explanation: String(item.explanation ?? item.analysis ?? item.解析 ?? item.说明 ?? ''),
    difficulty: String(item.difficulty ?? item.难度 ?? ''),
    knowledgePoint: String(item.knowledgePoint ?? item.knowledge_point ?? item.知识点 ?? ''),
  };
}

function parseGeneratedExercises(content, options) {
  const parsed = parseJsonLoose(content, []);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((item) => normalizedExerciseRecord(item, options.types.length === 1 ? options.types[0] : ''))
    .filter((item) => item && options.types.includes(item.type) && item.question && item.answer).map((item) => ({
      ...item,
      type: item.type,
      difficulty: options.difficulty === 'mixed' && EXERCISE_DIFFICULTIES.includes(item.difficulty) ? item.difficulty : (options.difficulty === 'mixed' ? 'medium' : options.difficulty),
      question: String(item.question),
      answer: String(item.answer),
      explanation: String(item.explanation || ''),
      knowledgePoint: String(item.knowledgePoint || ''),
    })).slice(0, options.count);
}

async function generateExercises(settings, lesson, { targetStudentId = null, weakPoints = '', types, count, difficulty, excludeQuestions = [] } = {}) {
  const options = normalizeExerciseOptions({ types, count, difficulty });
  const typeLabel = { choice: '选择题', short_answer: '简答题', application: '实践/应用题' };
  const difficultyLabel = { easy: '简单', medium: '中等', hard: '困难', mixed: '由易到难的混合难度' };
  const prompt = `请根据以下教学周内容生成恰好 ${options.count} 道练习题。只返回一个严格有效的 JSON 对象，不要代码围栏，对象格式为 {"exercises":[...]}。JSON 字符串内容中不要使用未转义的英文双引号，需要引用术语时请使用中文引号“”。
允许的题型仅限：${options.types.map((item) => `${item}（${typeLabel[item]}）`).join('、')}。
难度要求：${difficultyLabel[options.difficulty]}。${options.difficulty === 'mixed' ? '请合理分配 easy、medium、hard。' : `每道题的 difficulty 必须是 ${options.difficulty}。`}
题目必须忠实适配课程学科。除非课程名称或教学内容明确属于编程、软件开发或计算机调试，否则禁止出现代码、Debug、调试程序等编程场景；application 表示适合当前学科的实践题、计算题、案例题、实验题或综合应用题。
exercises 数组中的每一项格式：{
  "type":"choice|short_answer|application",
  "question":"题目；选择题须包含 A-D 四个选项",
  "answer":"参考答案；选择题以正确选项字母开头",
  "explanation":"说明为什么答案正确，并给出关键解题思路",
  "difficulty":"easy|medium|hard",
  "knowledgePoint":"知识点"
}
${excludeQuestions.length ? `不得重复以下已生成题目：\n${excludeQuestions.map((item) => `- ${item}`).join('\n').slice(0, 6000)}` : ''}
${targetStudentId ? `这是给学生 ${targetStudentId} 的个性化练习，重点补强：${weakPoints || '近期薄弱知识点'}。` : ''}
课程：${lesson.courseName || ''}，第 ${lesson.teachingWeek} 周
教学内容：
${String(lesson.aiResult || lesson.rawText || '').slice(0, 12000)}`;
  const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), {
    method: 'POST', headers: authHeaders(settings.apiKey),
    body: JSON.stringify({ model: settings.gradingModel || settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 4096 }),
  });
  return parseGeneratedExercises(payload?.choices?.[0]?.message?.content, options);
}

async function generateExercisesForBlueprint(settings, lesson, blueprint, { onProgress } = {}) {
  const configs = normalizeExerciseBlueprint(blueprint);
  const batches = [];
  for (const item of configs) {
    const collected = [];
    const seen = new Set();
    onProgress?.([], { type: item.type, expected: item.count, actual: 0, phase: 'generating' });
    for (let attempt = 0; attempt < 3 && collected.length < item.count; attempt += 1) {
      let generated;
      try {
        generated = await generateExercises(settings, lesson, {
          types: [item.type], count: item.count - collected.length, difficulty: item.difficulty,
          excludeQuestions: collected.map((exercise) => exercise.question),
        });
      } catch (error) {
        error.partialExercises = [...batches.flat(), ...collected, ...(Array.isArray(error.partialExercises) ? error.partialExercises : [])];
        throw error;
      }
      const fresh = [];
      for (const exercise of generated) {
        const key = exercise.question.trim();
        if (key && !seen.has(key)) { seen.add(key); collected.push(exercise); fresh.push(exercise); }
      }
      onProgress?.(fresh, { type: item.type, expected: item.count, actual: collected.length, phase: 'generating' });
    }
    batches.push(collected.slice(0, item.count));
    onProgress?.([], { type: item.type, expected: item.count, actual: batches.at(-1).length, phase: 'complete' });
  }
  const shortages = configs.map((item, index) => ({ type: item.type, expected: item.count, actual: batches[index].length }))
    .filter((item) => item.actual < item.expected);
  if (shortages.length) {
    const labels = { choice: '选择题', short_answer: '简答题', application: '实践 / 应用题' };
    const error = new Error(`部分题型自动补生成后仍数量不足：${shortages.map((item) => `${labels[item.type] || item.type}需要 ${item.expected}，实际 ${item.actual}`).join('；')}`);
    error.kind = 'shortage';
    error.partialExercises = batches.flat();
    throw error;
  }
  return batches.flat();
}

async function gradeAnswer(settings, exercise, answer) {
  const normalizeChoice = (value) => String(value || '').trim().toUpperCase().match(/[A-D]/)?.[0] || '';
  const isChoice = exercise.type === 'choice';
  const deterministicCorrect = isChoice ? normalizeChoice(answer) === normalizeChoice(exercise.answer) : null;
  const fallback = () => {
    const correctAnswer = String(exercise.answer || '').trim();
    const correct = Boolean(deterministicCorrect);
    const reason = correct
      ? '你的选择与参考答案一致，说明你识别出了题目的关键条件。'
      : `你的选择是 ${normalizeChoice(answer) || '未识别'}，而参考答案是 ${normalizeChoice(exercise.answer) || correctAnswer}，两者不一致。`;
    const correctApproach = String(exercise.explanation || '').trim() || `回到题干逐项核对条件，正确答案为 ${correctAnswer}。`;
    return { correct, reason, correctApproach, feedback: `**判定理由：** ${reason}\n\n**正确思路：** ${correctApproach}` };
  };

  if (!settings.apiKey) {
    if (isChoice) return fallback();
    throw new Error('AI 判题需要教师先配置 API Key');
  }

  const lockedConclusion = isChoice ? `本题是选择题。程序已可靠比对选项，correct 必须为 ${deterministicCorrect ? 'true' : 'false'}，不得改变此结论。` : '';
  const prompt = `你是一名严谨、友善的教师。请批改学生答案，只返回 JSON，不要代码围栏：
{"correct":true或false,"reason":"为什么正确或错误，必须结合题目和学生答案","correctApproach":"正确答案或关键解题步骤","suggestion":"一句具体改进建议"}
${lockedConclusion}
题目：${exercise.question}
参考答案：${exercise.answer}
参考解析：${exercise.explanation || '未单独提供，请根据题目与参考答案解释'}
学生答案：${answer}`;
  try {
    const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), {
      method: 'POST', headers: authHeaders(settings.apiKey),
      body: JSON.stringify({ model: settings.gradingModel || settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 900 }),
    });
    const result = parseJsonLoose(aiContentText(payload?.choices?.[0]?.message?.content), {});
    if (!isChoice && typeof result.correct !== 'boolean') throw new Error('AI 判题返回格式无效');
    const correct = isChoice ? deterministicCorrect : result.correct;
    const reason = String(result.reason || result.feedback || '').trim();
    const correctApproach = String(result.correctApproach || exercise.explanation || exercise.answer || '').trim();
    const suggestion = String(result.suggestion || '').trim();
    if (!reason || !correctApproach) {
      if (isChoice) return fallback();
      throw new Error('AI 判题没有返回完整理由');
    }
    const feedback = [`**判定理由：** ${reason}`, `**正确思路：** ${correctApproach}`, suggestion ? `**改进建议：** ${suggestion}` : ''].filter(Boolean).join('\n\n');
    return { correct, reason, correctApproach, suggestion, feedback };
  } catch (error) {
    if (isChoice) return fallback();
    throw error;
  }
}

async function generateStudentReport(settings, student, records) {
  const prompt = `请根据学生的学习记录生成 Markdown 学习诊断报告，包含：学习概况、薄弱点、具体指导、练习顺序、下一周行动建议。语气温和具体。\n学生：${student.name}（${student.studentId}）\n课程：${student.courseName || ''}\n作答记录：\n${JSON.stringify(records).slice(0, 14000)}`;
  const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), {
    method: 'POST', headers: authHeaders(settings.apiKey),
    body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 3000 }),
  });
  return cleanAiText(aiContentText(payload?.choices?.[0]?.message?.content));
}

async function generateClassLearningReport(settings, analytics) {
  const evidence = {
    filters: analytics.filters,
    summary: analytics.summary,
    trends: analytics.trends,
    knowledgePoints: analytics.knowledgePoints,
    students: analytics.students.map((student) => ({
      studentId: student.studentId,
      name: student.name,
      attendanceRate: student.attendanceRate,
      completionRate: student.completionRate,
      accuracyRate: student.accuracyRate,
      answeredCount: student.answeredCount,
      weakPoints: student.weakPoints,
    })),
  };
  const prompt = `你是一名严谨的教学数据分析助手。请根据下面的真实统计数据生成中文 Markdown 学情分析报告。

要求：
1. 必须包含：核心结论、签到与参与、作答与正确率、薄弱知识点、重点关注学生、教学调整建议、下一阶段行动清单。
2. 每个结论都要说明数据依据和样本量；区分事实、合理推断和数据不足。
3. 未作答只影响完成率，不得当作答错；知识点掌握度只按实际作答统计。
4. 不得虚构学生、题目、知识点或百分比。没有数据时明确写“数据不足”。
5. 建议要具体、可执行、适合教师直接使用，避免空泛措辞。

统计数据：
${JSON.stringify(evidence).slice(0, 28000)}`;
  const payload = await requestJson(endpoint(settings.baseUrl, '/chat/completions'), {
    method: 'POST', headers: authHeaders(settings.apiKey),
    body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: prompt }], max_tokens: 3600 }),
  });
  return cleanAiText(aiContentText(payload?.choices?.[0]?.message?.content));
}

module.exports = {
  endpoint,
  fetchModels,
  generateExercises,
  generateExercisesForBlueprint,
  generateClassLearningReport,
  generateStudentReport,
  generateWeeklyPlan,
  gradeAnswer,
  normalizeExerciseBlueprint,
  normalizeExerciseOptions,
  parseJsonLoose,
  parseGeneratedExercises,
  testConnection,
};
