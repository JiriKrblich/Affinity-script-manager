const Ico = window.Icons.createIcon;
const state = {
  nav: 'local',
  localView: 'list',
  communityQuery: '',
  communityFilter: 'all',
  communitySort: 'name',
  installedIds: new Set(),
  sdkModule: null,
};

const NAV_SECTIONS = [
  { label: 'Library',  items: [
    { id: 'local',     name: 'Local Scripts',  icon: 'folder' },
    { id: 'bridge',    name: 'Server Bridge',  icon: 'plug'   },
  ]},
  { label: 'Discover', items: [
    { id: 'community', name: 'Community',      icon: 'compass' },
  ]},
  { label: 'Support',  items: [
    { id: 'docs',      name: 'Documentation',  icon: 'book' },
    { id: 'sdk',       name: 'SDK Reference',  icon: 'search' },
  ]},
];

function renderNav() {
  const nav = document.getElementById('nav');
  nav.innerHTML = '';
  for (const s of NAV_SECTIONS) {
    const sec = document.createElement('div');
    sec.className = 'nav-section';
    const hdr = document.createElement('div');
    hdr.className = 'eyebrow nav-section-label';
    hdr.textContent = s.label;
    sec.appendChild(hdr);
    for (const it of s.items) {
      const btn = document.createElement('button');
      btn.className = 'nav-item' + (state.nav === it.id ? ' active' : '');
      btn.dataset.nav = it.id;
      btn.appendChild(Ico(it.icon, { size: 14 }));
      const lbl = document.createElement('span'); lbl.className = 'label'; lbl.textContent = it.name;
      btn.appendChild(lbl);
      if (it.count != null) {
        const c = document.createElement('span'); c.className = 'count'; c.textContent = it.count;
        btn.appendChild(c);
      }
      btn.addEventListener('click', () => navigate(it.id));
      sec.appendChild(btn);
    }
    nav.appendChild(sec);
  }
}

function navigate(id) {
  state.nav = id;
  renderNav();
  renderScreen();
}

async function renderScreen() {
  const main = document.getElementById('main');
  main.innerHTML = '';
  main.scrollTop = 0;
  const dispatch = { local: renderLocal, bridge: renderBridge, community: renderCommunity, docs: renderDocs, sdk: renderSdk };
  const fn = dispatch[state.nav] || renderLocal;
  await fn(main);
}

function stubScreen(root, eyebrow, title) {
  root.innerHTML = `<div class="screen"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p class="subhead">Screen not yet ported — see task list.</p></div>`;
}

function wireTitleBar() {
  document.getElementById('tb-min').onclick   = () => window.api.windowMin();
  document.getElementById('tb-max').onclick   = () => window.api.windowMax();
  document.getElementById('tb-close').onclick = () => window.api.windowClose();
  document.getElementById('brand-icon').appendChild(Ico('code', { size: 12, sw: 1.5 }));
  document.getElementById('ico-upload').appendChild(Ico('upload', { size: 12, sw: 1.8 }));
}

window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('brand-version').textContent = 'v' + (window.appVersion || '1.2.0');
  wireTitleBar();
  // openUploadModal is defined in a later task; guard it for now.
  const upBtn = document.getElementById('btn-open-upload');
  if (typeof openUploadModal === 'function') upBtn.onclick = openUploadModal;
  renderNav();
  renderScreen();

  // Sidebar footer meta
  document.getElementById('sb-meta-path').textContent = '~/MyScripts';
  document.getElementById('sb-meta-free').textContent = 'local store';

  // Update-available banner (replaces sb-meta-free with a button when an update is found)
  if (window.api.onUpdateAvailable) {
    window.api.onUpdateAvailable((url, version) => {
      const slot = document.getElementById('sb-meta-free');
      slot.innerHTML = '';
      const btn = document.createElement('button');
      btn.className = 'gh-btn compact';
      btn.style.width = '100%';
      btn.style.color = 'var(--accent)';
      btn.textContent = `Update to v${version}`;
      btn.onclick = () => window.api.openUrl(url);
      slot.appendChild(btn);
    });
  }
});

// ---------- helpers ----------
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n/1024).toFixed(1)} KB`;
  return `${(n/1024/1024).toFixed(1)} MB`;
}
function fmtRel(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff/60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff/3600)}h ago`;
  return `${Math.floor(diff/86400)}d ago`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
}

