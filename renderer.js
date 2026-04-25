const Ico = window.Icons.createIcon;
const state = {
  nav: "local",
  communityQuery: "",
  communityFilter: "all",
  communitySort: "name",
  installedIds: new Set(),
  editorFile: null,
  editorDirty: false,
  editorOrigin: "local", // 'local' | 'develop' — where the editor's Back button should return to
  editorIsNew: false, // true = blank buffer, filename typed inline, materialised on first save
};

// Live Ace editor instance (outside `state` so it's not treated as declarative UI state).
let activeEditor = null;

const NAV_SECTIONS = [
  {
    label: "Library",
    items: [
      { id: "local", name: "My Scripts", icon: "folder" },
      { id: "bridge", name: "Installed Scripts", icon: "plug" },
    ],
  },
  {
    label: "Discover",
    items: [{ id: "community", name: "Community", icon: "compass" }],
  },
  {
    label: "Development",
    items: [{ id: "develop", name: "Code Editor", icon: "code" }],
  },
  {
    label: "Support",
    items: [
      { id: "docs", name: "Documentation", icon: "book" },
      {
        id: "issues",
        name: "Issues",
        icon: "github",
        external:
          "https://github.com/JiriKrblich/Affinity-script-manager/issues",
      },
    ],
  },
];

function renderNav() {
  const nav = document.getElementById("nav");
  nav.innerHTML = "";
  // Editor is a sub-flow — highlight the section the user came from (Local or Development).
  const effectiveNav =
    state.nav === "editor" ? state.editorOrigin || "local" : state.nav;
  for (const s of NAV_SECTIONS) {
    const sec = document.createElement("div");
    sec.className = "nav-section";
    const hdr = document.createElement("div");
    hdr.className = "eyebrow nav-section-label";
    hdr.textContent = s.label;
    sec.appendChild(hdr);
    for (const it of s.items) {
      const btn = document.createElement("button");
      btn.className = "nav-item" + (effectiveNav === it.id ? " active" : "");
      btn.dataset.nav = it.id;
      // data-label drives the collapsed tooltip via CSS ::after
      btn.setAttribute("data-label", it.name);
      btn.appendChild(Ico(it.icon, { size: 14 }));
      const lbl = document.createElement("span");
      lbl.className = "label";
      lbl.textContent = it.name;
      btn.appendChild(lbl);
      if (it.count != null) {
        const c = document.createElement("span");
        c.className = "count";
        c.textContent = it.count;
        btn.appendChild(c);
      }
      if (it.external) {
        const ext = Ico("external", { size: 11, sw: 1.4 });
        ext.classList.add("nav-ext-ico");
        btn.appendChild(ext);
      }
      btn.addEventListener("click", () => {
        if (it.external) {
          window.api.openUrl(it.external);
          return;
        }
        navigate(it.id);
      });
      sec.appendChild(btn);
    }
    nav.appendChild(sec);
  }
}

function navigate(id) {
  if (state.nav === "editor" && state.editorDirty && id !== "editor") {
    if (!confirm("You have unsaved changes. Discard and leave the editor?"))
      return;
    state.editorDirty = false;
  }
  state.nav = id;
  renderNav();
  renderScreen();
}

async function renderScreen() {
  const main = document.getElementById("main");
  // Tear down any prior Ace instance so it doesn't leak or double-mount.
  if (activeEditor) {
    try {
      activeEditor.destroy();
      activeEditor.container.remove();
    } catch {}
    activeEditor = null;
  }
  main.innerHTML = "";
  main.scrollTop = 0;
  const dispatch = {
    local: renderLocal,
    bridge: renderBridge,
    community: renderCommunity,
    develop: renderDevelop,
    docs: renderDocs,
    editor: renderEditor,
  };
  const fn = dispatch[state.nav] || renderLocal;
  await fn(main);
}

function openEditor(filename, origin = "local") {
  state.editorFile = filename;
  state.editorDirty = false;
  state.editorOrigin = origin;
  state.editorIsNew = false;
  navigate("editor");
}

const NEW_SCRIPT_TEMPLATE = `/**
 * name: Untitled Script
 * description:
 * version: 1.0.0
 * author:
 */

// write your script here
`;

function openNewScriptInEditor() {
  state.editorFile = null;
  state.editorIsNew = true;
  state.editorDirty = false;
  state.editorOrigin = "develop";
  navigate("editor");
}

function wireBrand() {
  document
    .getElementById("ico-upload")
    .appendChild(Ico("plus", { size: 12, sw: 1.8 }));

  // --- Sidebar collapse toggle ---
  const sidebar = document.querySelector(".sidebar");
  const toggleBtn = document.getElementById("btn-sidebar-toggle");

  if (toggleBtn) {
    // Chevron icon pointing left (collapses sidebar)
    toggleBtn.appendChild(Ico("chevronL", { size: 14 }));

    // Restore persisted state
    if (localStorage.getItem("sidebar-collapsed") === "1") {
      sidebar.classList.add("collapsed");
    }

    toggleBtn.addEventListener("click", () => {
      const isCollapsed = sidebar.classList.toggle("collapsed");
      localStorage.setItem("sidebar-collapsed", isCollapsed ? "1" : "0");
    });
  }
}

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("brand-version").textContent = "for Affinity";
  wireBrand();
  wireDropZone();

  const upBtn = document.getElementById("btn-open-upload");
  if (typeof openUploadModal === "function") upBtn.onclick = openUploadModal;

  // GitHub icon button in brand lockup
  const ghBtn = document.getElementById("btn-brand-gh");
  if (ghBtn) {
    ghBtn.appendChild(Ico("github", { size: 14 }));
    ghBtn.onclick = () =>
      window.api.openUrl(
        "https://github.com/JiriKrblich/Affinity-script-manager",
      );
  }

  if (window.api.onLocalScriptsChanged) {
    window.api.onLocalScriptsChanged(() => {
      if (state.nav === "local") renderScreen();
      window.api
        .listLocalScripts()
        .then((res) => {
          if (res && res.success) updateNavCount("local", res.data.length);
        })
        .catch(() => {});
    });
  }

  renderNav();
  renderScreen();

  // Update-available: show the dedicated update button under the version line.
  const showUpdateButton = (version, onClick) => {
    const btn = document.getElementById("btn-brand-update");
    if (!btn) return;
    btn.textContent = `\u2191 Update to v${version}`;
    btn.hidden = false;
    btn.onclick = onClick;
  };
  if (window.api.onUpdateAvailable) {
    window.api.onUpdateAvailable((url, version) => {
      showUpdateButton(version, () => window.api.openUrl(url));
    });
  }
});

