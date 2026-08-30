const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExerciseOptions } = require('../lib/ai');

test('normalizes teacher exercise generation options', () => {
  assert.deepEqual(normalizeExerciseOptions({
    types: ['choice', 'choice', 'coding', 'invalid'],
    count: 12,
    difficulty: 'hard',
  }), {
    types: ['choice', 'coding'],
    count: 12,
    difficulty: 'hard',
  });
});

test('bounds exercise count and restores safe defaults', () => {
  assert.deepEqual(normalizeExerciseOptions({ types: [], count: 100, difficulty: 'expert' }), {
    types: ['choice', 'short_answer', 'coding'],
    count: 30,
    difficulty: 'mixed',
  });
});
