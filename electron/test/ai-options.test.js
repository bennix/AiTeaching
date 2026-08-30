const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeExerciseBlueprint, normalizeExerciseOptions } = require('../lib/ai');

test('normalizes teacher exercise generation options', () => {
  assert.deepEqual(normalizeExerciseOptions({
    types: ['choice', 'choice', 'application', 'invalid'],
    count: 12,
    difficulty: 'hard',
  }), {
    types: ['choice', 'application'],
    count: 12,
    difficulty: 'hard',
  });
});

test('bounds exercise count and restores safe defaults', () => {
  assert.deepEqual(normalizeExerciseOptions({ types: [], count: 100, difficulty: 'expert' }), {
    types: ['choice', 'short_answer', 'application'],
    count: 30,
    difficulty: 'mixed',
  });
});

test('normalizes per-type counts and difficulty while capping a chapter at 30 questions', () => {
  assert.deepEqual(normalizeExerciseBlueprint({ typeConfigs: [
    { type: 'choice', count: 20, difficulty: 'easy' },
    { type: 'short_answer', count: 20, difficulty: 'hard' },
    { type: 'application', count: 5, difficulty: 'mixed' },
  ] }), [
    { type: 'choice', count: 20, difficulty: 'easy' },
    { type: 'short_answer', count: 10, difficulty: 'hard' },
  ]);
});

test('migrates the legacy coding type to the subject-neutral application type', () => {
  assert.deepEqual(normalizeExerciseBlueprint({ typeConfigs: [{ type: 'coding', count: 3, difficulty: 'hard' }] }), [
    { type: 'application', count: 3, difficulty: 'hard' },
  ]);
});
