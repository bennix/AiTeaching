function normalizeCatalogName(value) {
  return String(value || '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN')
    .replace(/\s+/gu, '')
    .replace(/[‐‑‒–—﹣－]/gu, '-')
    .replace(/\({2,}/gu, '(')
    .replace(/\){2,}/gu, ')');
}

function sameCatalogName(left, right) {
  return normalizeCatalogName(left) === normalizeCatalogName(right);
}

function catalogPairKey(courseName, className) {
  return `${normalizeCatalogName(courseName)}\u0000${normalizeCatalogName(className)}`;
}

module.exports = { catalogPairKey, normalizeCatalogName, sameCatalogName };
