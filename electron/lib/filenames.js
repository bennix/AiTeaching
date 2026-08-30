function repairUtf8Mojibake(value) {
  const original = String(value || '');
  if (!original || [...original].some((char) => char.codePointAt(0) > 255)) return original;
  const decoded = Buffer.from(original, 'latin1').toString('utf8');
  if (!decoded || decoded.includes('\uFFFD') || decoded === original) return original;
  const cjkCount = (text) => (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
  const suspiciousLatin1 = /[ÃÂâæåäçèé]/.test(original);
  return cjkCount(decoded) > cjkCount(original) || (suspiciousLatin1 && decoded.length < original.length)
    ? decoded
    : original;
}

function normalizeUploadFilename(value) {
  const repaired = repairUtf8Mojibake(value).normalize('NFC');
  const basename = repaired.split(/[\\/]/).at(-1).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return basename || '未命名文件';
}

module.exports = { normalizeUploadFilename, repairUtf8Mojibake };
