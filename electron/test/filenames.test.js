const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeUploadFilename } = require('../lib/filenames');

test('repairs UTF-8 Chinese filenames decoded as Latin-1', () => {
  const expected = '高二数学_全学期教案.pdf';
  const mojibake = Buffer.from(expected, 'utf8').toString('latin1');
  assert.equal(normalizeUploadFilename(mojibake), expected);
});

test('keeps valid Unicode names and removes uploaded path components', () => {
  assert.equal(normalizeUploadFilename('高二数学教案.pdf'), '高二数学教案.pdf');
  assert.equal(normalizeUploadFilename('C:\\fakepath\\中文教案.docx'), '中文教案.docx');
});
