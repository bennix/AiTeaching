document.getElementById('year').textContent = new Date().getFullYear();

fetch('https://api.github.com/repos/bennix/AiTeaching/releases/latest', {
  headers: { Accept: 'application/vnd.github+json' }
})
  .then((response) => response.ok ? response.json() : Promise.reject(new Error('release unavailable')))
  .then((release) => {
    if (!release.tag_name) return;
    document.querySelectorAll('[data-latest-version]').forEach((node) => {
      node.textContent = release.tag_name;
    });
  })
  .catch(() => {});