function wireDropZone() {
  const zone = document.getElementById("sb-drop");
  if (!zone) return;
  const ico = document.getElementById("drop-ico");
  if (ico) ico.appendChild(Ico("upload", { size: 18, sw: 1.4 }));

  ["dragenter", "dragover"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      zone.classList.add("dragover");
    }),
  );
  ["dragleave", "dragend"].forEach((ev) =>
    zone.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove("dragover");
    }),
  );
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("dragover");
    const files = Array.from(e.dataTransfer.files || []).filter((f) =>
      f.name.toLowerCase().endsWith(".js"),
    );
    if (files.length === 0) {
      alert("Only .js files are accepted.");
      return;
    }
    let savedCount = 0;
    for (const f of files) {
      try {
        const code = await f.text();
        const safeName = f.name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-");
        const r = await window.api.saveLocalScript(safeName, code);
        if (r && r.success) savedCount++;
      } catch {}
    }
    if (savedCount && state.nav === "local") renderScreen();
  });
  // Prevent the browser from navigating away if the user misses the zone
  ["dragover", "drop"].forEach((ev) =>
    document.addEventListener(ev, (e) => {
      e.preventDefault();
      e.stopPropagation();
    }),
  );
}

// ---------- helpers ----------
function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function fmtRel(ms) {
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

// Compare dotted versions, returns -1 / 0 / +1. Missing parts treated as 0.
function cmpVer(a, b) {
  const pa = String(a || "0")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0,
      y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// ---------- My Scripts screen ----------
async function renderLocal(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `
    <div class="eyebrow">Library</div>
    <h1>My Scripts</h1>
    <p class="subhead" id="local-subhead">Loading…</p>
    <div class="status-bar" id="local-status"></div>
    <div class="table" id="local-table"></div>
  `;
  root.appendChild(screen);

  // Fetch local + bridge + community in parallel — bridge drives Active/Paused state,
  // community drives Update-available indication.
  const [localRes, bridgeRes, commRes] = await Promise.all([
    window.api.listLocalScripts(),
    window.api.listMcpScripts().catch(() => ({ success: false })),
    window.api.listCommunityScripts().catch(() => ({ success: false })),
  ]);
  if (!localRes.success) {
    screen.querySelector("#local-table").textContent =
      "Error: " + localRes.error;
    return;
  }
  const items = localRes.data;
  const totalBytes = items.reduce((a, b) => a + b.size, 0);
  updateNavCount("local", items.length);

  // Normalise bridge titles for cross-referencing (stem-based, lowercase).
  // Bridge is "online" whenever the RPC succeeded, even if the library is empty
  // (list_library_scripts returns an empty object rather than an empty string when
  // no scripts are in Affinity, so we can't gate on data type).
  const bridgeTitles = new Set();
  const bridgeOnline = !!(bridgeRes && bridgeRes.success);
  if (bridgeOnline && typeof bridgeRes.data === "string") {
    bridgeRes.data
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((t) => {
        bridgeTitles.add(t.toLowerCase());
        bridgeTitles.add(t.toLowerCase().replace(/[^a-z0-9_-]/g, "-"));
      });
  }
  const isActive = (it) => {
    const stem = it.file.replace(/\.js$/i, "").toLowerCase();
    const name = (it.name || "").toLowerCase();
    return bridgeTitles.has(stem) || bridgeTitles.has(name);
  };
  const activeCount = bridgeOnline ? items.filter(isActive).length : 0;

  // Community lookup — stem-key → {version, download_url, name}.
  const communityMap = new Map();
  if (commRes && commRes.success && Array.isArray(commRes.data)) {
    for (const s of commRes.data) {
      if (!s || !s.name) continue;
      const key = s.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
      communityMap.set(key, s);
    }
  }
  const updateFor = (it) => {
    const stem = it.file.replace(/\.js$/i, "").toLowerCase();
    const community = communityMap.get(stem);
    if (!community) return null;
    if (!community.version || !it.version) return null;
    return cmpVer(it.version, community.version) < 0 ? community : null;
  };

  screen.querySelector("#local-subhead").innerHTML =
    `${items.length} scripts · ${fmtBytes(totalBytes)} total`;
  screen.querySelector("#local-status").innerHTML = `
    <div class="left">
      <span class="status-dot ${bridgeOnline ? "on" : ""}"></span>
      <span>${bridgeOnline ? `Connected to Affinity · ${activeCount} active` : "Affinity not connected"}</span>
    </div>
    <div style="color:var(--text-faint); font-size:12px;">watch mode: on</div>
  `;

  const table = screen.querySelector("#local-table");
  const hdr = document.createElement("div");
  hdr.className = "table-row header";
  hdr.innerHTML = `<div class="col">Status</div><div class="col">Name</div><div class="col">Modified</div><div class="col">Size</div><div class="col">Actions</div>`;
  table.appendChild(hdr);

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.className = "table-row";
    empty.style.padding = "48px 20px";
    empty.style.color = "var(--text-faint)";
    empty.textContent = "No scripts yet. Click Add Script to add one.";
    table.appendChild(empty);
    return;
  }

  for (const it of items) {
    const row = document.createElement("div");
    row.className = "table-row";

    const active = bridgeOnline && isActive(it);

    // Install dot — grey when paused (row-hover previews green), green when active.
    // Uninstall isn't exposed by Affinity's MCP, so active dots are non-interactive.
    const dotCell = document.createElement("div");
    const dot = document.createElement("button");
    dot.className = "install-dot" + (active ? " on" : "");
    dot.title = active
      ? "Installed in Affinity"
      : bridgeOnline
        ? "Install to Affinity"
        : "Affinity is not connected";
    if (!bridgeOnline) dot.disabled = true;
    dot.onclick = async (e) => {
      e.stopPropagation();
      if (active || !bridgeOnline) return;
      dot.disabled = true;
      const r = await window.api.pushToMcp(it.file);
      if (r && r.success) {
        renderScreen();
        return;
      }
      alert("Install failed: " + ((r && r.error) || "unknown error"));
      dot.disabled = false;
    };
    dotCell.appendChild(dot);

    const nameCell = document.createElement("div");
    const nameLine = document.createElement("div");
    nameLine.className = "row-name";
    nameLine.innerHTML = `${escapeHtml(it.name)}<span class="row-ext">.js</span>`;
    const update = updateFor(it);
    if (update) {
      const upBadge = document.createElement("button");
      upBadge.className = "tag tag-warn tag-clickable";
      upBadge.innerHTML = `\u2191 Update <span style="opacity:.7; margin-left:4px;">${escapeHtml(update.version)}</span>`;
      upBadge.title = `Update to v${update.version}`;
      upBadge.onclick = async (e) => {
        e.stopPropagation();
        const orig = upBadge.innerHTML;
        upBadge.innerHTML = '<span class="loading">Updating</span>';
        upBadge.disabled = true;
        const r = await window.api.saveCommunityScript(
          update.download_url,
          update.name,
        );
        if (r && r.success) {
          renderScreen();
          return;
        }
        alert("Update failed: " + ((r && r.error) || "unknown error"));
        upBadge.innerHTML = orig;
        upBadge.disabled = false;
      };
      nameLine.appendChild(upBadge);
    }
    nameCell.appendChild(nameLine);
    if (it.description) {
      const desc = document.createElement("div");
      desc.className = "row-desc";
      desc.textContent = it.description;
      nameCell.appendChild(desc);
    }

    const modCell = document.createElement("div");
    modCell.className = "row-meta";
    modCell.textContent = fmtRel(it.modified);
    const sizeCell = document.createElement("div");
    sizeCell.className = "row-meta";
    sizeCell.textContent = fmtBytes(it.size);

    const actions = document.createElement("div");
    actions.className = "actions";
    const mkBtn = (iconName, title, onClick, danger) => {
      const b = document.createElement("button");
      b.className = "icon-btn" + (danger ? " danger" : "");
      b.title = title;
      b.appendChild(Ico(iconName, { size: 13, sw: 1.4 }));
      b.onclick = onClick;
      return b;
    };
    actions.appendChild(
      mkBtn("edit", "Edit script", (e) => {
        e.stopPropagation();
        openEditor(it.file, "local");
      }),
    );
    actions.appendChild(
      mkBtn("download", "Export to disk", (e) => {
        e.stopPropagation();
        window.api.exportToDisk(it.file);
      }),
    );
    actions.appendChild(
      mkBtn(
        "trash",
        "Delete",
        async (e) => {
          e.stopPropagation();
          if (!confirm(`Delete ${it.file}?`)) return;
          await window.api.deleteLocalScript(it.file);
          renderScreen();
        },
        true,
      ),
    );

    row.append(dotCell, nameCell, modCell, sizeCell, actions);
    // Whole row = install target for paused rows. Active rows are non-interactive at row level.
    if (bridgeOnline && !active) {
      row.style.cursor = "pointer";
      row.onclick = () => dot.click();
    }
    table.appendChild(row);
  }
}

// ---------- Installed Scripts screen ----------
async function renderBridge(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `
    <div class="eyebrow">Library</div>
    <h1>Installed Scripts</h1>
    <p class="subhead">MCP connection to <span style="color:var(--text-strong)">localhost:6767</span></p>

    <div class="bridge-table">
      <div class="bridge-row header">
        <div class="col">Host</div><div class="col">Address</div>
        <div class="col">Version</div><div class="col">Latency</div>
        <div class="col">Status</div><div class="col">Action</div>
      </div>
      <div class="bridge-row" id="bridge-primary">
        <div style="color:var(--text-strong)">Affinity MCP</div>
        <div style="color:var(--text)">localhost:6767</div>
        <div style="color:var(--text)">1.0.0</div>
        <div id="bridge-latency" style="color:var(--text); font-variant-numeric:tabular-nums;">—</div>
        <div style="display:flex; align-items:center; gap:8px;"><span class="status-dot" id="bridge-dot"></span> <span id="bridge-status" style="font:500 12px/1 var(--f-sans); color:var(--text-strong); text-transform:capitalize;"><span class="loading">checking</span></span></div>
        <div><button class="gh-btn compact" id="btn-bridge-refresh">Refresh</button></div>
      </div>
    </div>

    <details class="event-stream">
      <summary class="eyebrow">Event Stream</summary>
      <div class="event-log" id="bridge-log"></div>
    </details>

    <h2 class="section-title">Scripts in Affinity</h2>
    <div class="card-grid" id="bridge-cards"></div>
  `;
  root.appendChild(screen);

  const log = screen.querySelector("#bridge-log");
  const pushEvent = (tag, msg) => {
    const line = document.createElement("div");
    line.className = "event-line";
    const now = new Date().toTimeString().slice(0, 8);
    line.innerHTML = `<span class="t">${now}</span><span class="tag-${tag}">${tag.toUpperCase()}</span><span class="msg">${escapeHtml(msg)}</span>`;
    log.prepend(line);
  };
  pushEvent("info", "Attaching to bridge…");

  const start = performance.now();
  const res = await window.api.listMcpScripts();
  const elapsed = Math.round(performance.now() - start);
  screen.querySelector("#bridge-latency").textContent = `${elapsed} ms`;

  if (res.success) {
    screen.querySelector("#bridge-dot").classList.add("on");
    screen.querySelector("#bridge-status").textContent = "online";
    pushEvent("ok", `connected · ${elapsed}ms round-trip`);
  } else {
    screen.querySelector("#bridge-status").textContent = "offline";
    pushEvent("warn", res.error || "bridge unreachable");
  }

  const cards = screen.querySelector("#bridge-cards");
  const titles =
    res.success && typeof res.data === "string"
      ? res.data
          .split(/[\n,]+/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  if (titles.length === 0) {
    cards.innerHTML =
      '<div style="color:var(--text-faint); font-size:12px; grid-column: 1/-1;">No scripts on bridge.</div>';
  } else {
    for (const t of titles) {
      const c = document.createElement("div");
      c.className = "card";
      const title = document.createElement("div");
      title.className = "card-title";
      title.appendChild(Ico("file", { size: 14 }));
      const span = document.createElement("span");
      span.textContent = t;
      title.appendChild(span);
      c.appendChild(title);
      const spacer = document.createElement("div");
      spacer.style.flex = "1";
      c.appendChild(spacer);
      const btn = document.createElement("button");
      btn.className = "gh-btn compact";
      btn.textContent = "Download";
      btn.onclick = () => {
        if (typeof openDownloadModal === "function") openDownloadModal(t);
        else alert("Download modal arrives in Task 10. Script title: " + t);
      };
      c.appendChild(btn);
      cards.appendChild(c);
    }
  }

  screen.querySelector("#btn-bridge-refresh").onclick = () => renderScreen();
}

// ---------- Community Scripts screen ----------
async function renderCommunity(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
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
    <div class="community-grid" id="c-grid">
      <div style="grid-column: 1/-1; color: var(--text-faint); font-size: 12px; padding: 20px 0;"><span class="loading">Fetching community scripts</span></div>
    </div>
  `;
  root.appendChild(screen);

  screen.querySelector("#ico-src").appendChild(Ico("github", { size: 12 }));
  screen
    .querySelector("#ico-gear")
    .appendChild(Ico("gear", { size: 13, sw: 1.4 }));
  screen
    .querySelector("#ico-plus")
    .appendChild(Ico("plus", { size: 12, sw: 1.8 }));
  screen
    .querySelector("#c-search-icon")
    .appendChild(Ico("search", { size: 13 }));

  screen.querySelector("#btn-community-source").onclick = () =>
    window.api.openUrl(
      "https://github.com/JiriKrblich/Affinity-Community-Scripts",
    );
  screen.querySelector("#btn-community-settings").onclick = () =>
    openSettingsModal();
  screen.querySelector("#btn-community-submit").onclick = () =>
    window.api.openExternalRepo();

  const res = await window.api.listCommunityScripts();
  const scripts = res && res.success ? res.data || [] : [];

  screen.querySelector("#c-count").textContent = scripts.length;
  updateNavCount("community", scripts.length);
  const repos = new Set(scripts.map((s) => s._source).filter(Boolean));
  screen.querySelector("#c-repos").textContent = repos.size;

  // Build category list
  const catCounts = new Map();
  catCounts.set("all", scripts.length);
  for (const s of scripts) {
    const c = (s.category || "other").toLowerCase();
    catCounts.set(c, (catCounts.get(c) || 0) + 1);
  }

  const tabs = screen.querySelector("#c-tabs");
  function renderTabs() {
    tabs.innerHTML = "";
    for (const [c, count] of catCounts) {
      const btn = document.createElement("button");
      btn.className =
        "cat-tab" + (state.communityFilter === c ? " active" : "");
      const label = c === "all" ? "All" : c[0].toUpperCase() + c.slice(1);
      btn.innerHTML = `<span>${escapeHtml(label)}</span><span class="count">${count}</span>`;
      btn.onclick = () => {
        state.communityFilter = c;
        renderTabs();
        paint();
      };
      tabs.appendChild(btn);
    }
  }

  const input = screen.querySelector("#c-search");
  input.value = state.communityQuery;
  input.oninput = (e) => {
    state.communityQuery = e.target.value;
    paint();
  };
  const sortSel = screen.querySelector("#c-sort");
  sortSel.value = state.communitySort;
  sortSel.onchange = (e) => {
    state.communitySort = e.target.value;
    paint();
  };

  const grid = screen.querySelector("#c-grid");

  function paint() {
    const q = state.communityQuery.toLowerCase();
    let filtered = scripts.filter((s) => {
      if (
        state.communityFilter !== "all" &&
        (s.category || "other").toLowerCase() !== state.communityFilter
      )
        return false;
      if (!q) return true;
      return [s.name, s.description, s.author].some((v) =>
        (v || "").toLowerCase().includes(q),
      );
    });
    filtered.sort((a, b) =>
      (a[state.communitySort] || "").localeCompare(
        b[state.communitySort] || "",
      ),
    );

    grid.innerHTML = "";
    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText =
        "grid-column: 1/-1; text-align:center; padding:48px; color:var(--text-faint); font-size:13px;";
      empty.textContent = q
        ? `No scripts match "${q}".`
        : "No scripts in this category.";
      grid.appendChild(empty);
      return;
    }

    filtered.forEach((s) => {
      const installed = state.installedIds.has(s.download_url);
      const card = document.createElement("div");
      card.className = "c-card";
      const cardHtml = [];
      cardHtml.push(`
        <div class="top-row">
          <h3>${escapeHtml(s.name || "(untitled)")}</h3>
          <span class="tag">v${escapeHtml(s.version || "1.0.0")}</span>
        </div>
        <div class="author">by ${escapeHtml(s.author || "community")}</div>
        <div class="desc">${escapeHtml(s.description || "")}</div>
        <div class="foot">
          <span class="tag">${escapeHtml((s.category || "other").toLowerCase())}</span>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="icon-btn c-save" title="Save to My Scripts (don't install)"></button>
            <button class="install-btn${installed ? " installed" : ""}">${installed ? "\u2713 Installed" : "Install"}</button>
          </div>
        </div>
      `);
      card.innerHTML = cardHtml.join("");

      const saveBtn = card.querySelector(".c-save");
      saveBtn.appendChild(Ico("download", { size: 13, sw: 1.4 }));
      saveBtn.onclick = async (e) => {
        e.stopPropagation();
        saveBtn.disabled = true;
        const r = await window.api.saveCommunityScript(s.download_url, s.name);
        if (r && r.success) {
          saveBtn.replaceChildren(Ico("check", { size: 13, sw: 1.6 }));
          saveBtn.title = "Saved to My Scripts";
          setTimeout(() => {
            saveBtn.replaceChildren(Ico("download", { size: 13, sw: 1.4 }));
            saveBtn.title = "Save to My Scripts (don't install)";
            saveBtn.disabled = false;
          }, 1600);
        } else {
          alert((r && r.error) || "Save failed");
          saveBtn.disabled = false;
        }
      };

      const btn = card.querySelector(".install-btn");
      btn.onclick = async () => {
        if (installed) return;
        btn.innerHTML = '<span class="loading">Installing</span>';
        btn.disabled = true;
        const r = await window.api.downloadCommunityScript(
          s.download_url,
          s.name,
        );
        if (r && r.success) {
          state.installedIds.add(s.download_url);
          btn.classList.add("installed");
          btn.textContent = "\u2713 Installed";
        } else {
          alert((r && r.error) || "Download failed");
          btn.textContent = "Install";
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
      if (state.nav === "community") renderScreen();
    });
  }
}

// ---------- Documentation screen ----------
let docsCache = null;

async function renderDocs(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `
    <div class="eyebrow">Support</div>
    <h1>Documentation</h1>
    <p class="subhead" id="docs-sub"><span class="loading">Fetching topics</span></p>

    <div class="search-bar" style="margin-bottom: 20px;">
      <div class="search-wrap">
        <span id="docs-search-ico"></span>
        <input id="docs-q" type="text" placeholder="Search the SDK for hints and examples" />
        <span class="kbd">↵</span>
      </div>
    </div>

    <div id="docs-search-result" style="display:none; margin-bottom: 28px;"></div>
    <div id="docs-body"></div>
  `;
  root.appendChild(screen);

  screen
    .querySelector("#docs-search-ico")
    .appendChild(Ico("search", { size: 13 }));

  // --- SDK search wired into the same screen ---
  const input = screen.querySelector("#docs-q");
  const out = screen.querySelector("#docs-search-result");

  const resetOut = () => {
    out.className = "";
    out.removeAttribute("style");
    out.innerHTML = "";
    out.style.display = "none";
  };

  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const q = input.value.trim();
    if (!q) {
      resetOut();
      return;
    }
    out.className = "";
    out.removeAttribute("style");
    out.style.display = "block";
    out.style.padding = "16px 20px";
    out.style.border = "1px solid var(--hair)";
    out.style.background = "var(--bg-card)";
    out.style.borderRadius = "var(--r-lg)";
    out.style.marginBottom = "28px";
    out.style.color = "var(--text-faint)";
    out.style.fontSize = "12px";
    out.innerHTML =
      '<div class="eyebrow accent"><span class="loading">searching</span></div>';

    let r;
    try {
      r = await window.api.searchDocs(q);
    } catch (err) {
      out.style.cssText =
        "display:block; margin-bottom: 28px; color: var(--danger-text); font-size: 12px; padding: 16px 20px; border: 1px solid var(--danger-border); background: var(--danger-bg); border-radius: var(--r-lg);";
      out.textContent =
        "IPC error: " + (err && err.message ? err.message : String(err));
      return;
    }
    if (!r || !r.success) {
      out.style.cssText =
        "display:block; margin-bottom: 28px; color: var(--danger-text); font-size: 12px; padding: 16px 20px; border: 1px solid var(--danger-border); background: var(--danger-bg); border-radius: var(--r-lg);";
      out.textContent =
        (r && r.error) ||
        "Search failed with no error message. The MCP bridge may be offline.";
      return;
    }
    const text = (r.data || "").trim();
    if (!text) {
      out.style.cssText =
        "display:block; margin-bottom: 28px; color: var(--text-faint); font-size: 12px; padding: 16px 20px; border: 1px solid var(--hair); background: var(--bg-card); border-radius: var(--r-lg);";
      out.textContent = `No hints matched "${q}". The SDK hint pool is cross-session and populated by other tools, it may be empty for this query.`;
      return;
    }
    out.className = "doc-reader";
    out.style.cssText =
      "display:block; margin-bottom: 28px; padding: 20px 24px; border: 1px solid var(--hair); background: var(--bg-card); border-radius: var(--r-lg);";
    const close = document.createElement("button");
    close.className = "gh-btn compact";
    close.textContent = "Clear search";
    close.style.marginBottom = "14px";
    close.onclick = () => {
      input.value = "";
      resetOut();
    };
    const content = document.createElement("div");
    content.innerHTML = window.marked
      ? window.marked.parse(text)
      : escapeHtml(text);
    out.innerHTML = "";
    out.appendChild(close);
    out.appendChild(content);
  });

  // --- Doc cards grid ---
  const body = screen.querySelector("#docs-body");
  if (!docsCache) {
    const res = await window.api.fetchDocs();
    if (!res.success) {
      body.textContent = "Error: " + res.error;
      return;
    }
    docsCache = res.data || [];
  }
  screen.querySelector("#docs-sub").textContent = `${docsCache.length} topics`;

  const grid = document.createElement("div");
  grid.className = "docs-grid";
  docsCache.forEach((d, i) => {
    const card = document.createElement("div");
    card.className = "doc-card";
    card.innerHTML = `
      <div class="meta"><span>${String(i + 1).padStart(2, "0")}</span><span>Reference</span></div>
      <h3>${escapeHtml(d.title)}</h3>
      <div class="read">Read →</div>
    `;
    card.onclick = () => openDocReader(d);
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

function openDocReader(doc) {
  const main = document.getElementById("main");
  main.innerHTML = "";
  main.scrollTop = 0;
  const reader = document.createElement("div");
  reader.className = "doc-reader";
  const back = document.createElement("button");
  back.className = "gh-btn compact";
  back.style.marginBottom = "20px";
  back.textContent = "← Back to Documentation";
  back.onclick = () => renderScreen();
  reader.appendChild(back);

  const title = document.createElement("h1");
  title.textContent = doc.title;
  reader.appendChild(title);

  const content = document.createElement("div");
  content.innerHTML =
    window.marked && doc.content
      ? window.marked.parse(doc.content)
      : escapeHtml(doc.content || "");
  reader.appendChild(content);

  main.appendChild(reader);
}

// ---------- Upload / Download modals ----------
function openUploadModal() {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>Add Script</h3>
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
  bd.querySelector("#m-close").appendChild(Ico("close", { size: 12 }));
  document.body.appendChild(bd);

  const close = () => bd.remove();
  bd.querySelector("#m-close").onclick = close;
  bd.querySelector("#m-cancel").onclick = close;
  bd.addEventListener("click", (e) => {
    if (e.target === bd) close();
  });

  let code = "";
  bd.querySelector("#m-pick").onclick = async () => {
    const r = await window.api.selectFile();
    if (r && r.success) {
      bd.querySelector("#m-title").value = r.data.name || "";
      bd.querySelector("#m-desc").value = r.data.description || "";
      code = r.data.code || "";
    }
  };
  bd.querySelector("#m-save").onclick = async () => {
    const title = bd.querySelector("#m-title").value.trim();
    const desc = bd.querySelector("#m-desc").value.trim();
    if (!title || !code) {
      alert("Title and a .js file are required.");
      return;
    }
    const btn = bd.querySelector("#m-save");
    btn.innerHTML = '<span class="loading">Saving</span>';
    btn.disabled = true;
    const r = await window.api.saveScript(title, desc, code);
    if (!r || !r.success) {
      alert((r && r.error) || "Save failed");
      btn.textContent = "Save Script";
      btn.disabled = false;
      return;
    }
    close();
    if (state.nav === "local") renderScreen();
  };
}

function openDownloadModal(title) {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  const safe = title.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
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
  bd.querySelector("#m-cancel").onclick = close;
  bd.addEventListener("click", (e) => {
    if (e.target === bd) close();
  });

  bd.querySelector("#m-ok").onclick = async () => {
    const name = bd.querySelector("#m-name").value.trim();
    if (!name) return;
    const btn = bd.querySelector("#m-ok");
    btn.innerHTML = '<span class="loading">Downloading</span>';
    btn.disabled = true;
    const r = await window.api.downloadFromMcp(title, name);
    if (!r || !r.success) {
      alert((r && r.error) || "Download failed");
      btn.textContent = "Download";
      btn.disabled = false;
      return;
    }
    close();
    state.nav = "local";
    renderNav();
    renderScreen();
  };
}

// ---------- Settings modal (internal — replaces the separate window) ----------
const DEFAULT_COMMUNITY_REPO =
  "https://raw.githubusercontent.com/JiriKrblich/Affinity-Community-Scripts/refs/heads/main/registry.json";

function openSettingsModal() {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal" style="max-width:560px">
      <div class="modal-head">
        <h3>Community Repositories</h3>
        <button class="icon-btn" id="m-close"></button>
      </div>
      <div class="modal-body" style="gap:18px;">
        <p>Paste a GitHub URL (<span style="color:var(--text-strong); font-weight:600;">https://github.com/user/repo</span>) to discover more scripts.</p>
        <div class="add-repo">
          <input id="m-repo" type="text" placeholder="https://github.com/user/repository">
          <button class="accent-btn compact" id="m-add">Add</button>
        </div>
        <div>
          <div class="eyebrow" style="margin-bottom:10px;">Active repositories</div>
          <div id="m-repo-list"></div>
        </div>
      </div>
    </div>`;
  bd.querySelector("#m-close").appendChild(Ico("close", { size: 13 }));
  document.body.appendChild(bd);

  const close = () => bd.remove();
  bd.querySelector("#m-close").onclick = close;
  bd.addEventListener("click", (e) => {
    if (e.target === bd) close();
  });

  const getDisplayName = (url) => {
    const m = url.match(/raw\.githubusercontent\.com\/([^\/]+\/[^\/]+)/);
    return m ? m[1] : url;
  };

  const list = bd.querySelector("#m-repo-list");
  const repoInput = bd.querySelector("#m-repo");
  const addBtn = bd.querySelector("#m-add");

  const load = async () => {
    const res = await window.api.getRepos();
    list.innerHTML = "";
    if (!res.success) return;
    res.data.forEach((url) => {
      const row = document.createElement("div");
      row.className = "repo-row";
      const isDefault = url === DEFAULT_COMMUNITY_REPO;
      const displayName = getDisplayName(url);
      row.innerHTML =
        `<div class="name">${escapeHtml(displayName)}</div>` +
        (isDefault
          ? `<span class="kind">Default</span>`
          : `<button class="gh-btn compact danger">Remove</button>`);
      if (!isDefault) {
        row.querySelector("button").onclick = async () => {
          if (!confirm(`Remove ${displayName}?`)) return;
          await window.api.removeRepo(url);
          load();
        };
      }
      list.appendChild(row);
    });
  };

  const submit = async () => {
    const url = repoInput.value.trim();
    if (!url) return;
    addBtn.innerHTML = '<span class="loading">Adding</span>';
    addBtn.disabled = true;
    const r = await window.api.addRepo(url);
    addBtn.textContent = "Add";
    addBtn.disabled = false;
    if (!r.success) {
      alert(r.error);
      return;
    }
    repoInput.value = "";
    load();
  };
  addBtn.onclick = submit;
  repoInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  load();
}

// ---------- Nav count helper ----------
function updateNavCount(id, count) {
  const item = document.querySelector(`.nav-item[data-nav="${id}"]`);
  if (!item) return;
  let slot = item.querySelector(".count");
  if (!slot) {
    slot = document.createElement("span");
    slot.className = "count";
    item.appendChild(slot);
  }
  slot.textContent = count == null ? "" : count;
}

// ---------- Editor screen ----------
async function renderEditor(root) {
  const isNew = !!state.editorIsNew;
  const filename = state.editorFile; // null when isNew === true
  if (!isNew && !filename) {
    state.nav = "local";
    return renderScreen();
  }

  const screen = document.createElement("div");
  screen.className = "editor-screen";
  const origin = state.editorOrigin || "local";
  const backLabel =
    origin === "develop" ? "← Back to Code Editor" : "← Back to My Scripts";

  // New scripts get a filename input in the header styled as an editable headline.
  // Existing scripts show the filename static with a dirty-dot indicator.
  const filenameHtml = isNew
    ? `<input id="ed-filename" type="text" placeholder="my-new-script" autocomplete="off" spellcheck="false">
       <span class="ed-ext">.js</span>`
    : `<span class="ed-dirty" id="ed-dirty"></span>${escapeHtml(filename)}`;

  screen.innerHTML = `
    <div class="editor-header">
      <button class="gh-btn compact" id="ed-back">${backLabel}</button>
      <div class="editor-filename${isNew ? " new" : ""}">${filenameHtml}</div>
      <button class="accent-btn compact" id="ed-save" disabled>Save</button>
    </div>
    <div class="editor-host" id="editor-host"></div>
  `;
  root.appendChild(screen);

  const backBtn = screen.querySelector("#ed-back");
  const saveBtn = screen.querySelector("#ed-save");
  const dirtyEl = screen.querySelector("#ed-dirty");
  const host = screen.querySelector("#editor-host");
  const nameInput = screen.querySelector("#ed-filename"); // null when not isNew
  backBtn.onclick = () => navigate(origin);

  if (!window.ace) {
    host.innerHTML = `<div style="padding:40px; color:var(--danger-text); font-size:13px;">
      Ace Editor failed to load (CDN unreachable?). Edit the file externally, watch mode will pick up changes automatically.
    </div>`;
    return;
  }

  let initialContent;
  if (isNew) {
    initialContent = NEW_SCRIPT_TEMPLATE;
  } else {
    const res = await window.api.readLocalScript(filename);
    if (!res || !res.success) {
      host.innerHTML = `<div style="padding:40px; color:var(--danger-text); font-size:13px;">Error: ${escapeHtml((res && res.error) || "Could not read file")}</div>`;
      return;
    }
    initialContent = res.data.code || "";
  }

  activeEditor = ace.edit(host, {
    mode: "ace/mode/javascript",
    theme: "ace/theme/tomorrow_night",
    tabSize: 2,
    useSoftTabs: true,
    fontSize: "13px",
    showPrintMargin: false,
    fontFamily: 'SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
  });
  activeEditor.setValue(initialContent, -1);
  if (isNew && nameInput) {
    nameInput.focus();
  } else {
    activeEditor.focus();
  }

  const markDirty = (b) => {
    state.editorDirty = b;
    if (dirtyEl) dirtyEl.textContent = b ? "● " : "";
    saveBtn.disabled = !b;
  };
  // New scripts start dirty (unsaved buffer). Existing scripts start clean.
  markDirty(isNew);

  activeEditor.session.on("change", () => {
    if (!state.editorDirty) markDirty(true);
  });

  const save = async () => {
    if (!activeEditor) return;
    const code = activeEditor.getValue();
    const originalLabel = saveBtn.textContent;

    let targetFilename;
    if (state.editorIsNew) {
      const raw = ((nameInput && nameInput.value) || "").trim();
      if (!raw) {
        alert("Please enter a script name before saving.");
        nameInput && nameInput.focus();
        return;
      }
      const base = raw
        .replace(/\.js$/i, "")
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, "-")
        .replace(/^-+|-+$/g, "");
      if (!base) {
        alert("Please enter a valid name (letters, numbers, dashes).");
        nameInput && nameInput.focus();
        return;
      }
      targetFilename = base + ".js";
    } else {
      targetFilename = filename;
    }

    saveBtn.innerHTML = '<span class="loading">Saving</span>';
    saveBtn.disabled = true;
    const r = await window.api.saveLocalScript(targetFilename, code);
    if (!r || !r.success) {
      alert("Save failed: " + ((r && r.error) || "unknown error"));
      saveBtn.textContent = originalLabel;
      saveBtn.disabled = false;
      return;
    }

    // If this was a new script, materialise it: swap input for static filename display
    // and update state so subsequent saves overwrite instead of prompting again.
    if (state.editorIsNew) {
      state.editorIsNew = false;
      state.editorFile = targetFilename;
      const fnameEl = screen.querySelector(".editor-filename");
      fnameEl.innerHTML = `<span class="ed-dirty" id="ed-dirty"></span>${escapeHtml(targetFilename)}`;
    }

    markDirty(false);
    saveBtn.textContent = originalLabel;
  };

  activeEditor.commands.addCommand({
    name: "save",
    bindKey: { win: "Ctrl-S", mac: "Cmd-S" },
    exec: save,
  });
  saveBtn.onclick = save;
}

// ---------- Code Editor (Development) screen ----------
async function renderDevelop(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `
    <div class="eyebrow">Development</div>
    <div class="screen-header">
      <div>
        <h1 style="margin-bottom:6px">Code Editor</h1>
        <p class="subhead" style="margin:0">Write new scripts or edit existing ones. Changes auto-sync to Affinity.</p>
      </div>
      <div class="actions">
        <button class="accent-btn compact" id="btn-new-script"><span id="ico-new-plus"></span> New Script</button>
      </div>
    </div>

    <div class="eyebrow" style="margin-bottom:12px">My Scripts</div>
    <div class="dev-list" id="dev-local"></div>

    <div class="eyebrow" style="margin:28px 0 12px">Community — Fork &amp; Edit</div>
    <div class="dev-list" id="dev-community"></div>
  `;
  root.appendChild(screen);
  screen
    .querySelector("#ico-new-plus")
    .appendChild(Ico("plus", { size: 12, sw: 1.8 }));
  screen.querySelector("#btn-new-script").onclick = openNewScriptInEditor;

  // Local scripts section — table list
  const localList = screen.querySelector("#dev-local");
  const localRes = await window.api.listLocalScripts();
  if (!localRes.success) {
    localList.innerHTML = `<div class="dev-empty">Error: ${escapeHtml(localRes.error)}</div>`;
  } else if (localRes.data.length === 0) {
    localList.innerHTML = `<div class="dev-empty">No local scripts yet. Click "New Script" to start one.</div>`;
  } else {
    for (const it of localRes.data) {
      const row = document.createElement("div");
      row.className = "dev-row";

      const iconCell = document.createElement("div");
      iconCell.appendChild(Ico("file", { size: 14 }));

      const nameCell = document.createElement("div");
      nameCell.innerHTML =
        `<div class="row-name">${escapeHtml(it.name)}<span class="row-ext">.js</span></div>` +
        (it.description
          ? `<div class="row-desc">${escapeHtml(it.description)}</div>`
          : "");

      const metaCell = document.createElement("div");
      metaCell.className = "row-meta";
      metaCell.textContent = fmtRel(it.modified);

      const btnCell = document.createElement("div");
      btnCell.style.textAlign = "right";
      const btn = document.createElement("button");
      btn.className = "gh-btn compact";
      btn.textContent = "Edit";
      btn.onclick = (e) => {
        e.stopPropagation();
        openEditor(it.file, "develop");
      };
      btnCell.appendChild(btn);

      row.append(iconCell, nameCell, metaCell, btnCell);
      row.onclick = () => openEditor(it.file, "develop");
      localList.appendChild(row);
    }
  }

  // Community section — table list
  const commList = screen.querySelector("#dev-community");
  commList.innerHTML =
    '<div class="dev-empty"><span class="loading">Fetching community registries</span></div>';
  const commRes = await window.api.listCommunityScripts();
  commList.innerHTML = "";
  if (!commRes || !commRes.success) {
    commList.innerHTML = `<div class="dev-empty">Error: ${escapeHtml((commRes && commRes.error) || "failed")}</div>`;
    return;
  }
  const scripts = commRes.data || [];
  if (scripts.length === 0) {
    commList.innerHTML = `<div class="dev-empty">No community scripts.</div>`;
    return;
  }
  for (const s of scripts) {
    const row = document.createElement("div");
    row.className = "dev-row community";

    const iconCell = document.createElement("div");
    iconCell.appendChild(Ico("file", { size: 14 }));

    const nameCell = document.createElement("div");
    const name = s.name || "(untitled)";
    const author = s.author || "community";
    nameCell.innerHTML =
      `<div class="row-name">${escapeHtml(name)}</div>` +
      `<div class="row-desc">by ${escapeHtml(author)}${s.description ? " · " + escapeHtml(s.description) : ""}</div>`;

    const btnCell = document.createElement("div");
    btnCell.style.textAlign = "right";
    const btn = document.createElement("button");
    btn.className = "gh-btn compact";
    btn.textContent = "Fork & Edit";

    const forkAndEdit = async (trigger) => {
      const original = trigger.textContent;
      trigger.innerHTML = '<span class="loading">Forking</span>';
      trigger.disabled = true;
      const r = await window.api.saveCommunityScript(s.download_url, s.name);
      if (!r || !r.success) {
        alert((r && r.error) || "Fork failed");
        trigger.textContent = original;
        trigger.disabled = false;
        return;
      }
      const safe =
        (s.name || "script").toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
      openEditor(safe, "develop");
    };
    btn.onclick = (e) => {
      e.stopPropagation();
      forkAndEdit(btn);
    };
    btnCell.appendChild(btn);

    row.append(iconCell, nameCell, btnCell);
    row.onclick = () => forkAndEdit(btn);
    commList.appendChild(row);
  }
}
