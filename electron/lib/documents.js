const crypto = require('node:crypto');
const path = require('node:path');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.pdf', '.docx']);

function normalizeText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

async function extractDocumentText(filename, buffer) {
  const extension = path.extname(String(filename || '')).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    throw new Error('仅支持 PDF、Word（.docx）和 Markdown（.md / .markdown）教案');
  }

  if (extension === '.md' || extension === '.markdown') {
    return normalizeText(buffer.toString('utf8'));
  }
  if (extension === '.docx') {
    const result = await mammoth.extractRawText({ buffer });
    return normalizeText(result.value);
  }
  const result = await pdfParse(buffer);
  return normalizeText(result.text);
}

function addWeeks(dateString, offset) {
  const base = new Date(`${dateString}T12:00:00`);
  if (Number.isNaN(base.getTime())) return dateString;
  base.setDate(base.getDate() + offset * 7);
  return base.toISOString().slice(0, 10);
}

function splitByWeekHeadings(text, totalWeeks) {
  const lines = normalizeText(text).split('\n');
  const headingPattern = /^\s*(?:#{1,6}\s*)?(?:第\s*)?(\d{1,2})\s*(?:个?\s*教学周|周)(?:\s*[:：.、\-]?\s*(.*))?\s*$/;
  const sections = new Map();
  let currentWeek = null;
  let currentTitle = '';

  for (const line of lines) {
    const match = line.match(headingPattern);
    const week = match ? Number(match[1]) : 0;
    if (match && week >= 1 && week <= totalWeeks) {
      currentWeek = week;
      currentTitle = String(match[2] || '').trim();
      if (!sections.has(week)) sections.set(week, { title: currentTitle, lines: [] });
      continue;
    }
    if (currentWeek !== null) sections.get(currentWeek).lines.push(line);
  }

  if (sections.size < Math.min(2, totalWeeks)) return null;
  return Array.from({ length: totalWeeks }, (_, index) => {
    const section = sections.get(index + 1);
    return {
      week: index + 1,
      title: section?.title || '',
      text: normalizeText(section?.lines.join('\n') || ''),
    };
  });
}

function splitEvenly(text, totalWeeks) {
  let blocks = normalizeText(text).split(/\n\s*\n/).map((item) => item.trim()).filter(Boolean);
  if (blocks.length < totalWeeks) {
    blocks = normalizeText(text).split(/(?<=[。！？.!?])\s+|\n+/).map((item) => item.trim()).filter(Boolean);
  }
  const totalLength = blocks.reduce((sum, item) => sum + item.length, 0);
  const target = Math.max(1, Math.ceil(totalLength / totalWeeks));
  const groups = Array.from({ length: totalWeeks }, () => []);
  let groupIndex = 0;
  let groupLength = 0;

  for (const [blockIndex, block] of blocks.entries()) {
    const remainingBlocks = blocks.length - blockIndex;
    const remainingGroups = totalWeeks - groupIndex;
    if (groupIndex < totalWeeks - 1 && groupLength >= target && remainingBlocks >= remainingGroups) {
      groupIndex += 1;
      groupLength = 0;
    }
    groups[groupIndex].push(block);
    groupLength += block.length;
  }
  return groups.map((items, index) => ({ week: index + 1, title: '', text: items.join('\n\n') }));
}

function buildLessonRecords({
  text,
  filename,
  scope,
  courseName,
  className,
  startDate,
  weekNumber,
  totalWeeks,
}) {
  const cleanText = normalizeText(text);
  if (!cleanText) throw new Error('没有从教案中提取到可用文字，请检查文件是否为扫描版 PDF');
  const now = new Date().toISOString();
  const batchId = crypto.randomUUID();
  const common = {
    batchId,
    courseName: String(courseName || '').trim(),
    className: String(className || '').trim(),
    sourceFilename: filename,
    sourceScope: scope,
    createdAt: now,
    updatedAt: now,
    aiResult: '',
    error: '',
    status: 'ready',
  };

  if (scope === 'week') {
    const teachingWeek = Math.max(1, Number(weekNumber) || 1);
    return [{
      ...common,
      id: crypto.randomUUID(),
      teachingWeek,
      totalWeeks: Math.max(teachingWeek, Number(totalWeeks) || teachingWeek),
      date: startDate,
      title: `${common.courseName || path.basename(filename, path.extname(filename))} · 第 ${teachingWeek} 周`,
      rawText: cleanText,
    }];
  }

  const count = Math.min(40, Math.max(1, Number(totalWeeks) || 16));
  const sections = splitByWeekHeadings(cleanText, count) || splitEvenly(cleanText, count);
  return sections.map((section) => ({
    ...common,
    id: crypto.randomUUID(),
    teachingWeek: section.week,
    totalWeeks: count,
    date: addWeeks(startDate, section.week - 1),
    title: section.title || `${common.courseName || path.basename(filename, path.extname(filename))} · 第 ${section.week} 周`,
    rawText: section.text || `本周内容需结合整学期教案进一步安排。\n\n整学期教案摘要：\n${cleanText.slice(0, 4000)}`,
  }));
}

module.exports = {
  SUPPORTED_EXTENSIONS,
  addWeeks,
  buildLessonRecords,
  extractDocumentText,
  normalizeText,
  splitByWeekHeadings,
  splitEvenly,
};
