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

function renderScreen() {
  const main = document.getElementById('main');
  main.innerHTML = `<div class="screen"><div class="eyebrow">placeholder</div><h1>${state.nav}</h1><p class="subhead">Screen not yet ported — see task list.</p></div>`;
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