// ---------- Local Scripts screen ----------
async function renderLocal(root) {
  const screen = document.createElement('div'); screen.className = 'screen';
  screen.innerHTML = `
    <div class="eyebrow">Library</div>
    <h1>Local Scripts</h1>
    <p class="subhead" id="local-subhead">Loading…</p>
    <div class="status-bar" id="local-status"></div>
    <div class="table" id="local-table"></div>
  `;
  root.appendChild(screen);

  const res = await window.api.listLocalScripts();
  if (!res.success) {
    screen.querySelector('#local-table').textContent = 'Error: ' + res.error;
    return;
  }
  const items = res.data;
  const totalBytes = items.reduce((a, b) => a + b.size, 0);
  updateNavCount('local', items.length);
  screen.querySelector('#local-subhead').innerHTML =
    `${items.length} scripts on disk · ${fmtBytes(totalBytes)} total`;
  screen.querySelector('#local-status').innerHTML = `
    <div class="left"><span class="status-dot on"></span><span>ready</span></div>
    <div>watch mode: off</div>
  `;

  const table = screen.querySelector('#local-table');
  const hdr = document.createElement('div');
  hdr.className = 'table-row header';
  hdr.innerHTML = `<div></div><div class="col">Name</div><div class="col">Description</div><div class="col">Modified</div><div class="col">Size</div><div class="col">Actions</div>`;
  table.appendChild(hdr);

  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'table-row';
    empty.style.padding = '48px 20px';
    empty.style.color = 'var(--text-faint)';
    empty.textContent = 'No local scripts yet. Click Upload Script to add one.';
    table.appendChild(empty);
    return;
  }

  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'table-row';

    const iconCell = document.createElement('div');
    iconCell.appendChild(Ico('file', { size: 14 }));

    const nameCell = document.createElement('div');
    nameCell.innerHTML =
      `<div class="row-name">${escapeHtml(it.name)}<span class="row-ext">.js</span></div>` +
      (it.description ? `<div class="row-desc">${escapeHtml(it.description)}</div>` : '');

    const descCell = document.createElement('div');   // spacer; description inlined above
    const modCell  = document.createElement('div'); modCell.className  = 'row-meta'; modCell.textContent  = fmtRel(it.modified);
    const sizeCell = document.createElement('div'); sizeCell.className = 'row-meta'; sizeCell.textContent = fmtBytes(it.size);

    const actions = document.createElement('div'); actions.className = 'actions';
    const mkBtn = (iconName, title, onClick, danger) => {
      const b = document.createElement('button');
      b.className = 'icon-btn' + (danger ? ' danger' : '');
      b.title = title;
      b.appendChild(Ico(iconName, { size: 13, sw: 1.4 }));
      b.onclick = onClick;
      return b;
    };
    actions.appendChild(mkBtn('push', 'Push to Bridge', async (e) => {
      e.stopPropagation();
      const r = await window.api.pushToMcp(it.file);
      if (!r.success) alert(r.error);
    }));
    actions.appendChild(mkBtn('download', 'Export to disk', (e) => {
      e.stopPropagation();
      window.api.exportToDisk(it.file);
    }));
    actions.appendChild(mkBtn('trash', 'Delete', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete ${it.file}?`)) return;
      await window.api.deleteLocalScript(it.file);
      renderScreen();
    }, true));

    row.append(iconCell, nameCell, descCell, modCell, sizeCell, actions);
    table.appendChild(row);
  }
}

// ---------- Server Bridge screen ----------
async function renderBridge(root) {
  const screen = document.createElement('div'); screen.className = 'screen';
  screen.innerHTML = `
    <div class="eyebrow">Library</div>
    <h1>Server Bridge</h1>
    <p class="subhead">MCP connection to <span style="font-family:var(--f-mono)">localhost:6767</span></p>

    <div class="bridge-table">
      <div class="bridge-row header">
        <div class="col">Host</div><div class="col">Address</div>
        <div class="col">Version</div><div class="col">Latency</div>
        <div class="col">Status</div><div class="col">Action</div>
      </div>
      <div class="bridge-row" id="bridge-primary">
        <div style="color:var(--text-strong)">Affinity MCP</div>
        <div class="mono" style="color:var(--text); font-family:var(--f-mono);">localhost:6767</div>
        <div class="mono" style="font-family:var(--f-mono);">1.0.0</div>
        <div class="mono" id="bridge-latency" style="font-family:var(--f-mono);">—</div>
        <div><span class="status-dot" id="bridge-dot"></span> <span id="bridge-status" style="text-transform:uppercase; font-family:var(--f-mono); font-size:10px;">checking…</span></div>
        <div><button class="gh-btn compact" id="btn-bridge-refresh">Refresh</button></div>
      </div>
    </div>

    <div class="eyebrow">Event Stream</div>
    <div class="event-log" id="bridge-log"></div>

    <h2 class="section-title">Scripts on Bridge</h2>
    <div class="card-grid" id="bridge-cards"></div>
  `;
  root.appendChild(screen);

  const log = screen.querySelector('#bridge-log');
  const pushEvent = (tag, msg) => {
    const line = document.createElement('div'); line.className = 'event-line';
    const now = new Date().toTimeString().slice(0, 8);
    line.innerHTML = `<span class="t">${now}</span><span class="tag-${tag}">${tag.toUpperCase()}</span><span class="msg">${escapeHtml(msg)}</span>`;
    log.prepend(line);
  };
  pushEvent('info', 'Attaching to bridge…');

  const start = performance.now();
  const res = await window.api.listMcpScripts();
  const elapsed = Math.round(performance.now() - start);
  screen.querySelector('#bridge-latency').textContent = `${elapsed} ms`;

  if (res.success) {
    screen.querySelector('#bridge-dot').classList.add('on');
    screen.querySelector('#bridge-status').textContent = 'online';
    pushEvent('ok', `connected · ${elapsed}ms round-trip`);
  } else {
    screen.querySelector('#bridge-status').textContent = 'offline';
    pushEvent('warn', res.error || 'bridge unreachable');
  }

  const cards = screen.querySelector('#bridge-cards');
  const titles = (res.success && typeof res.data === 'string')
    ? res.data.split(/[\n,]+/).map(s => s.trim()).filter(Boolean)
    : [];
  if (titles.length === 0) {
    cards.innerHTML = '<div style="color:var(--text-faint); font-size:12px; grid-column: 1/-1;">No scripts on bridge.</div>';
  } else {
    for (const t of titles) {
      const c = document.createElement('div'); c.className = 'card';
      const title = document.createElement('div'); title.className = 'card-title';
      title.appendChild(Ico('file', { size: 14 }));
      const span = document.createElement('span'); span.textContent = t;
      title.appendChild(span);
      c.appendChild(title);
      const spacer = document.createElement('div'); spacer.style.flex = '1'; c.appendChild(spacer);
      const btn = document.createElement('button'); btn.className = 'gh-btn compact'; btn.textContent = 'Download';
      btn.onclick = () => {
        if (typeof openDownloadModal === 'function') openDownloadModal(t);
        else alert('Download modal arrives in Task 10. Script title: ' + t);
      };
      c.appendChild(btn);
      cards.appendChild(c);
    }
  }

  screen.querySelector('#btn-bridge-refresh').onclick = () => renderScreen();
}

// ---------- Community Scripts screen ----------
async function renderCommunity(root) {
  const screen = document.createElement('div'); screen.className = 'screen';
  screen.innerHTML = `
    <div class="eyebrow">Discover</div>
    <div class="screen-header">
      <div>
        <h1 style="margin-bottom:6px">Community Scripts</h1>
        <p class="subhead" style="margin:0"><span id="c-count">—</span> scripts from <span id="c-repos">—</span> repositories</p>
      </div>
      <div class="actions">
        <button class="gh-btn compact" id="btn-community-source"><span id="ico-src"></span> Source</button>
        <button class="gh-btn compact" id="btn-community-settings"><span id="ico-gear"></span> Settings</button>
        <button class="accent-btn compact" id="btn-community-submit"><span id="ico-plus"></span> Submit Script</button>
      </div>
    </div>

    <div class="search-bar">
      <div class="search-wrap">
        <span id="c-search-icon"></span>
        <input id="c-search" type="text" placeholder="Search scripts by name, author, description…" />
        <span class="kbd">⌘K</span>
      </div>
      <div class="sort">
        <select id="c-sort">
          <option value="name">A — Z</option>
          <option value="category">Category</option>
          <option value="author">Author</option>
        </select>
      </div>
    </div>

    <div class="cat-tabs" id="c-tabs"></div>
    <div class="community-grid" id="c-grid"></div>
  `;
  root.appendChild(screen);

  screen.querySelector('#ico-src').appendChild(Ico('github', { size: 12 }));
  screen.querySelector('#ico-gear').appendChild(Ico('gear', { size: 13, sw: 1.4 }));
  screen.querySelector('#ico-plus').appendChild(Ico('plus', { size: 12, sw: 1.8 }));
  screen.querySelector('#c-search-icon').appendChild(Ico('search', { size: 13 }));

  screen.querySelector('#btn-community-source').onclick   = () => window.api.openUrl('https://github.com/JiriKrblich/Affinity-Community-Scripts');
  screen.querySelector('#btn-community-settings').onclick = () => window.api.openSettings();
  screen.querySelector('#btn-community-submit').onclick   = () => window.api.openExternalRepo();

  const res = await window.api.listCommunityScripts();
  const scripts = (res && res.success) ? (res.data || []) : [];

  screen.querySelector('#c-count').textContent = scripts.length;
  updateNavCount('community', scripts.length);
  const repos = new Set(scripts.map(s => s._source).filter(Boolean));
  screen.querySelector('#c-repos').textContent = repos.size;

  // Build category list
  const catCounts = new Map();
  catCounts.set('all', scripts.length);
  for (const s of scripts) {
    const c = (s.category || 'other').toLowerCase();
    catCounts.set(c, (catCounts.get(c) || 0) + 1);
  }

  const tabs = screen.querySelector('#c-tabs');
  function renderTabs() {
    tabs.innerHTML = '';
    for (const [c, count] of catCounts) {
      const btn = document.createElement('button');
      btn.className = 'cat-tab' + (state.communityFilter === c ? ' active' : '');
      const label = c === 'all' ? 'All' : (c[0].toUpperCase() + c.slice(1));
      btn.innerHTML = `<span>${escapeHtml(label)}</span><span class="count">${count}</span>`;
      btn.onclick = () => { state.communityFilter = c; renderTabs(); paint(); };
      tabs.appendChild(btn);
    }
  }

  const input = screen.querySelector('#c-search');
  input.value = state.communityQuery;
  input.oninput = (e) => { state.communityQuery = e.target.value; paint(); };
  const sortSel = screen.querySelector('#c-sort');
  sortSel.value = state.communitySort;
  sortSel.onchange = (e) => { state.communitySort = e.target.value; paint(); };

  const grid = screen.querySelector('#c-grid');

  function paint() {
    const q = state.communityQuery.toLowerCase();
    let filtered = scripts.filter(s => {
      if (state.communityFilter !== 'all' && (s.category || 'other').toLowerCase() !== state.communityFilter) return false;
      if (!q) return true;
      return [s.name, s.description, s.author].some(v => (v || '').toLowerCase().includes(q));
    });
    filtered.sort((a, b) => (a[state.communitySort] || '').localeCompare(b[state.communitySort] || ''));

    grid.innerHTML = '';
    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'grid-column: 1/-1; text-align:center; padding:48px; color:var(--text-faint); font-size:13px;';
      empty.textContent = q ? `No scripts match "${q}".` : 'No scripts in this category.';
      grid.appendChild(empty);
      return;
    }

    filtered.forEach((s) => {
      const installed = state.installedIds.has(s.download_url);
      const card = document.createElement('div');
      card.className = 'c-card';
      const cardHtml = [];
      cardHtml.push(`
        <div class="top-row">
          <h3>${escapeHtml(s.name || '(untitled)')}</h3>
          <span class="tag">v${escapeHtml(s.version || '1.0.0')}</span>
        </div>
        <div class="author">by ${escapeHtml(s.author || 'community')}</div>
        <div class="desc">${escapeHtml(s.description || '')}</div>
        <div class="foot">
          <span class="tag">${escapeHtml((s.category || 'other').toLowerCase())}</span>
          <button class="install-btn${installed ? ' installed' : ''}">${installed ? '\u2713 Installed' : 'Install'}</button>
        </div>
      `);
      card.innerHTML = cardHtml.join('');

      const btn = card.querySelector('.install-btn');
      btn.onclick = async () => {
        if (installed) return;
        btn.textContent = 'Installing\u2026'; btn.disabled = true;
        const r = await window.api.downloadCommunityScript(s.download_url, s.name);
        if (r && r.success) {
          state.installedIds.add(s.download_url);
          btn.classList.add('installed');
          btn.textContent = '\u2713 Installed';
        } else {
          alert((r && r.error) || 'Download failed');
          btn.textContent = 'Install';
          btn.disabled = false;
        }
      };
      grid.appendChild(card);
    });
  }

  renderTabs();
  paint();

  // Refresh community when settings window adds/removes a repo
  if (window.api.onReposChanged && !window._communityReposHandlerAttached) {
    window._communityReposHandlerAttached = true;
    window.api.onReposChanged(() => {
      if (state.nav === 'community') renderScreen();
    });
  }
}

// ---------- Documentation screen ----------
let docsCache = null;

async function renderDocs(root) {
  const screen = document.createElement('div'); screen.className = 'screen';
  screen.innerHTML = `
    <div class="eyebrow">Support</div>
    <h1>Documentation</h1>
    <p class="subhead" id="docs-sub">Fetching topics…</p>
    <div id="docs-body"></div>
  `;
  root.appendChild(screen);
  const body = screen.querySelector('#docs-body');

  if (!docsCache) {
    const res = await window.api.fetchDocs();
    if (!res.success) { body.textContent = 'Error: ' + res.error; return; }
    docsCache = res.data || [];
  }
  screen.querySelector('#docs-sub').textContent = `${docsCache.length} topics`;

  const grid = document.createElement('div'); grid.className = 'docs-grid';
  docsCache.forEach((d, i) => {
    const card = document.createElement('div'); card.className = 'doc-card';
    card.innerHTML = `
      <div class="meta"><span>${String(i + 1).padStart(2, '0')}</span><span>Reference</span></div>
      <h3>${escapeHtml(d.title)}</h3>
      <div class="read">Read →</div>
    `;
    card.onclick = () => openDocReader(d);
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

function openDocReader(doc) {
  const main = document.getElementById('main');
  main.innerHTML = '';
  main.scrollTop = 0;
  const reader = document.createElement('div'); reader.className = 'doc-reader';
  const back = document.createElement('button'); back.className = 'gh-btn compact'; back.style.marginBottom = '20px';
  back.textContent = '← Back to Documentation';
  back.onclick = () => renderScreen();
  reader.appendChild(back);

  const title = document.createElement('h1'); title.textContent = doc.title;
  reader.appendChild(title);

  const content = document.createElement('div');
  content.innerHTML = (window.marked && doc.content) ? window.marked.parse(doc.content) : escapeHtml(doc.content || '');
  reader.appendChild(content);

  main.appendChild(reader);
}

// ---------- SDK Reference screen ----------
async function renderSdk(root) {
  const screen = document.createElement('div'); screen.className = 'screen';
  screen.innerHTML = `
    <div class="eyebrow">Support</div>
    <h1>SDK Reference</h1>
    <p class="subhead">Search the SDK for hints and examples.</p>
    <div class="search-bar" style="margin-bottom: 24px;">
      <div class="search-wrap">
        <span id="sdk-search-ico"></span>
        <input id="sdk-q" type="text" placeholder="How do I handle authentication?" />
        <span class="kbd">↵</span>
      </div>
    </div>
    <div id="sdk-result" style="min-height:120px; color:var(--text-faint); font-size:12px;">Type a question and press Enter.</div>
  `;
  root.appendChild(screen);
  screen.querySelector('#sdk-search-ico').appendChild(Ico('search', { size: 13 }));

  const input = screen.querySelector('#sdk-q');
  const out = screen.querySelector('#sdk-result');

  input.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter') return;
    const q = input.value.trim();
    if (!q) return;
    out.className = '';
    out.removeAttribute('style');
    out.style.minHeight = '120px';
    out.style.color = 'var(--text-faint)';
    out.style.fontSize = '12px';
    out.innerHTML = '<div class="eyebrow accent">searching…</div>';

    let r;
    try {
      r = await window.api.searchDocs(q);
    } catch (err) {
      out.removeAttribute('style');
      out.style.cssText = 'color: var(--danger-text); font-size: 12px; padding: 16px; border: 1px solid var(--danger-border); background: var(--danger-bg);';
      out.textContent = 'IPC error: ' + (err && err.message ? err.message : String(err));
      return;
    }

    if (!r || !r.success) {
      out.removeAttribute('style');
      out.style.cssText = 'color: var(--danger-text); font-size: 12px; padding: 16px; border: 1px solid var(--danger-border); background: var(--danger-bg);';
      out.textContent = (r && r.error) || 'Search failed with no error message — the MCP bridge may be offline. Check the Server Bridge screen.';
      return;
    }

    const text = (r.data || '').trim();
    if (!text) {
      out.removeAttribute('style');
      out.style.cssText = 'color: var(--text-faint); font-size: 12px; padding: 16px; border: 1px solid var(--hair); background: var(--bg-card);';
      out.textContent = `No hints matched "${q}". The SDK hint pool is cross-session and populated by other tools — it may be empty for this query.`;
      return;
    }

    out.className = 'doc-reader';
    out.removeAttribute('style');
    out.style.cssText = 'padding: 24px; border: 1px solid var(--hair); background: var(--bg-card);';
    out.innerHTML = (window.marked ? window.marked.parse(text) : escapeHtml(text));
  });
}

// ---------- Upload / Download modals ----------
function openUploadModal() {
  const bd = document.createElement('div'); bd.className = 'modal-backdrop';
  bd.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>Upload Script</h3>
        <button class="icon-btn" id="m-close"></button>
      </div>
      <div class="modal-body">
        <p>Saves locally and pushes to the bridge.</p>
        <button class="gh-btn" id="m-pick" style="width:100%">Select .js File</button>
        <div><label>Title</label><input id="m-title" type="text"></div>
        <div><label>Description (optional)</label><input id="m-desc" type="text"></div>
      </div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-cancel">Cancel</button>
        <button class="accent-btn" id="m-save">Save Script</button>
      </div>
    </div>`;
  bd.querySelector('#m-close').appendChild(Ico('close', { size: 12 }));
  document.body.appendChild(bd);

  const close = () => bd.remove();
  bd.querySelector('#m-close').onclick  = close;
  bd.querySelector('#m-cancel').onclick = close;
  bd.addEventListener('click', (e) => { if (e.target === bd) close(); });

  let code = '';
  bd.querySelector('#m-pick').onclick = async () => {
    const r = await window.api.selectFile();
    if (r && r.success) {
      bd.querySelector('#m-title').value = r.data.name || '';
      bd.querySelector('#m-desc').value  = r.data.description || '';
      code = r.data.code || '';
    }
  };
  bd.querySelector('#m-save').onclick = async () => {
    const title = bd.querySelector('#m-title').value.trim();
    const desc  = bd.querySelector('#m-desc').value.trim();
    if (!title || !code) { alert('Title and a .js file are required.'); return; }
    const btn = bd.querySelector('#m-save');
    btn.textContent = 'Saving…'; btn.disabled = true;
    const r = await window.api.saveScript(title, desc, code);
    if (!r || !r.success) { alert((r && r.error) || 'Save failed'); btn.textContent = 'Save Script'; btn.disabled = false; return; }
    close();
    if (state.nav === 'local') renderScreen();
  };
}

function openDownloadModal(title) {
  const bd = document.createElement('div'); bd.className = 'modal-backdrop';
  const safe = title.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  bd.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-head"><h3>Download to Library</h3></div>
      <div class="modal-body"><div><label>Save as</label><input id="m-name" type="text" value="${escapeHtml(safe)}"></div></div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-cancel">Cancel</button>
        <button class="accent-btn" id="m-ok">Download</button>
      </div>
    </div>`;
  document.body.appendChild(bd);

  const close = () => bd.remove();
  bd.querySelector('#m-cancel').onclick = close;
  bd.addEventListener('click', (e) => { if (e.target === bd) close(); });

  bd.querySelector('#m-ok').onclick = async () => {
    const name = bd.querySelector('#m-name').value.trim();
    if (!name) return;
    const btn = bd.querySelector('#m-ok');
    btn.textContent = 'Downloading…'; btn.disabled = true;
    const r = await window.api.downloadFromMcp(title, name);
    if (!r || !r.success) { alert((r && r.error) || 'Download failed'); btn.textContent = 'Download'; btn.disabled = false; return; }
    close();
    state.nav = 'local'; renderNav(); renderScreen();
  };
}

// ---------- Nav count helper ----------
function updateNavCount(id, count) {
  const item = document.querySelector(`.nav-item[data-nav="${id}"]`);
  if (!item) return;
  let slot = item.querySelector('.count');
  if (!slot) {
    slot = document.createElement('span');
    slot.className = 'count';
    item.appendChild(slot);
  }
  slot.textContent = (count == null) ? '' : count;
}
