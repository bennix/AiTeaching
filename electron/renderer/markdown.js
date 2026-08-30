(() => {
  const sanitize = (html) => DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form'],
    FORBID_ATTR: ['style', 'srcdoc'],
  });

  marked.use({ gfm: true, breaks: true });

  function html(source, { inline = false } = {}) {
    const value = String(source ?? '');
    const rendered = inline ? marked.parseInline(value) : marked.parse(value);
    return sanitize(rendered);
  }

  function normalizeBareMathText(value) {
    const source = String(value ?? '');
    if (/\$|\\\(|\\\[/.test(source)) return source;
    return source.replace(/(^|[^A-Za-z0-9_\\$])([A-Za-z](?:(?:_(?:\{[^{}\n]+\}|[A-Za-z0-9]))|(?:\^(?:\{[^{}\n]+\}|[A-Za-z0-9])))+)(?=$|[^A-Za-z0-9_$])/g, '$1\\($2\\)');
  }

  function wrapBareMath(root) {
    if (!root || typeof document === 'undefined' || typeof NodeFilter === 'undefined') return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      if (node.parentElement?.closest('script,noscript,style,textarea,pre,code,.katex')) continue;
      const normalized = normalizeBareMathText(node.textContent);
      if (normalized !== node.textContent) node.textContent = normalized;
    }
  }

  function typeset(root) {
    if (!root || typeof renderMathInElement !== 'function') return;
    wrapBareMath(root);
    renderMathInElement(root, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '\\(', right: '\\)', display: false },
        { left: '$', right: '$', display: false },
      ],
      ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'],
      throwOnError: false,
      strict: 'warn',
    });
  }

  function render(element, source, fallback = '') {
    if (!element) return;
    element.classList.add('markdown-body');
    element.innerHTML = html(String(source ?? '').trim() || fallback);
    element.querySelectorAll('a[href]').forEach((link) => {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    });
    typeset(element);
  }

  window.RichText = { html, normalizeBareMathText, render, typeset };
})();
