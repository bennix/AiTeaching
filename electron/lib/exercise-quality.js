const CHOICE_LABELS = ['A', 'B', 'C', 'D'];

function normalizeComparableText(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/gu, '');
}

function parseChoiceOptions(question) {
  return String(question || '').split(/\r?\n/).map((line) => {
    const normalized = line.normalize('NFKC').trim();
    const match = /^(?:[-*]\s+)?(?:\*\*)?([A-D])(?:\*\*)?\s*[.、:：)）]\s*(?:\*\*)?(.+?)(?:\*\*)?$/.exec(normalized);
    return match ? { label: match[1], text: match[2].trim() } : null;
  }).filter(Boolean);
}

function repairRepeatedChoiceOptions(question) {
  const source = String(question || '');
  const lines = source.split(/\r?\n/);
  const optionRows = lines.map((line, lineIndex) => {
    const option = parseChoiceOptions(line)[0];
    return option ? { ...option, lineIndex } : null;
  }).filter(Boolean);
  if (optionRows.length !== 8) return source;
  const first = optionRows.slice(0, 4);
  const repeated = optionRows.slice(4);
  const labelsAreRepeated = first.map((item) => item.label).join('') === 'ABCD'
    && repeated.map((item) => item.label).join('') === 'ABCD';
  const contentsAreRepeated = first.every((item, index) => normalizeComparableText(item.text) === normalizeComparableText(repeated[index].text));
  if (!labelsAreRepeated || !contentsAreRepeated) return source;
  const duplicateLineIndexes = new Set(repeated.map((item) => item.lineIndex));
  return lines.filter((_line, index) => !duplicateLineIndexes.has(index)).join('\n').trim();
}

function choiceQuestionQuality(exercise) {
  if (exercise?.type !== 'choice') return { valid: true, reasons: [], options: [] };
  const options = parseChoiceOptions(exercise.question);
  const reasons = [];
  const labels = options.map((item) => item.label);
  if (options.length !== 4 || labels.join('') !== CHOICE_LABELS.join('')) {
    reasons.push('选择题必须且只能包含按 A、B、C、D 排列的四个选项');
  }
  const optionKeys = options.map((item) => normalizeComparableText(item.text));
  if (optionKeys.some((item) => !item) || new Set(optionKeys).size !== optionKeys.length) {
    reasons.push('选择题选项内容不能为空或重复');
  }
  const answer = String(exercise.answer || '').trim().normalize('NFKC').toUpperCase().match(/^[A-D](?=$|[.、:：)）。，,\s])/u)?.[0]
    || (CHOICE_LABELS.includes(String(exercise.answer || '').trim().normalize('NFKC').toUpperCase()) ? String(exercise.answer).trim().normalize('NFKC').toUpperCase() : '');
  if (!answer) reasons.push('选择题参考答案必须以 A、B、C 或 D 开头');
  return { valid: reasons.length === 0, reasons, options };
}

function exerciseQuestionKey(question) {
  const stem = String(question || '').split(/\r?\n/)
    .filter((line) => !parseChoiceOptions(line).length)
    .join(' ')
    .replace(/^\s*(?:第?\s*\d+\s*[题.、:：)]|[（(]\s*\d+\s*[）)])\s*/u, '');
  return normalizeComparableText(stem);
}

function isGeneratedExerciseValid(exercise) {
  return Boolean(exercise?.question && exercise?.answer && choiceQuestionQuality(exercise).valid);
}

module.exports = {
  choiceQuestionQuality,
  exerciseQuestionKey,
  isGeneratedExerciseValid,
  normalizeComparableText,
  parseChoiceOptions,
  repairRepeatedChoiceOptions,
};
