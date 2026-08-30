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

  function typeset(root) {
    if (!root || typeof renderMathInElement !== 'function') return;
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

  window.RichText = { html, render, typeset };
})();
