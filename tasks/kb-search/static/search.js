const mode = document.body.dataset.mode;
if (mode === 'DOM') {
  const input = document.getElementById('query');
  document.getElementById('search-form').addEventListener('submit', event => {
    event.preventDefault();
    location.assign('/search#' + new URLSearchParams({q:input.value}));
  });
  if (document.body.dataset.search === 'true') {
    const render = async () => {
      const query = (new URLSearchParams(location.hash.slice(1)).get('q') || '').slice(0, 1000);
      input.value = query;
      document.getElementById('query-label').textContent = 'Запрос: ' + query;
      const result = document.getElementById('results');
      try {
        const response = await fetch('/catalog.json', {credentials:'omit'});
        if (!response.ok) throw new Error('catalog');
        const catalog = await response.json();
        const q = query.trim().toLocaleLowerCase('ru');
        const matches = catalog.filter(a => !q || `${a.title} ${a.body}`.toLocaleLowerCase('ru').includes(q));
        const grid = document.createElement('div'); grid.className = 'grid';
        for (const item of matches) {
          const article = document.createElement('article'); article.className = 'card';
          const title = document.createElement('h2'); title.textContent = item.title;
          const body = document.createElement('p'); body.textContent = item.body;
          article.append(title, body); grid.append(article);
        }
        if (matches.length) result.replaceChildren(grid);
        else { const empty = document.createElement('p'); empty.textContent = 'Ничего не найдено.'; result.replaceChildren(empty); }
      } catch { result.textContent = 'Каталог временно недоступен. Обновите страницу.'; }
    };
    window.addEventListener('hashchange', render);
    render();
  }
}
