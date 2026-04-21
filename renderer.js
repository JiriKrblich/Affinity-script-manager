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
  const dispatch = { local: renderLocal, bridge: renderBridge, community: renderCommunityStub, docs: renderDocsStub, sdk: renderSdkStub };
  const fn = dispatch[state.nav] || renderLocal;
  await fn(main);
}

function renderCommunityStub(root) { stubScreen(root, 'Discover', 'Community Scripts'); }
function renderDocsStub(root) { stubScreen(root, 'Support', 'Documentation'); }
function renderSdkStub(root) { stubScreen(root, 'Support', 'SDK Reference'); }
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
