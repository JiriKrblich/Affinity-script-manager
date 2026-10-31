const Ico = window.Icons.createIcon;
let localeMessages = Object.create(null);

function t(key, params = {}) {
  const message = localeMessages[key] || key;
  return message.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (match, name) =>
    Object.hasOwn(params, name) ? String(params[name]) : match);
}

async function loadLocale(language = "en") {
  const result = await window.api.getLocale(language);
  if (!result?.success) throw new Error(result?.error || "Could not load language dictionary.");
  localeMessages = result.data;
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = t(element.dataset.i18n);
  });
}

const state = {
  nav: "local",
  localTab: "local", // 'local' | 'affinity' — My Scripts sub-tabs
  settingsFocus: null,
  settingsCategory: "general",
  localQuery: "",
  communityQuery: "",
  communityFilter: "all",
  communitySort: "name",
  communityLibraryFilter: "all",
  // Unified favorites, keyed by script stem — shared by My Scripts + Community.
  favorites: new Set(),
  editorFile: null,
  editorDirty: false,
  editorOrigin: "local", // 'local' | 'develop' — where the editor's Back button should return to
  editorIsNew: false, // true = blank buffer, filename typed inline, materialised on first save
};

// Live Ace editor instance (outside `state` so it's not treated as declarative UI state).
let activeEditor = null;

// Favorite key = script stem. A community script (by name) and its downloaded
// local file (by filename) resolve to the same stem, so a favorite is shared.
function scriptStem(nameOrFile) {
  return String(nameOrFile || "")
    .replace(/\.js$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-");
}
function communityFavoriteKey(script) {
  return scriptStem(script && script.name);
}
async function toggleScriptFavorite(stem) {
  const r = await window.api.toggleFavorite(stem);
  if (r && r.success) state.favorites = new Set(r.data);
  return !!(r && r.success);
}

function communityPreviewUrl(script) {
  return (
    (script &&
      (script._imageUrl ||
        script.image ||
        script.image_url ||
        script.preview_image ||
        script.screenshot)) ||
    ""
  );
}

function formatContributors(contributors) {
  if (Array.isArray(contributors)) {
    return contributors.filter(Boolean).join(", ");
  }
  return contributors || "";
}

function communityScriptMetadata(script) {
  return {
    name: script.name || "",
    description: script.description || "",
    version: script.version || "",
    author: script.author || "",
  };
}

const NAV_SECTIONS = [
  {
    label: "nav.library",
    items: [{ id: "local", name: "nav.myScripts", icon: "folder" }],
  },
  {
    label: "nav.discover",
    items: [{ id: "community", name: "nav.community", icon: "compass" }],
  },
  {
    label: "nav.development",
    items: [{ id: "develop", name: "nav.codeEditor", icon: "code" }],
  },
  {
    label: "nav.support",
    items: [
      { id: "affinity-status", name: "nav.affinityStatus", icon: "plug" },
      { id: "docs", name: "nav.documentation", icon: "book" },
      { id: "resources", name: "nav.resources", icon: "link" },
      {
        id: "issues",
        name: "nav.issues",
        icon: "github",
        external:
          "https://github.com/JiriKrblich/Affinity-script-manager/issues",
      },
    ],
  },
  {
    label: "nav.preferences",
    items: [{ id: "app-settings", name: "nav.appSettings", icon: "gear" }],
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
    hdr.textContent = t(s.label);
    sec.appendChild(hdr);
    for (const it of s.items) {
      const btn = document.createElement("button");
      btn.className = "nav-item" + (effectiveNav === it.id ? " active" : "");
      btn.dataset.nav = it.id;
      // data-label drives the collapsed tooltip via CSS ::after
      btn.setAttribute("data-label", t(it.name));
      btn.appendChild(Ico(it.icon, { size: 14 }));
      const lbl = document.createElement("span");
      lbl.className = "label";
      lbl.textContent = t(it.name);
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
    community: renderCommunity,
    develop: renderDevelop,
    docs: renderDocs,
    "affinity-status": renderAffinityStatus,
    resources: renderResources,
    "app-settings": renderAppSettings,
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

async function wireBrand() {
  document
    .getElementById("ico-upload")
    .appendChild(Ico("plus", { size: 12, sw: 1.8 }));

  // --- Sidebar collapse toggle ---
  const sidebar = document.querySelector(".sidebar");
  const toggleBtn = document.getElementById("btn-sidebar-toggle");

  if (toggleBtn) {
    // Chevron icon pointing left (collapses sidebar)
    toggleBtn.appendChild(Ico("chevronL", { size: 14 }));

    const configState = await window.api.getSidebarCollapsed();
    const legacyValue = localStorage.getItem("sidebar-collapsed");
    const legacyState = legacyValue === "1";
    const isInitiallyCollapsed =
      legacyValue != null
        ? legacyState
        : configState && configState.success
          ? configState.data
          : false;

    if (isInitiallyCollapsed) {
      sidebar.classList.add("collapsed");
    }
    if (legacyValue != null) {
      window.api.setSidebarCollapsed(isInitiallyCollapsed);
      localStorage.removeItem("sidebar-collapsed");
    }

    toggleBtn.addEventListener("click", () => {
      const isCollapsed = sidebar.classList.toggle("collapsed");
      window.api.setSidebarCollapsed(isCollapsed);
      localStorage.removeItem("sidebar-collapsed");
    });
  }
}

window.addEventListener("DOMContentLoaded", async () => {
  if (navigator.platform && navigator.platform.toLowerCase().includes("mac")) {
    document.body.classList.add("platform-darwin");
  }
  try {
    const configured = await window.api.getAppLanguage();
    await loadLocale(configured?.success ? configured.data : "en");
  } catch (error) {
    console.error("Could not load language dictionary:", error);
    try { await loadLocale("en"); }
    catch (fallbackError) { console.error("Could not load English dictionary:", fallbackError); }
  }
  document.getElementById("brand-version").textContent = t("app.affinity");
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
      Promise.all([window.api.listLocalScripts(), window.api.listWatchedScripts()])
        .then(([local, watched]) => {
          if (local?.success) updateNavCount("local", local.data.length + (watched?.data?.length || 0));
        })
        .catch(() => {});
    });
  }

  renderNav();
  renderScreen();
  wireGlobalKeys();

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

// Global keyboard shortcuts: Escape closes the topmost modal; Cmd/Ctrl+K jumps
// to the Community search and focuses it.
function wireGlobalKeys() {
  const focusCommunitySearch = (tries = 12) => {
    const input = document.getElementById("c-search");
    if (input) {
      input.focus();
      input.select();
      return;
    }
    if (tries > 0) requestAnimationFrame(() => focusCommunitySearch(tries - 1));
  };

  document.addEventListener("keydown", (e) => {
    // Esc — dismiss the topmost open modal (backdrops are stacked on <body>).
    if (e.key === "Escape") {
      const backdrops = document.querySelectorAll(".modal-backdrop");
      if (backdrops.length) {
        backdrops[backdrops.length - 1].remove();
        e.preventDefault();
        return;
      }
    }
    // Cmd/Ctrl+K — focus the Community search (navigating there first if needed).
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (state.nav !== "community") navigate("community");
      focusCommunitySearch();
    }
  });
}

// Window-wide drag & drop: a .js file dragged anywhere over the window raises a
// full-window overlay; dropping opens a dialog to save-only or save & install.
function wireDropZone() {
  const overlay = document.getElementById("drag-overlay");
  const overlayIco = document.getElementById("drag-overlay-ico");
  if (overlayIco && !overlayIco.childNodes.length)
    overlayIco.appendChild(Ico("upload", { size: 40, sw: 1.3 }));

  let dragDepth = 0;
  const draggingFiles = (e) =>
    e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  const hideOverlay = () => {
    dragDepth = 0;
    if (overlay) overlay.hidden = true;
  };

  document.addEventListener("dragenter", (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    if (overlay) overlay.hidden = false;
  });
  document.addEventListener("dragover", (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (e) => {
    if (!draggingFiles(e)) return;
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });
  document.addEventListener("drop", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideOverlay();
    if (!e.dataTransfer) return;
    const files = Array.from(e.dataTransfer.files || []).filter((f) =>
      f.name.toLowerCase().endsWith(".js"),
    );
    if (files.length === 0) {
      if (Array.from(e.dataTransfer.types || []).includes("Files"))
        alert("Only .js files are accepted.");
      return;
    }
    const items = [];
    for (const f of files) {
      try {
        items.push({
          name: f.name.toLowerCase().replace(/[^a-z0-9_.-]/g, "-"),
          code: await f.text(),
        });
      } catch {}
    }
    if (items.length) openDropChoiceModal(items);
  });
}

// Dialog shown after dropping .js files: save to My Scripts only, or also
// install into Affinity via the bridge. Both write to disk first.
function openDropChoiceModal(items) {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  const count = items.length;
  const heading = count === 1 ? t("drop.addOne") : t("drop.addMany", { count });
  const summary =
    count === 1
      ? t("drop.readyOne", { name: items[0].name })
      : t("drop.readyMany", { count });
  bd.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>${escapeHtml(heading)}</h3>
        <button class="icon-btn" id="m-close"></button>
      </div>
      <div class="modal-body">
        <p>${escapeHtml(summary)} ${escapeHtml(t("drop.choice"))}</p>
      </div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-save-only">${escapeHtml(t("drop.saveOnly"))}</button>
        <button class="accent-btn" id="m-save-install">${escapeHtml(t("drop.saveInstall"))}</button>
      </div>
    </div>`;
  bd.querySelector("#m-close").appendChild(Ico("close", { size: 12 }));
  document.body.appendChild(bd);

  const close = () => bd.remove();
  bd.querySelector("#m-close").onclick = close;
  bd.addEventListener("click", (e) => {
    if (e.target === bd) close();
  });

  async function process(install, btn) {
    btn.innerHTML = `<span class="loading">${escapeHtml(t(install ? "action.installing" : "action.saving"))}</span>`;
    bd.querySelectorAll("button").forEach((b) => (b.disabled = true));
    let saved = 0;
    let pushFailed = false;
    for (const it of items) {
      try {
        const r = await window.api.saveLocalScript(it.name, it.code);
        if (r && r.success) {
          saved++;
          if (install) {
            const p = await window.api.pushToMcp(it.name);
            if (!p || !p.success) pushFailed = true;
          }
        }
      } catch {
        pushFailed = true;
      }
    }
    close();
    if (install && pushFailed) {
      alert(
        "Saved locally, but at least one script couldn't be installed into Affinity. Make sure the Affinity bridge (MCP) is running.",
      );
    }
    if (saved && state.nav === "local") renderScreen();
  }

  bd.querySelector("#m-save-only").onclick = (e) =>
    process(false, e.currentTarget);
  bd.querySelector("#m-save-install").onclick = (e) =>
    process(true, e.currentTarget);
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
function scriptFilenameFromInput(input) {
  const base = String(input || "")
    .trim()
    .replace(/\.js$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return base ? `${base}.js` : "";
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

// Popup explaining how contributing works, then copying the script to the
// clipboard and opening a blank GitHub issue to paste into. Shown from the
// per-script Share action (local + Affinity) and the Community "Submit Script"
// button. opts: { filename } | { mcpTitle } | {}.
function openShareModal(opts = {}) {
  const isGeneric = !opts.filename && !opts.mcpTitle;
  const steps = isGeneric
    ? [
        t("share.genericStart"),
        t("share.signIn"),
        t("share.genericDetails"),
        t("share.genericSubmit"),
        t("share.genericFinish"),
      ]
    : [
        t("share.scriptStart"),
        t("share.signIn"),
        t("share.scriptPaste"),
        t("share.scriptPreview"),
        t("share.scriptFinish"),
      ];
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>${escapeHtml(t("share.heading"))}</h3>
        <button class="icon-btn" id="m-close"></button>
      </div>
      <div class="modal-body">
        <p>${escapeHtml(t("share.description"))}</p>
        <ol class="share-steps">${steps.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ol>
      </div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-cancel">${escapeHtml(t("action.cancel"))}</button>
        <button class="accent-btn" id="m-open"><span id="ico-gh"></span> ${escapeHtml(t("share.openIssue"))}</button>
      </div>
    </div>`;
  bd.querySelector("#m-close").appendChild(Ico("close", { size: 12 }));
  bd.querySelector("#ico-gh").appendChild(Ico("github", { size: 13 }));
  document.body.appendChild(bd);

  const close = () => bd.remove();
  bd.querySelector("#m-close").onclick = close;
  bd.querySelector("#m-cancel").onclick = close;
  bd.addEventListener("click", (e) => {
    if (e.target === bd) close();
  });

  bd.querySelector("#m-open").onclick = async (e) => {
    const btn = e.currentTarget;
    if (isGeneric) {
      window.api.openExternalRepo();
      close();
      return;
    }
    btn.disabled = true;
    const r = opts.filename
      ? await window.api.buildShareIssue(opts.filename)
      : await window.api.buildShareIssueMcp(opts.mcpTitle);
    if (!r || !r.success) {
      alert(
        "Couldn't read the script: " + ((r && r.error) || "unknown error"),
      );
      btn.disabled = false;
      return;
    }
    // Always copy the (template-shaped) body and open a blank issue to paste into.
    try {
      await navigator.clipboard.writeText(r.body);
    } catch {}
    window.api.openUrl(r.baseUrl);
    bd.querySelector(".modal-body").innerHTML = `
      <div class="share-done">
        <span class="share-done-ico">✓</span>
        <p>${escapeHtml(t("share.copied"))}</p>
      </div>`;
    bd.querySelector(".modal-foot").innerHTML = `<button class="accent-btn" id="m-done">${escapeHtml(t("action.done"))}</button>`;
    bd.querySelector("#m-done").onclick = close;
  };
}

// Pull the newer community version of a script into the local library.
// Returns true on success. Used by both the top updates panel and the row badge.
async function applyScriptUpdate(update) {
  const r = await window.api.saveCommunityScript(
    update.download_url,
    update.name,
    communityScriptMetadata(update),
  );
  return !!(r && r.success);
}

// Explains an update before applying it: what changes, and the Affinity
// limitation that a script already installed there can't be overwritten or
// deleted (so the user must uninstall the old copy first to avoid a duplicate).
// opts: { heading, versionLine?, isActive?, run: async (install) => boolean }
function openUpdateModal(opts) {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>${escapeHtml(opts.heading)}</h3>
        <button class="icon-btn" id="m-close"></button>
      </div>
      <div class="modal-body">
        <img class="update-illustration" src="assets/updatescript.png" alt="In Affinity, right-click the script in the Scripts panel and delete it, then reinstall">
        ${opts.versionLine ? `<div class="update-ver-line">${opts.versionLine}</div>` : ""}
        <div class="update-note">
          <div class="update-note-title">${escapeHtml(t("update.noteTitle"))}</div>
          <p>${
            opts.isActive
              ? escapeHtml(t("update.activeNote"))
              : escapeHtml(t("update.otherNote"))
          }</p>
        </div>
      </div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-local">${escapeHtml(t("update.saveOnly"))}</button>
        <button class="accent-btn" id="m-install">${escapeHtml(t("update.install"))}</button>
      </div>
    </div>`;
  bd.querySelector("#m-close").appendChild(Ico("close", { size: 12 }));
  document.body.appendChild(bd);

  const close = () => bd.remove();
  bd.querySelector("#m-close").onclick = close;
  bd.addEventListener("click", (e) => {
    if (e.target === bd) close();
  });

  const localBtn = bd.querySelector("#m-local");
  const installBtn = bd.querySelector("#m-install");
  const localLabel = localBtn.textContent;
  const installLabel = installBtn.innerHTML;

  async function go(install, btn) {
    btn.innerHTML = `<span class="loading">${escapeHtml(t(install ? "action.installing" : "action.updating"))}</span>`;
    localBtn.disabled = true;
    installBtn.disabled = true;
    const ok = await opts.run(install);
    if (ok) {
      close();
      renderScreen();
      return;
    }
    alert("Update failed. Make sure the repository is reachable.");
    localBtn.disabled = false;
    installBtn.disabled = false;
    localBtn.textContent = localLabel;
    installBtn.innerHTML = installLabel;
  }

  localBtn.onclick = () => go(false, localBtn);
  installBtn.onclick = () => go(true, installBtn);
}

// Grouped panel listing every local script that has a newer community version,
// with per-script and "Update all" actions. `pending` = [{ it, update, active }].
function renderUpdatesPanel(container, pending) {
  if (!container) return;
  if (!pending.length) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }
  container.hidden = false;
  container.innerHTML = `
    <div class="updates-head">
      <div class="updates-title">
        <span class="updates-badge">${pending.length}</span>
        <span>${escapeHtml(t(pending.length === 1 ? "local.updateAvailable" : "community.updatesAvailable"))}</span>
      </div>
      <button class="accent-btn compact" id="upd-all">${escapeHtml(t("local.updateAll"))}</button>
    </div>
    <div class="updates-list"></div>
  `;

  const list = container.querySelector(".updates-list");
  pending.forEach(({ it, update, active }) => {
    const row = document.createElement("div");
    row.className = "updates-row";
    row.innerHTML = `
      <div class="updates-name">${escapeHtml(it.name)}<span class="row-ext">.js</span></div>
      <div class="updates-ver">
        <span class="updates-ver-old">v${escapeHtml(it.version || "?")}</span>
        <span class="updates-ver-arrow">→</span>
        <span class="updates-ver-new">v${escapeHtml(update.version)}</span>
      </div>
      <button class="gh-btn compact updates-btn">${escapeHtml(t("community.update"))}</button>
    `;
    row.querySelector(".updates-btn").onclick = () =>
      openUpdateModal({
        heading: `Update ${it.name}`,
        versionLine: `<span class="updates-ver-old">v${escapeHtml(it.version || "?")}</span> <span class="updates-ver-arrow">→</span> <span class="updates-ver-new">v${escapeHtml(update.version)}</span>`,
        isActive: active,
        run: async (install) => {
          if (!(await applyScriptUpdate(update))) return false;
          if (install) await window.api.pushToMcp(it.file);
          return true;
        },
      });
    list.appendChild(row);
  });

  container.querySelector("#upd-all").onclick = () =>
    openUpdateModal({
      heading: `Update ${pending.length} script${pending.length === 1 ? "" : "s"}`,
      isActive: pending.some((p) => p.active),
      run: async (install) => {
        let failed = 0;
        for (const { it, update } of pending) {
          if (!(await applyScriptUpdate(update))) {
            failed++;
            continue;
          }
          if (install) {
            const p = await window.api.pushToMcp(it.file);
            if (!p || !p.success) failed++;
          }
        }
        if (failed)
          alert(
            `${failed} update${failed === 1 ? "" : "s"} failed. Make sure the repositories are reachable.`,
          );
        return true;
      },
    });
}

// "Run without install" — execute a script in Affinity right now (via MCP,
// without adding it to the library) and show the console output + a rendered
// preview. opts: { code } (editor buffer) or { downloadUrl } (community), plus
// optional name.
function openRunModal(opts = {}) {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal run-modal">
      <div class="modal-head">
        <h3>${escapeHtml(t("community.runWithoutInstall"))}${opts.name ? ` — ${escapeHtml(opts.name)}` : ""}</h3>
        <button class="icon-btn" id="m-close"></button>
      </div>
      <div class="modal-body">
        <p class="run-note">${escapeHtml(t("run.note"))}</p>
        <div class="run-preview" id="run-preview" hidden></div>
        <div class="run-console-label">${escapeHtml(t("run.consoleOutput"))}</div>
        <pre class="run-console" id="run-console"></pre>
      </div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-rerun">${escapeHtml(t("run.again"))}</button>
        <button class="accent-btn" id="m-done">${escapeHtml(t("action.done"))}</button>
      </div>
    </div>`;
  bd.querySelector("#m-close").appendChild(Ico("close", { size: 12 }));
  document.body.appendChild(bd);

  const close = () => bd.remove();
  bd.querySelector("#m-close").onclick = close;
  bd.querySelector("#m-done").onclick = close;
  bd.addEventListener("click", (e) => {
    if (e.target === bd) close();
  });

  const consoleEl = bd.querySelector("#run-console");
  const previewEl = bd.querySelector("#run-preview");
  const rerunBtn = bd.querySelector("#m-rerun");

  async function run() {
    rerunBtn.disabled = true;
    consoleEl.innerHTML = '<span class="loading">Running in Affinity</span>';
    previewEl.hidden = true;
    previewEl.innerHTML = "";

    const r = opts.downloadUrl
      ? await window.api.runCommunityScript(opts.downloadUrl)
      : await window.api.executeScript(opts.code || "");
    if (!r || !r.success) {
      consoleEl.classList.add("run-error");
      consoleEl.textContent =
        (r && r.error) ||
        "Run failed — make sure Affinity is open and the MCP bridge is running.";
      rerunBtn.disabled = false;
      return;
    }
    consoleEl.classList.remove("run-error");
    consoleEl.textContent =
      r.output && r.output.trim() ? r.output : "(no console output)";

    // Best-effort rendered preview of the active document.
    const p = await window.api.renderActivePreview().catch(() => null);
    if (p && p.success && p.image) {
      previewEl.hidden = false;
      previewEl.innerHTML = `<img src="${p.image}" alt="Rendered preview of the active document">`;
    }
    rerunBtn.disabled = false;
  }

  rerunBtn.onclick = run;
  run();
}

const DEFAULT_COMMUNITY_REPO =
  "https://raw.githubusercontent.com/JiriKrblich/Affinity-Community-Scripts/refs/heads/main/registry.json";

// ---------- App Settings ----------
async function renderAppSettings(root) {
  const screen = document.createElement("div");
  screen.className = "screen app-settings-screen";
  screen.innerHTML = `
    <div class="eyebrow">${escapeHtml(t("nav.preferences"))}</div>
    <h1>${escapeHtml(t("nav.appSettings"))}</h1>
    <p class="subhead">${escapeHtml(t("settings.subtitle"))}</p>
    <nav class="settings-categories" aria-label="${escapeHtml(t("settings.categoriesLabel"))}">
      <button type="button" data-settings-category="general">${escapeHtml(t("settings.general"))}</button>
      <button type="button" data-settings-category="folders">${escapeHtml(t("settings.folders"))}</button>
      <button type="button" data-settings-category="editor">${escapeHtml(t("settings.editor"))}</button>
      <button type="button" data-settings-category="repositories">${escapeHtml(t("settings.repositories"))}</button>
    </nav>
    <section class="settings-card" data-settings-panel="general">
      <h2>${escapeHtml(t("settings.language"))}</h2>
      <p>${escapeHtml(t("settings.languageDescription"))}</p>
      <div class="settings-editor-controls">
        <label>${escapeHtml(t("settings.language"))}
          <select id="settings-language" disabled>
            <option value="en">English</option>
            <option value="cs">Čeština</option>
            <option value="ja">日本語</option>
            <option value="zh-CN">简体中文</option>
            <option value="ko">한국어</option>
            <option value="de">Deutsch</option>
            <option value="fr">Français</option>
            <option value="es">Español</option>
          </select>
        </label>
      </div>
      <p class="settings-error" id="settings-language-error" hidden></p>
    </section>
    <section class="settings-card" data-settings-panel="editor">
      <h2>${escapeHtml(t("settings.editor"))}</h2>
      <p>${escapeHtml(t("settings.editorDescription"))}</p>
      <div class="settings-editor-controls">
        <label>${escapeHtml(t("settings.indentWith"))}
          <select id="settings-indent-style" disabled>
            <option value="spaces">${escapeHtml(t("settings.spaces"))}</option>
            <option value="tabs">${escapeHtml(t("settings.tabs"))}</option>
          </select>
        </label>
        <label>${escapeHtml(t("settings.tabWidth"))}
          <select id="settings-tab-size" disabled>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="3">3</option>
            <option value="4">4</option>
            <option value="5">5</option>
            <option value="6">6</option>
            <option value="7">7</option>
            <option value="8">8</option>
          </select>
        </label>
      </div>
      <p class="settings-error" id="settings-editor-error" hidden></p>
    </section>
    <section class="settings-card" data-settings-panel="folders">
      <h2>${escapeHtml(t("settings.mainFolder"))}</h2>
      <p>${escapeHtml(t("settings.mainFolderDescription"))}</p>
      <div class="settings-path" id="settings-main-path">${escapeHtml(t("common.loading"))}</div>
      <div class="settings-actions">
        <button class="gh-btn" id="settings-open-main">${escapeHtml(t("settings.openFolder"))}</button>
        <button class="gh-btn" id="settings-change-main">${escapeHtml(t("settings.changeFolder"))}</button>
        <button class="gh-btn" id="settings-reset-main">${escapeHtml(t("settings.useDefault"))}</button>
      </div>
    </section>
    <section class="settings-card" data-settings-panel="folders">
      <h2>${escapeHtml(t("settings.watchedFolders"))}</h2>
      <p>${escapeHtml(t("settings.watchedDescription"))}</p>
      <div id="settings-watched-list"></div>
      <button class="gh-btn" id="settings-add-watched">${escapeHtml(t("settings.addWatchedFolder"))}</button>
    </section>
    <section class="settings-card" id="settings-repositories" data-settings-panel="repositories">
      <h2>${escapeHtml(t("settings.repositories"))}</h2>
      <p>${escapeHtml(t("settings.repositoriesDescription"))}</p>
      <div class="add-repo">
        <input id="settings-repo-input" type="text" placeholder="https://github.com/user/repository" aria-label="${escapeHtml(t("settings.repoUrl"))}">
        <button class="accent-btn compact" id="settings-add-repo">${escapeHtml(t("action.add"))}</button>
      </div>
      <div id="settings-repo-list" class="settings-repo-list"></div>
    </section>`;
  root.appendChild(screen);
  const categoryButtons = [...screen.querySelectorAll("[data-settings-category]")];
  const categoryPanels = [...screen.querySelectorAll("[data-settings-panel]")];
  const showCategory = (category) => {
    state.settingsCategory = category;
    categoryButtons.forEach((button) => {
      const selected = button.dataset.settingsCategory === category;
      button.classList.toggle("active", selected);
      button.setAttribute("aria-current", selected ? "page" : "false");
    });
    categoryPanels.forEach((panel) => {
      panel.hidden = panel.dataset.settingsPanel !== category;
    });
  };
  categoryButtons.forEach((button) => {
    button.onclick = () => showCategory(button.dataset.settingsCategory);
  });
  showCategory(state.settingsFocus || state.settingsCategory);
  state.settingsFocus = null;
  const languageSelect = screen.querySelector("#settings-language");
  const languageError = screen.querySelector("#settings-language-error");
  const currentLanguage = await window.api.getAppLanguage();
  if (currentLanguage?.success) {
    languageSelect.value = currentLanguage.data;
    languageSelect.disabled = false;
  } else {
    languageError.textContent = currentLanguage?.error || t("settings.languageLoadError");
    languageError.hidden = false;
  }
  languageSelect.onchange = async () => {
    languageSelect.disabled = true;
    let result;
    try { result = await window.api.setAppLanguage(languageSelect.value); }
    catch (error) { result = { success: false, error: error.message }; }
    if (result?.success) {
      window.location.reload();
    } else {
      languageSelect.value = currentLanguage.data;
      languageError.textContent = result?.error || t("settings.languageSaveError");
      languageError.hidden = false;
      languageSelect.disabled = false;
    }
  };
  const indentStyleSelect = screen.querySelector("#settings-indent-style");
  const tabSizeSelect = screen.querySelector("#settings-tab-size");
  const editorSettingsError = screen.querySelector("#settings-editor-error");
  let savedEditorSettings;
  const editorSettingsResult = await window.api.getEditorSettings();
  if (editorSettingsResult?.success) {
    savedEditorSettings = editorSettingsResult.data;
    indentStyleSelect.value = savedEditorSettings.indentStyle;
    tabSizeSelect.value = String(savedEditorSettings.tabSize);
    indentStyleSelect.disabled = false;
    tabSizeSelect.disabled = false;
  } else {
    editorSettingsError.textContent = editorSettingsResult?.error || "Could not load editor settings.";
    editorSettingsError.hidden = false;
  }
  const saveEditorSettings = async () => {
    indentStyleSelect.disabled = true;
    tabSizeSelect.disabled = true;
    const result = await window.api.setEditorSettings({
      indentStyle: indentStyleSelect.value,
      tabSize: Number(tabSizeSelect.value),
    });
    if (result?.success) {
      savedEditorSettings = result.data;
      editorSettingsError.hidden = true;
    } else {
      indentStyleSelect.value = savedEditorSettings.indentStyle;
      tabSizeSelect.value = String(savedEditorSettings.tabSize);
      editorSettingsError.textContent = result?.error || "Could not save editor settings.";
      editorSettingsError.hidden = false;
    }
    indentStyleSelect.disabled = false;
    tabSizeSelect.disabled = false;
  };
  indentStyleSelect.onchange = saveEditorSettings;
  tabSizeSelect.onchange = saveEditorSettings;
  const repoInput = screen.querySelector("#settings-repo-input");
  const repoAdd = screen.querySelector("#settings-add-repo");
  const repoList = screen.querySelector("#settings-repo-list");
  const displayRepo = (url) => {
    const match = url.match(/raw\.githubusercontent\.com\/([^/]+\/[^/]+)/);
    return match ? match[1] : url;
  };
  async function refreshRepos() {
    const result = await window.api.getRepos();
    if (!screen.isConnected) return;
    repoList.replaceChildren();
    if (!result?.success) {
      repoList.textContent = result?.error || "Could not load repositories.";
      return;
    }
    for (const url of result.data) {
      const row = document.createElement("div");
      row.className = "repo-row";
      const name = document.createElement("div");
      name.className = "name";
      name.textContent = displayRepo(url);
      row.appendChild(name);
      if (url === DEFAULT_COMMUNITY_REPO) {
        const kind = document.createElement("span");
        kind.className = "kind";
        kind.textContent = t("settings.defaultRepo");
        row.appendChild(kind);
      } else {
        const remove = document.createElement("button");
        remove.className = "gh-btn compact danger";
        remove.textContent = t("action.remove");
        remove.onclick = async () => {
          if (!confirm(`Remove ${displayRepo(url)}?`)) return;
          remove.disabled = true;
          const result = await window.api.removeRepo(url);
          if (!result?.success) {
            remove.disabled = false;
            alert(result?.error || "Could not remove repository.");
            return;
          }
          refreshRepos();
        };
        row.appendChild(remove);
      }
      repoList.appendChild(row);
    }
  }
  async function addRepo() {
    const url = repoInput.value.trim();
    if (!url) return;
    repoAdd.disabled = true;
    repoAdd.textContent = t("settings.adding");
    const result = await window.api.addRepo(url);
    repoAdd.disabled = false;
    repoAdd.textContent = t("action.add");
    if (!result?.success) return alert(result?.error || "Could not add repository.");
    repoInput.value = "";
    refreshRepos();
  }
  repoAdd.onclick = addRepo;
  repoInput.onkeydown = (event) => { if (event.key === "Enter") addRepo(); };
  refreshRepos();

  async function refresh() {
    const result = await window.api.getScriptFolders();
    if (!result?.success || !screen.isConnected) return;
    const { primary, default: defaultPath, watched } = result.data;
    screen.querySelector("#settings-main-path").textContent = primary;
    screen.querySelector("#settings-reset-main").disabled = primary === defaultPath;
    const list = screen.querySelector("#settings-watched-list");
    list.innerHTML = "";
    if (!watched.length) {
      list.innerHTML = `<p class="settings-empty">${escapeHtml(t("settings.noWatchedFolders"))}</p>`;
    }
    for (const folder of watched) {
      const row = document.createElement("div");
      row.className = "settings-folder-row";
      const label = document.createElement("span");
      label.textContent = folder;
      const open = document.createElement("button");
      open.className = "gh-btn compact";
      open.textContent = t("action.open");
      open.onclick = async () => {
        const r = await window.api.openScriptFolder(folder);
        if (!r?.success) alert(r?.error || "Could not open folder.");
      };
      const remove = document.createElement("button");
      remove.className = "gh-btn compact";
      remove.textContent = t("action.remove");
      remove.onclick = async () => {
        const r = await window.api.removeWatchedFolder(folder);
        if (!r?.success) alert(r?.error || "Could not remove folder.");
        else refresh();
      };
      row.append(label, open, remove);
      list.appendChild(row);
    }
    screen.querySelector("#settings-open-main").onclick = async () => {
      const r = await window.api.openScriptFolder();
      if (!r?.success) alert(r?.error || "Could not open folder.");
    };
    screen.querySelector("#settings-change-main").onclick = async () => {
      const chosen = await window.api.chooseScriptFolder();
      if (!chosen?.success) return;
      const plan = await window.api.planScriptFolderChange(chosen.path);
      if (!plan?.success) return alert(plan?.error || "Could not inspect folder.");
      if (!plan.data.same) openFolderChangeModal(plan.data, refresh);
    };
    screen.querySelector("#settings-reset-main").onclick = async () => {
      const plan = await window.api.planScriptFolderChange(defaultPath);
      if (!plan?.success) return alert(plan?.error || "Could not inspect default folder.");
      if (!plan.data.same) openFolderChangeModal(plan.data, refresh);
    };
    screen.querySelector("#settings-add-watched").onclick = async () => {
      const chosen = await window.api.chooseScriptFolder();
      if (!chosen?.success) return;
      const r = await window.api.addWatchedFolder(chosen.path);
      if (!r?.success) alert(r?.error || "Could not add folder.");
      else refresh();
    };
  }
  refresh();
}

function openFolderChangeModal(plan, onDone) {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal folder-change-modal">
      <div class="modal-head"><h3>${escapeHtml(t("folder.changeHeading"))}</h3><button class="icon-btn" id="m-close"></button></div>
      <div class="modal-body">
        <p class="settings-path">${escapeHtml(plan.target)}</p>
        <p>${escapeHtml(t("folder.counts", { source: plan.sourceCount, target: plan.targetCount }))}</p>
        ${plan.sourceError ? `<p class="settings-error">${escapeHtml(t("folder.sourceUnavailable", { error: plan.sourceError }))}</p>` : ""}
        <label class="folder-choice"><input type="radio" name="folder-action" value="move" ${plan.sourceError ? "disabled" : "checked"}> ${escapeHtml(t("folder.move"))}</label>
        <label class="folder-choice"><input type="radio" name="folder-action" value="keep" ${plan.sourceError ? "checked" : ""}> ${escapeHtml(t("folder.keep"))}</label>
        <p>${escapeHtml(t("folder.keepNote"))}</p>
        <div id="folder-conflicts" ${plan.conflicts.length ? "" : "hidden"}>
          <h4>${escapeHtml(t("folder.conflicts"))}</h4>
          <p>${escapeHtml(t("folder.conflictHelp"))}</p>
          ${plan.conflicts.map((name, i) => `<div class="folder-conflict-row"><span>${escapeHtml(name)}</span><select data-index="${i}">
            <option value="keep">${escapeHtml(t("folder.keepExisting"))}</option>
            <option value="rename">${escapeHtml(t("folder.keepBoth"))}</option>
            <option value="replace">${escapeHtml(t("folder.replace"))}</option>
          </select></div>`).join("")}
        </div>
      </div>
      <div class="modal-foot"><button class="gh-btn" id="m-cancel">${escapeHtml(t("action.cancel"))}</button><button class="accent-btn" id="m-apply">${escapeHtml(t("settings.changeFolder"))}</button></div>
    </div>`;
  document.body.appendChild(bd);
  const close = () => bd.remove();
  bd.querySelector("#m-close").appendChild(Ico("close", { size: 12 }));
  bd.querySelector("#m-close").onclick = close;
  bd.querySelector("#m-cancel").onclick = close;
  bd.addEventListener("click", (e) => { if (e.target === bd) close(); });
  const conflicts = bd.querySelector("#folder-conflicts");
  bd.querySelectorAll('[name="folder-action"]').forEach((radio) => {
    radio.onchange = () => { conflicts.hidden = radio.value === "keep" && radio.checked; };
  });
  bd.querySelector("#m-apply").onclick = async (e) => {
    const button = e.currentTarget;
    button.disabled = true;
    button.textContent = t("folder.changing");
    const move = bd.querySelector('[name="folder-action"]:checked').value === "move";
    const choices = {};
    bd.querySelectorAll("[data-index]").forEach((select) => {
      choices[plan.conflicts[Number(select.dataset.index)]] = select.value;
    });
    const result = await window.api.applyScriptFolderChange(plan.target, move, choices);
    if (!result?.success) {
      button.disabled = false;
      button.textContent = t("settings.changeFolder");
      alert(result?.error || "Could not change scripts folder.");
      return;
    }
    close();
    onDone();
    if (result.data.leftBehind.length) alert(`${result.data.leftBehind.length} script(s) remain in the old folder, which is now watched.`);
  };
}

// ---------- My Scripts screen ----------

async function renderLocal(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `
    <div class="eyebrow">${escapeHtml(t("nav.library"))}</div>
    <div class="screen-header"><h1>${escapeHtml(t("nav.myScripts"))}</h1><button class="gh-btn compact" id="local-open-folder">${escapeHtml(t("settings.openFolder"))}</button></div>
    <p class="subhead" id="local-subhead">${escapeHtml(t("common.loading"))}</p>
    <div id="local-status"></div>
    <div id="local-errors"></div>
    <div class="search-bar" style="margin-bottom:16px;">
      <div class="search-wrap">
        <span id="local-search-ico"></span>
        <input id="local-search" type="text" placeholder="${escapeHtml(t("local.searchPlaceholder"))}" />
      </div>
    </div>
    <div class="cat-tabs" id="local-tabs"></div>
    <div class="updates-panel" id="local-updates" hidden></div>
    <div id="local-content"></div>
  `;
  root.appendChild(screen);
  screen.querySelector("#local-open-folder").onclick = async () => {
    const result = await window.api.openScriptFolder();
    if (!result?.success) alert(result?.error || "Could not open scripts folder.");
  };

  // Skeleton rows while data loads (replaced once the tab content is built).
  screen.querySelector("#local-content").innerHTML =
    `<div class="table">${Array.from({ length: 6 }).map(localSkeletonRow).join("")}</div>`;

  // Fetch local + bridge + community in parallel — bridge drives Active/Paused state,
  // community drives Update-available indication.
  const [localRes, bridgeRes, commRes, watchedRes] = await Promise.all([
    window.api.listLocalScripts(),
    window.api.listMcpScripts().catch(() => ({ success: false })),
    window.api.listCommunityScripts().catch(() => ({ success: false })),
    window.api.listWatchedScripts().catch(() => ({ success: false, data: [], errors: [] })),
  ]);
  if (!localRes.success) {
    screen.querySelector("#local-errors").innerHTML =
      `<p class="settings-error">Main scripts folder unavailable: ${escapeHtml(localRes.error || "Unknown error")}. Change it in App Settings.</p>`;
  }
  const items = localRes.success ? localRes.data : [];
  const watchedItems = watchedRes?.data || [];
  const totalBytes = items.reduce((a, b) => a + b.size, 0);
  updateNavCount("local", items.length + watchedItems.length);

  const favRes = await window.api
    .getFavorites()
    .catch(() => ({ success: false }));
  state.favorites = new Set(favRes && favRes.success ? favRes.data : []);

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

  screen.querySelector("#local-subhead").textContent = t("local.summary", {
    count: items.length, size: fmtBytes(totalBytes),
  });
  const statusEl = screen.querySelector("#local-status");
  if (bridgeOnline) statusEl.remove();
  else {
    statusEl.className = "settings-error";
    statusEl.textContent = t("affinityStatus.offlineMyScripts");
  }

  // Grouped "updates available" panel — data only; painted per active tab.
  const pendingUpdates = items
    .map((it) => ({ it, update: updateFor(it), active: bridgeOnline && isActive(it) }))
    .filter((x) => x.update);

  // Scripts in Affinity that aren't in the local library ("Just in Affinity" tab).
  const bridgeTitleList =
    bridgeOnline && typeof bridgeRes.data === "string"
      ? bridgeRes.data.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
      : [];
  const localStems = new Set();
  for (const it of items) {
    localStems.add(it.file.replace(/\.js$/i, "").toLowerCase());
    localStems.add((it.name || "").toLowerCase());
  }
  for (const it of watchedItems) {
    localStems.add(it.file.replace(/\.js$/i, "").toLowerCase());
    localStems.add((it.name || "").toLowerCase());
  }
  const isLocalTitle = (t) =>
    localStems.has(t.toLowerCase().replace(/[^a-z0-9_-]/g, "-")) ||
    localStems.has(t.toLowerCase());
  const orphans = bridgeTitleList.filter((t) => !isLocalTitle(t));

  // Descriptions aren't in the bridge list; read + parse each script's header
  // lazily and cache it so tab-switching doesn't re-fetch.
  const orphanMetaCache = new Map();
  function fillOrphanDescription(title, nameCell) {
    const apply = (meta) => {
      if (meta && meta.description) {
        const desc = document.createElement("div");
        desc.className = "row-desc";
        desc.textContent = meta.description;
        nameCell.appendChild(desc);
      }
    };
    if (orphanMetaCache.has(title)) return apply(orphanMetaCache.get(title));
    window.api.readMcpMetadata(title).then((r) => {
      const meta = r && r.success ? r.data : null;
      orphanMetaCache.set(title, meta);
      apply(meta);
    });
  }

  const tabsEl = screen.querySelector("#local-tabs");
  const contentEl = screen.querySelector("#local-content");
  const updatesEl = screen.querySelector("#local-updates");
  const matchesLocalQuery = (it, query) =>
    !query || [it.name, it.description, it.file].some((value) =>
      String(value || "").toLowerCase().includes(query));

  function renderLocalTabs() {
    const defs = [
      { id: "local", label: t("local.tabLocal"), count: items.length },
      { id: "watched", label: t("local.tabWatched"), count: watchedItems.length },
      { id: "affinity", label: t("local.tabAffinity"), count: orphans.length },
    ];
    tabsEl.innerHTML = "";
    for (const d of defs) {
      const btn = document.createElement("button");
      btn.className = "cat-tab" + (state.localTab === d.id ? " active" : "");
      btn.innerHTML = `<span>${escapeHtml(d.label)}</span><span class="count">${d.count}</span>`;
      btn.onclick = () => {
        state.localTab = d.id;
        renderLocalTabs();
        paintLocalTab();
      };
      tabsEl.appendChild(btn);
    }
  }

  function paintLocalTab() {
    // The updates panel is about local scripts, so only on the My Scripts tab.
    const query = state.localQuery.trim().toLowerCase();
    renderUpdatesPanel(
      updatesEl,
      state.localTab === "local"
        ? pendingUpdates.filter(({ it }) => matchesLocalQuery(it, query))
        : [],
    );
    contentEl.innerHTML = "";
    if (state.localTab === "affinity") buildAffinityOnly(contentEl);
    else if (state.localTab === "watched") buildWatchedTable(contentEl);
    else buildLocalTable(contentEl);
  }

  function buildWatchedTable(container) {
    const errors = watchedRes?.errors || [];
    for (const issue of errors) {
      const warning = document.createElement("p");
      warning.className = "settings-error";
      warning.textContent = `Cannot read ${issue.folder}: ${issue.error}`;
      container.appendChild(warning);
    }
    const q = state.localQuery.trim().toLowerCase();
    const list = watchedItems.filter((it) =>
      !q || [it.name, it.file, it.folder, it.description].some((s) => String(s || "").toLowerCase().includes(q)));
    const table = document.createElement("div");
    table.className = "table watched-table";
    table.innerHTML = `<div class="table-row header"><div class="col">${escapeHtml(t("local.status"))}</div><div class="col">${escapeHtml(t("local.name"))}</div><div class="col">${escapeHtml(t("local.modified"))}</div><div class="col">${escapeHtml(t("local.size"))}</div><div class="col">${escapeHtml(t("local.folder"))}</div></div>`;
    if (!list.length) {
      const row = document.createElement("div");
      row.className = "table-row";
      row.textContent = watchedItems.length ? "No scripts match your search." : "No scripts in watched folders. Add a folder in App Settings.";
      table.appendChild(row);
    }
    for (const it of list) {
      const row = document.createElement("div");
      row.className = "table-row";
      const active = isActive(it);
      const dotCell = document.createElement("div");
      const dot = document.createElement("button");
      dot.className = "install-dot" + (active ? " on" : "");
      dot.title = active ? "Installed in Affinity" : "Install to Affinity";
      dot.disabled = active || !bridgeOnline;
      dot.onclick = async () => {
        dot.disabled = true;
        const result = await window.api.pushWatchedScript(it.folder, it.file);
        if (result?.success) renderScreen();
        else { alert(result?.error || "Install failed."); dot.disabled = false; }
      };
      dotCell.appendChild(dot);
      const name = document.createElement("div");
      name.className = "row-name";
      name.textContent = it.name;
      if (it.description) {
        const description = document.createElement("div");
        description.className = "row-desc";
        description.textContent = it.description;
        name.appendChild(description);
      }
      const modified = document.createElement("div");
      modified.className = "row-meta";
      modified.textContent = fmtRel(it.modified);
      const size = document.createElement("div");
      size.className = "row-meta";
      size.textContent = fmtBytes(it.size);
      const folder = document.createElement("button");
      folder.className = "detail-link";
      folder.textContent = it.folder;
      folder.title = "Open watched folder";
      folder.onclick = async () => {
        const result = await window.api.openScriptFolder(it.folder);
        if (!result?.success) alert(result?.error || "Could not open folder.");
      };
      row.append(dotCell, name, modified, size, folder);
      table.appendChild(row);
    }
    container.appendChild(table);
  }

  function buildAffinityOnly(container) {
    // Same table visual as the Local tab, but these live only in Affinity:
    // blue dot = active in Affinity, and the only action is Download to library.
    const table = document.createElement("div");
    table.className = "table affinity-table";
    const hdr = document.createElement("div");
    hdr.className = "table-row header";
    hdr.innerHTML = `<div class="col">${escapeHtml(t("local.status"))}</div><div class="col">${escapeHtml(t("local.name"))}</div><div class="col">${escapeHtml(t("local.actions"))}</div>`;
    table.appendChild(hdr);

    const emptyRow = (msg) => {
      const empty = document.createElement("div");
      empty.className = "table-row";
      empty.style.cssText =
        "padding:48px 20px; color:var(--text-faint); display:block;";
      empty.textContent = msg;
      table.appendChild(empty);
      container.appendChild(table);
    };
    if (!bridgeOnline)
      return emptyRow(
        t("affinityStatus.offlineMyScripts"),
      );
    if (orphans.length === 0)
      return emptyRow("Every script in Affinity is already in your library.");

    const q = state.localQuery.trim().toLowerCase();
    const list = q
      ? orphans.filter((t) => t.toLowerCase().includes(q))
      : orphans;
    if (list.length === 0)
      return emptyRow(`No scripts match "${state.localQuery.trim()}".`);

    for (const t of list) {
      const row = document.createElement("div");
      row.className = "table-row";

      const dotCell = document.createElement("div");
      const dot = document.createElement("button");
      dot.className = "install-dot on affinity";
      dot.title = "Active in Affinity (not in your library)";
      dotCell.appendChild(dot);

      const nameCell = document.createElement("div");
      const nameLine = document.createElement("div");
      nameLine.className = "row-name";
      nameLine.innerHTML = `${escapeHtml(t)}<span class="row-ext">.js</span>`;
      nameCell.appendChild(nameLine);
      fillOrphanDescription(t, nameCell);

      const actions = document.createElement("div");
      actions.className = "actions";

      const dlLocal = document.createElement("button");
      dlLocal.className = "icon-btn";
      dlLocal.title = "Download to My Scripts";
      dlLocal.appendChild(Ico("download", { size: 13, sw: 1.4 }));
      dlLocal.onclick = (e) => {
        e.stopPropagation();
        openDownloadModal(t);
      };

      const dlFolder = document.createElement("button");
      dlFolder.className = "icon-btn";
      dlFolder.title = "Download to a folder";
      dlFolder.appendChild(Ico("folder", { size: 13, sw: 1.4 }));
      dlFolder.onclick = async (e) => {
        e.stopPropagation();
        dlFolder.disabled = true;
        const r = await window.api.exportMcpToDisk(t);
        dlFolder.disabled = false;
        if (r && !r.success && r.error && r.error !== "Cancelled") {
          alert("Export failed: " + r.error);
        }
      };

      const share = document.createElement("button");
      share.className = "icon-btn";
      share.title = "Share to community repo (GitHub)";
      share.appendChild(Ico("github", { size: 13, sw: 1.4 }));
      share.onclick = (e) => {
        e.stopPropagation();
        openShareModal({ mcpTitle: t });
      };

      actions.append(dlLocal, dlFolder, share);
      row.append(dotCell, nameCell, actions);
      table.appendChild(row);
    }
    container.appendChild(table);
  }

  function buildLocalTable(container) {
    const q = state.localQuery.trim().toLowerCase();
    let list = q
      ? items.filter((it) => matchesLocalQuery(it, q))
      : items.slice();
    // Favorites float to the top (stable sort keeps the rest in place).
    list.sort(
      (a, b) =>
        (state.favorites.has(scriptStem(b.file)) ? 1 : 0) -
        (state.favorites.has(scriptStem(a.file)) ? 1 : 0),
    );

    const table = document.createElement("div");
    table.className = "table";
    const hdr = document.createElement("div");
    hdr.className = "table-row header";
    hdr.innerHTML = `<div class="col">${escapeHtml(t("local.status"))}</div><div class="col">${escapeHtml(t("local.name"))}</div><div class="col">${escapeHtml(t("local.modified"))}</div><div class="col">${escapeHtml(t("local.size"))}</div><div class="col">${escapeHtml(t("local.actions"))}</div>`;
    table.appendChild(hdr);

    if (list.length === 0) {
      const empty = document.createElement("div");
      empty.className = "table-row";
      empty.style.display = "block";
      empty.style.padding = "48px 20px";
      empty.style.color = "var(--text-faint)";
      empty.textContent =
        items.length === 0
          ? "No scripts yet. Click Add Script to add one."
          : `No scripts match "${state.localQuery.trim()}".`;
      table.appendChild(empty);
      container.appendChild(table);
      return;
    }

    for (const it of list) {
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
    const revision = it.file.match(/-([a-f0-9]{7})(?:-\d+)?\.js$/i);
    if (revision) {
      const badge = document.createElement("span");
      badge.className = "tag";
      badge.textContent = `rev ${revision[1]}`;
      badge.title = it.file;
      nameLine.appendChild(badge);
    }
    if (/-backup-\d+(?:-\d+)?\.js$/i.test(it.file)) {
      const badge = document.createElement("span");
      badge.className = "tag";
      badge.textContent = "Backup";
      badge.title = it.file;
      nameLine.appendChild(badge);
    }

    const favKey = scriptStem(it.file);
    const isFav = state.favorites.has(favKey);
    const fav = document.createElement("button");
    fav.className = "row-fav" + (isFav ? " active" : "");
    fav.title = isFav ? "Remove from favorites" : "Add to favorites";
    fav.appendChild(Ico("star", { size: 13, sw: 1.4 }));
    fav.onclick = async (e) => {
      e.stopPropagation();
      if (await toggleScriptFavorite(favKey)) paintLocalTab();
    };

    const update = updateFor(it);
    if (update) {
      const upBadge = document.createElement("button");
      upBadge.className = "tag tag-warn tag-clickable";
      upBadge.innerHTML = `\u2191 Update <span style="opacity:.7; margin-left:4px;">${escapeHtml(update.version)}</span>`;
      upBadge.title = `Update to v${update.version}`;
      upBadge.onclick = (e) => {
        e.stopPropagation();
        openUpdateModal({
          heading: `Update ${it.name}`,
          versionLine: `<span class="updates-ver-old">v${escapeHtml(it.version || "?")}</span> <span class="updates-ver-arrow">→</span> <span class="updates-ver-new">v${escapeHtml(update.version)}</span>`,
          isActive: active,
          run: async (install) => {
            if (!(await applyScriptUpdate(update))) return false;
            if (install) await window.api.pushToMcp(it.file);
            return true;
          },
        });
      };
      nameLine.appendChild(upBadge);
    }
    const nameHead = document.createElement("div");
    nameHead.className = "row-name-head";
    nameHead.append(fav, nameLine);
    nameCell.appendChild(nameHead);
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
      mkBtn("tag", "Rename file", (e) => {
        e.stopPropagation();
        openRenameLocalModal(it);
      }),
    );
    actions.appendChild(
      mkBtn("download", "Export to disk", (e) => {
        e.stopPropagation();
        window.api.exportToDisk(it.file);
      }),
    );
    actions.appendChild(
      mkBtn("github", "Share to community repo (GitHub)", (e) => {
        e.stopPropagation();
        openShareModal({ filename: it.file });
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
    container.appendChild(table);
  }

  screen
    .querySelector("#local-search-ico")
    .appendChild(Ico("search", { size: 13 }));
  const localSearch = screen.querySelector("#local-search");
  localSearch.value = state.localQuery;
  localSearch.oninput = (e) => {
    state.localQuery = e.target.value;
    paintLocalTab();
  };

  renderLocalTabs();
  paintLocalTab();
}

// ---------- Community Scripts screen ----------

// A single shimmering placeholder card shown while community registries load.
function communitySkeletonCard() {
  return `
    <div class="c-card c-skeleton">
      <div class="sk sk-preview"></div>
      <div class="sk sk-title"></div>
      <div class="sk sk-text"></div>
      <div class="sk sk-text sk-text-short"></div>
      <div class="sk sk-foot"></div>
    </div>`;
}

// Placeholder row for the My Scripts table (matches the 5-column grid).
function localSkeletonRow() {
  return `
    <div class="table-row c-skeleton">
      <div><div class="sk" style="width:14px;height:14px;border-radius:50%;"></div></div>
      <div><div class="sk" style="width:50%;height:13px;"></div></div>
      <div><div class="sk" style="width:65%;height:11px;"></div></div>
      <div><div class="sk" style="width:55%;height:11px;"></div></div>
      <div><div class="sk" style="width:75%;height:11px;"></div></div>
    </div>`;
}

// Turn a per-repo failure from the backend into a human message that says *why*.
function communityErrorMessage(e) {
  const who = e.isDefault ? "Main community repository" : "A repository";
  const map = {
    unreachable: {
      title: `${who} can't be reached`,
      body: "The registry couldn't be downloaded — the server is unreachable. Check your internet connection and that the repository URL is correct.",
    },
    unavailable: {
      title: `${who}'s registry isn't available`,
      body: "The server responded, but the registry file wasn't found there. Make sure the URL points to a raw registry.json that exists.",
    },
    "invalid-json": {
      title: `${who} has an invalid registry.json`,
      body: "The registry was downloaded, but its JSON syntax is invalid, so it couldn't be parsed. Validate the JSON and fix the syntax error shown below.",
    },
  };
  const m = map[e.reason] || {
    title: `${who} couldn't be loaded`,
    body: "The repository couldn't be loaded.",
  };
  return { ...m, url: e.url, detail: e.detail };
}

// Render (or clear) the error banner above the community grid.
function renderCommunityErrors(container, res) {
  if (!container) return;
  const errors = (res && res.errors) || [];
  const hardFail = res && res.success === false;
  if (!hardFail && errors.length === 0) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  const messages = [];
  if (hardFail) {
    messages.push({
      title: "Couldn't load community scripts",
      body: (res && res.error) || "An unknown error occurred.",
      url: "",
      detail: "",
    });
  }
  for (const e of errors) messages.push(communityErrorMessage(e));

  container.hidden = false;
  container.innerHTML = messages
    .map(
      (m) => `
      <div class="community-error">
        <div class="community-error-ico">!</div>
        <div class="community-error-text">
          <div class="community-error-title">${escapeHtml(m.title)}</div>
          <div class="community-error-body">${escapeHtml(m.body)}</div>
          ${m.url ? `<div class="community-error-url">${escapeHtml(m.url)}</div>` : ""}
          ${m.detail ? `<div class="community-error-detail">${escapeHtml(m.detail)}</div>` : ""}
        </div>
      </div>`,
    )
    .join("");
}

async function renderCommunity(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `
    <div class="community-head">
      <div class="eyebrow">${escapeHtml(t("nav.discover"))}</div>
      <div class="screen-header">
        <div>
          <h1 style="margin-bottom:6px">${escapeHtml(t("community.heading"))}</h1>
          <p class="subhead" id="c-summary" style="margin:0">—</p>
        </div>
        <div class="actions">
          <button class="gh-btn compact" id="btn-community-source"><span id="ico-src"></span> ${escapeHtml(t("community.source"))}</button>
          <button class="gh-btn compact" id="btn-community-settings"><span id="ico-gear"></span> ${escapeHtml(t("community.manageRepos"))}</button>
          <button class="accent-btn compact" id="btn-community-submit"><span id="ico-plus"></span> ${escapeHtml(t("community.submitScript"))}</button>
        </div>
      </div>
    </div>

    <div class="community-sticky">
      <div class="search-bar">
        <div class="search-wrap">
          <span id="c-search-icon"></span>
          <input id="c-search" type="text" placeholder="${escapeHtml(t("community.searchPlaceholder"))}" />
          <span class="kbd">⌘K</span>
        </div>
        <div class="sort">
          <select id="c-library-filter" aria-label="${escapeHtml(t("community.filterLabel"))}">
            <option value="all">${escapeHtml(t("community.allStates"))}</option>
            <option value="present">${escapeHtml(t("community.inLibrary"))}</option>
            <option value="missing">${escapeHtml(t("community.notInLibrary"))}</option>
            <option value="update">${escapeHtml(t("community.updatesAvailable"))}</option>
          </select>
        </div>
        <div class="sort">
          <select id="c-sort">
            <option value="recent">${escapeHtml(t("community.recentlyAdded"))}</option>
            <option value="name">A — Z</option>
            <option value="category">${escapeHtml(t("community.category"))}</option>
            <option value="author">${escapeHtml(t("community.author"))}</option>
          </select>
        </div>
      </div>

      <div class="cat-tabs" id="c-tabs"></div>
    </div>

    <div class="community-errors" id="c-errors" hidden></div>

    <div class="community-grid" id="c-grid">
      <section class="community-carousel" id="c-featured" hidden>
        <div class="cc-viewport">
          <div class="cc-track" id="c-featured-track"></div>
          <button class="cc-arrow cc-prev" id="cc-prev" title="${escapeHtml(t("community.previous"))}"></button>
          <button class="cc-arrow cc-next" id="cc-next" title="${escapeHtml(t("community.next"))}"></button>
        </div>
        <div class="cc-dots" id="c-featured-dots"></div>
      </section>
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
  screen.querySelector("#btn-community-settings").onclick = () => {
    state.settingsFocus = "repositories";
    navigate("app-settings");
  };
  screen.querySelector("#btn-community-submit").onclick = () =>
    openShareModal({});

  // Skeleton placeholders while the registries load (replaced by paint()).
  screen.querySelector("#c-grid").insertAdjacentHTML(
    "beforeend",
    Array.from({ length: 8 }).map(communitySkeletonCard).join(""),
  );

  const res = await window.api.listCommunityScripts(true);
  const scripts = res && res.success ? res.data || [] : [];
  renderCommunityErrors(screen.querySelector("#c-errors"), res);
  const favoritesRes = await window.api.getFavorites();
  state.favorites = new Set(
    favoritesRes && favoritesRes.success ? favoritesRes.data : [],
  );

  // Cross-reference the local library so each card knows its state:
  //   install    — not in the library yet
  //   installed  — in the library at the same/newer version (grey, no action)
  //   update     — in the library but the community has a newer version (orange)
  // Watched folders count as library presence, but updates are applied only to
  // scripts in the main writable folder.
  const [localRes, watchedRes] = await Promise.all([
    window.api.listLocalScripts().catch(() => ({ success: false })),
    window.api.listWatchedScripts().catch(() => ({ success: false })),
  ]);
  const localByStem = new Map();
  const indexLocal = (it) => {
    localByStem.set(it.file.replace(/\.js$/i, "").toLowerCase(), it);
    if (it.name)
      localByStem.set(it.name.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), it);
  };
  if (watchedRes?.success && Array.isArray(watchedRes.data)) {
    for (const it of watchedRes.data) indexLocal({ ...it, watched: true });
  }
  if (localRes && localRes.success && Array.isArray(localRes.data)) {
    for (const it of localRes.data) indexLocal(it);
  }
  function communityInstallState(s) {
    const stem = (s.name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const local = localByStem.get(stem);
    if (!local) return "install";
    if (local.watched) return "installed";
    if (s.version && local.version && cmpVer(local.version, s.version) < 0)
      return "update";
    return "installed";
  }
  // Button appearance for a community script's install state.
  function communityBtnSpec(s) {
    if (s._unavailableReason)
      return { cls: " unavailable", label: t("community.scriptUnavailable"), disabled: true };
    const st = communityInstallState(s);
    if (st === "installed")
      return { cls: " installed", label: `✓ ${t("community.inLibrary")}`, disabled: true };
    if (st === "update")
      return { cls: " update", label: `↑ ${t("community.update")}`, disabled: false };
    return { cls: "", label: t("community.install"), disabled: false };
  }

  // Install-button click: install fresh, or (for the update state) open the same
  // explanatory popup as My Scripts so users understand Affinity can't overwrite.
  function handleCommunityInstallClick(s, button) {
    if (s._unavailableReason) return;
    if (communityInstallState(s) !== "update") {
      installCommunityScript(s, button);
      return;
    }
    const stem = (s.name || "").toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    const local = localByStem.get(stem);
    const localVer = (local && local.version) || "?";
    openUpdateModal({
      heading: `Update ${s.name}`,
      versionLine: `<span class="updates-ver-old">v${escapeHtml(localVer)}</span> <span class="updates-ver-arrow">→</span> <span class="updates-ver-new">v${escapeHtml(s.version || "?")}</span>`,
      isActive: false,
      run: async (install) => {
        if (!(await applyScriptUpdate(s))) return false;
        if (install) {
          const fn =
            (s.name || "script").toLowerCase().replace(/[^a-z0-9_-]/g, "-") +
            ".js";
          await window.api.pushToMcp(fn);
        }
        return true;
      },
    });
  }

  updateNavCount("community", scripts.length);
  const repos = new Set(scripts.map((s) => s._source).filter(Boolean));
  screen.querySelector("#c-summary").textContent = t("community.countSummary", {
    scripts: scripts.length, repositories: repos.size,
  });

  // Build category list
  const catCounts = new Map();
  catCounts.set("all", scripts.length);
  catCounts.set("__favorites", 0);
  for (const s of scripts) {
    const c = (s.category || "other").toLowerCase();
    catCounts.set(c, (catCounts.get(c) || 0) + 1);
  }

  const tabs = screen.querySelector("#c-tabs");
  function favoriteCount() {
    return scripts.filter((s) =>
      state.favorites.has(communityFavoriteKey(s)),
    ).length;
  }

  function renderTabs() {
    catCounts.set("__favorites", favoriteCount());
    tabs.innerHTML = "";
    for (const [c, count] of catCounts) {
      const btn = document.createElement("button");
      btn.className =
        "cat-tab" + (state.communityFilter === c ? " active" : "");
      const label =
        c === "all"
          ? t("community.all")
          : c === "__favorites"
            ? t("community.favorites")
            : c[0].toUpperCase() + c.slice(1);
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
  const libraryFilterSel = screen.querySelector("#c-library-filter");
  libraryFilterSel.value = state.communityLibraryFilter;
  libraryFilterSel.onchange = (e) => {
    state.communityLibraryFilter = e.target.value;
    paint();
  };

  const grid = screen.querySelector("#c-grid");
  const carouselEl = screen.querySelector("#c-featured");
  const carouselTrack = screen.querySelector("#c-featured-track");
  const carouselDots = screen.querySelector("#c-featured-dots");
  const carouselPrev = screen.querySelector("#cc-prev");
  const carouselNext = screen.querySelector("#cc-next");
  carouselPrev.appendChild(Ico("chevronL", { size: 18, sw: 1.8 }));
  carouselNext.appendChild(Ico("chevronR", { size: 18, sw: 1.8 }));

  let carouselTimer = null;
  let carouselIndex = 0;
  let carouselCount = 0;

  function goToSlide(i, smooth = true) {
    if (carouselCount === 0) return;
    carouselIndex = (i + carouselCount) % carouselCount;
    carouselTrack.scrollTo({
      left: carouselIndex * carouselTrack.clientWidth,
      behavior: smooth ? "smooth" : "auto",
    });
    updateDots();
  }

  function updateDots() {
    const dots = carouselDots.children;
    for (let i = 0; i < dots.length; i++) {
      dots[i].classList.toggle("active", i === carouselIndex);
    }
  }

  function stopCarouselAutoplay() {
    if (carouselTimer) {
      clearInterval(carouselTimer);
      carouselTimer = null;
    }
  }

  function startCarouselAutoplay() {
    stopCarouselAutoplay();
    if (carouselCount < 2) return;
    carouselTimer = setInterval(() => goToSlide(carouselIndex + 1), 6000);
  }

  // Featured carousel: shown only in the default "All" view with no active
  // search, so it promotes curated picks without cluttering filtered results.
  function paintFeaturedRail() {
    const show =
      state.communityFilter === "all" &&
      state.communityLibraryFilter === "all" &&
      !state.communityQuery.trim();
    const featured = show ? scripts.filter((s) => s._featured) : [];
    stopCarouselAutoplay();
    carouselTrack.innerHTML = "";
    carouselDots.innerHTML = "";
    carouselIndex = 0;
    carouselCount = featured.length;

    if (!featured.length) {
      carouselEl.hidden = true;
      return;
    }
    carouselEl.hidden = false;
    featured.forEach((s, i) => {
      carouselTrack.appendChild(buildFeaturedSlide(s));
      const dot = document.createElement("button");
      dot.className = "cc-dot" + (i === 0 ? " active" : "");
      dot.title = `Go to featured ${i + 1}`;
      dot.onclick = () => {
        goToSlide(i);
        startCarouselAutoplay();
      };
      carouselDots.appendChild(dot);
    });

    const single = featured.length < 2;
    carouselDots.hidden = single;
    carouselPrev.hidden = single;
    carouselNext.hidden = single;
    startCarouselAutoplay();
  }

  function buildFeaturedSlide(s) {
    const slide = document.createElement("div");
    slide.className = "cc-slide";
    const imageUrl = communityPreviewUrl(s);
    const spec = communityBtnSpec(s);
    slide.innerHTML = `
      <div class="cc-media">
        ${
          imageUrl
            ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(s.name || "Featured script preview")}">`
            : `<div class="cc-media-ph">${escapeHtml(t("community.noPreview"))}</div>`
        }
      </div>
      <div class="cc-body">
        <div class="cc-eyebrow">${escapeHtml(t("community.featured"))}</div>
        <h3>${escapeHtml(s.name || "(untitled)")}</h3>
        <div class="cc-author">${escapeHtml(t("community.by", { author: s.author || "community" }))}</div>
        <p class="cc-desc">${escapeHtml(s.description || "")}</p>
        ${s._unavailableReason ? `<p class="community-unavailable-note">${escapeHtml(t("community.scriptUnavailableHelp"))}</p>` : ""}
        <div class="cc-actions">
          <button class="accent-btn compact cc-install${spec.cls}"${spec.disabled ? " disabled" : ""}>${escapeHtml(spec.label)}</button>
          <button class="gh-btn compact cc-details">${escapeHtml(t("community.details"))}</button>
        </div>
      </div>`;

    const media = slide.querySelector(".cc-media img");
    if (media) {
      media.onerror = () => {
        const ph = document.createElement("div");
        ph.className = "cc-media-ph";
        ph.textContent = t("community.previewUnavailable");
        media.replaceWith(ph);
      };
    }

    const installBtn = slide.querySelector(".cc-install");
    if (s._unavailableReason) installBtn.title = t("community.scriptUnavailableHelp");
    installBtn.onclick = (e) => {
      e.stopPropagation();
      handleCommunityInstallClick(s, installBtn);
    };
    slide.querySelector(".cc-details").onclick = (e) => {
      e.stopPropagation();
      openCommunityDetailModal(s);
    };
    slide.onclick = () => openCommunityDetailModal(s);
    return slide;
  }

  carouselPrev.onclick = () => {
    goToSlide(carouselIndex - 1);
    startCarouselAutoplay();
  };
  carouselNext.onclick = () => {
    goToSlide(carouselIndex + 1);
    startCarouselAutoplay();
  };
  carouselEl.onmouseenter = stopCarouselAutoplay;
  carouselEl.onmouseleave = startCarouselAutoplay;
  // Keep the active dot in sync when the user swipes/scrolls the track manually.
  let carouselScrollRaf = null;
  carouselTrack.onscroll = () => {
    if (carouselScrollRaf) cancelAnimationFrame(carouselScrollRaf);
    carouselScrollRaf = requestAnimationFrame(() => {
      const w = carouselTrack.clientWidth || 1;
      carouselIndex = Math.round(carouselTrack.scrollLeft / w);
      updateDots();
    });
  };

  async function toggleCommunityFavorite(script, button) {
    if (button) button.disabled = true;
    const ok = await toggleScriptFavorite(communityFavoriteKey(script));
    if (button) button.disabled = false;
    if (!ok) {
      alert("Favorite update failed");
      return false;
    }
    renderTabs();
    paint();
    return true;
  }

  async function saveCommunityScriptToLibrary(script, button) {
    if (script._unavailableReason) return false;
    if (button) button.disabled = true;
    let r;
    try {
      r = await window.api.saveCommunityScript(
        script.download_url,
        script.name,
        communityScriptMetadata(script),
      );
    } catch (error) {
      r = { success: false, error: error.message };
    }
    if (!r || !r.success) {
      alert((r && r.error) || "Save failed");
      if (button) button.disabled = false;
      return false;
    }
    indexLocal({ file: `${scriptStem(script.name)}.js`, name: script.name, version: script.version });
    paint();
    return true;
  }

  async function installCommunityScript(script, button) {
    if (button) {
      button.innerHTML = '<span class="loading">Installing</span>';
      button.disabled = true;
    }
    let r;
    try {
      r = await window.api.downloadCommunityScript(
        script.download_url,
        script.name,
        communityScriptMetadata(script),
      );
    } catch (error) {
      r = { success: false, error: error.message };
    }
    if (!r || !r.success) {
      alert((r && r.error) || "Download failed");
      if (button) {
        button.textContent = t("community.install");
        button.disabled = false;
      }
      return false;
    }
    if (r.installed === false) {
      alert(`Saved to My Scripts, but installation in Affinity failed: ${r.warning || "Bridge unavailable"}. Retry from My Scripts.`);
    }
    indexLocal({ file: `${scriptStem(script.name)}.js`, name: script.name, version: script.version });
    if (button) {
      button.classList.remove("update");
      button.classList.add("installed");
      button.disabled = true;
      button.textContent = "\u2713 In library";
    }
    paint();
    return true;
  }

  function openCommunityDetailModal(script) {
    const bd = document.createElement("div");
    bd.className = "modal-backdrop";
    const imageUrl = communityPreviewUrl(script);
    const contributors = formatContributors(script.contributors);
    const contactUrl = script.url || script.website || script.link || "";
    const contactEmail = script.email || "";
    const prettyUrl = String(contactUrl)
      .replace(/^https?:\/\//, "")
      .replace(/\/+$/, "");
    const isFavorite = state.favorites.has(
      communityFavoriteKey(script),
    );
    const spec = communityBtnSpec(script);
    bd.innerHTML = `
      <div class="modal community-detail-modal">
        <button class="icon-btn community-detail-close" id="m-close" title="Close"></button>
        <div class="community-detail-scroll">
          <div class="community-detail-preview">
            ${
              imageUrl
                ? `<img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(script.name || "Community script preview")}">`
                : `<div class="community-detail-placeholder">${escapeHtml(t("community.noPreview"))}</div>`
            }
          </div>
          <div class="community-detail-content">
            <div class="community-detail-meta">
              ${script._featured ? `<span class="c-featured-badge">${escapeHtml(t("community.featured"))}</span>` : ""}
              <span class="tag">v${escapeHtml(script.version || "1.0.0")}</span>
              <span class="tag">${escapeHtml((script.category || "other").toLowerCase())}</span>
            </div>
            <h2>${escapeHtml(script.name || "(untitled)")}</h2>
            <div class="community-detail-author">
              <span>${escapeHtml(t("community.by", { author: script.author || "community" }))}</span>
              ${
                contributors
                  ? `<span class="community-detail-separator">|</span><span>contributors: ${escapeHtml(contributors)}</span>`
                  : ""
              }
            </div>
            ${
              contactUrl || contactEmail
                ? `<div class="community-detail-links">
                    ${contactUrl ? `<button class="detail-link" data-href="${escapeHtml(contactUrl)}"><span class="detail-link-ico" data-ico="external"></span>${escapeHtml(prettyUrl)}</button>` : ""}
                    ${contactEmail ? `<button class="detail-link" data-href="mailto:${escapeHtml(contactEmail)}"><span class="detail-link-ico" data-ico="external"></span>${escapeHtml(contactEmail)}</button>` : ""}
                  </div>`
                : ""
            }
            <div class="community-detail-desc">${
              script.description
                ? escapeHtml(script.description)
                : `<span class="community-detail-desc-empty">${escapeHtml(t("community.noDescription"))}</span>`
            }</div>
            ${script._unavailableReason ? `<p class="community-unavailable-note">${escapeHtml(t("community.scriptUnavailableHelp"))}</p>` : ""}
            <div class="community-history">
              <button class="gh-btn" id="m-history">${escapeHtml(t("community.versionHistory"))}</button>
            </div>
          </div>
        </div>
        <div class="community-history-view" id="m-history-view" hidden>
          <div class="community-history-head">
            <button class="gh-btn" id="m-history-back">← Back</button>
            <h2>${escapeHtml(t("community.versionHistory"))}</h2>
            <p>${escapeHtml(script.name || "Community script")}</p>
          </div>
          <div class="community-history-note">Install adds a revision to My Scripts and Affinity. Downgrade replaces the local script after saving a backup; if it is installed in Affinity, remove it there before installing the older version.</div>
          <div id="m-history-list" class="community-history-list"></div>
        </div>
        <div class="modal-foot community-detail-actions">
          <button class="gh-btn" id="m-favorite"></button>
          <button class="gh-btn" id="m-run"><span id="ico-run"></span> ${escapeHtml(t("community.runWithoutInstall"))}</button>
          <button class="gh-btn" id="m-save"></button>
          <button class="accent-btn${spec.cls}" id="m-install"${spec.disabled ? " disabled" : ""}>${escapeHtml(spec.label)}</button>
        </div>
      </div>`;
    document.body.appendChild(bd);

    const close = () => bd.remove();
    bd.querySelector("#m-close").appendChild(Ico("close", { size: 12 }));
    bd.querySelector("#m-close").onclick = close;
    bd.addEventListener("click", (e) => {
      if (e.target === bd) close();
    });

    bd.querySelectorAll(".detail-link").forEach((link) => {
      const ico = link.querySelector(".detail-link-ico");
      if (ico) ico.appendChild(Ico(ico.dataset.ico || "external", { size: 12 }));
      link.onclick = (e) => {
        e.stopPropagation();
        window.api.openUrl(link.dataset.href);
      };
    });

    const previewImg = bd.querySelector(".community-detail-preview img");
    if (previewImg) {
      previewImg.onerror = () => {
        previewImg.replaceWith(
          Object.assign(document.createElement("div"), {
            className: "community-detail-placeholder",
            textContent: "Preview image unavailable",
          }),
        );
      };
    }

    const historyBtn = bd.querySelector("#m-history");
    const historyList = bd.querySelector("#m-history-list");
    const historyView = bd.querySelector("#m-history-view");
    const detailView = bd.querySelector(".community-detail-scroll");
    const detailActions = bd.querySelector(".community-detail-actions");
    bd.querySelector("#m-history-back").onclick = () => {
      historyView.hidden = true;
      detailView.hidden = false;
      detailActions.hidden = false;
    };
    historyBtn.onclick = async () => {
      detailView.hidden = true;
      detailActions.hidden = true;
      historyView.hidden = false;
      historyList.textContent = t("community.loadingHistory");
      const result = await window.api.listScriptHistory(script);
      if (!document.body.contains(bd) || historyView.hidden) return;
      if (!result?.success) {
        historyList.textContent = result?.error || "Could not load history.";
        return;
      }
      const commits = result.data || [];
      if (!commits.length) {
        historyList.textContent = t("community.noRevisions");
        return;
      }
      const local = localByStem.get(scriptStem(script.name));
      historyList.innerHTML = commits.map((commit) => `
        <div class="community-history-row">
          <div><strong>${commit.date && !Number.isNaN(Date.parse(commit.date)) ? escapeHtml(new Date(commit.date).toLocaleDateString()) : "Unknown date"}</strong>
            ${commit.version ? `<span class="tag">v${escapeHtml(commit.version)}</span>` : ""}
            <span class="community-history-sha">${escapeHtml(commit.sha.slice(0, 7))}</span>
            <div class="community-history-message">${escapeHtml(commit.message)}</div>
          </div>
          <div class="community-history-actions">
            <button class="gh-btn" data-sha="${commit.sha}" data-action="copy">${escapeHtml(t("community.saveCopy"))}</button>
            <button class="accent-btn" data-sha="${commit.sha}" data-action="${local ? "downgrade" : "install"}">${local ? "Downgrade" : "Install"}</button>
          </div>
        </div>`).join("");
      historyList.querySelectorAll("[data-sha]").forEach((button) => {
        button.onclick = async () => {
          const action = button.dataset.action;
          if (action === "downgrade" && !confirm("Replace the local script with this revision? A backup will be saved in My Scripts. If the script is installed in Affinity, remove that copy there before installing the older revision.")) return;
          button.disabled = true;
          button.textContent = action === "install" ? "Installing…" : "Saving…";
          const saved = await window.api.saveScriptRevision(script, button.dataset.sha, action, localByStem.get(scriptStem(script.name))?.file);
          if (!saved?.success) {
            button.disabled = false;
            button.textContent = action === "copy" ? "Save copy" : action === "install" ? "Install" : "Downgrade";
            alert(saved?.error || "Could not save revision.");
            return;
          }
          button.textContent = action === "copy" ? "Copy saved" : action === "install" ? (saved.installed ? "Installed" : "Saved locally") : "Downgraded";
          button.title = saved.filename;
          if (action !== "copy") {
            localByStem.set(scriptStem(script.name), { file: saved.filename, version: saved.version });
            paint();
            historyList.querySelectorAll('[data-action="install"]').forEach((installButton) => {
              if (installButton === button) return;
              installButton.dataset.action = "downgrade";
              installButton.textContent = t("community.downgrade");
            });
          }
          if (saved.warning) alert(saved.warning);
        };
      });
    };

    const favoriteBtn = bd.querySelector("#m-favorite");
    const paintFavoriteBtn = () => {
      const active = state.favorites.has(communityFavoriteKey(script));
      favoriteBtn.classList.toggle("active", active);
      favoriteBtn.replaceChildren(Ico("star", { size: 14, sw: 1.35 }));
      favoriteBtn.append(document.createTextNode(active ? " Favorited" : " Favorite"));
      favoriteBtn.title = active ? "Remove from favorites" : "Add to favorites";
    };
    paintFavoriteBtn();
    favoriteBtn.onclick = async () => {
      const updated = await toggleCommunityFavorite(script, favoriteBtn);
      if (updated) paintFavoriteBtn();
    };

    const saveBtn = bd.querySelector("#m-save");
    saveBtn.disabled = !!script._unavailableReason;
    if (script._unavailableReason) saveBtn.title = t("community.scriptUnavailableHelp");
    saveBtn.appendChild(Ico("download", { size: 14, sw: 1.4 }));
    saveBtn.append(document.createTextNode(" Download"));
    saveBtn.onclick = async () => {
      const saved = await saveCommunityScriptToLibrary(script, saveBtn);
      if (!saved) return;
      saveBtn.replaceChildren(Ico("check", { size: 14, sw: 1.6 }));
      saveBtn.append(document.createTextNode(" Downloaded"));
      setTimeout(() => {
        if (!document.body.contains(bd)) return;
        saveBtn.replaceChildren(Ico("download", { size: 14, sw: 1.4 }));
        saveBtn.append(document.createTextNode(" Download"));
        saveBtn.disabled = false;
      }, 1600);
    };

    const runBtn = bd.querySelector("#m-run");
    runBtn.disabled = !!script._unavailableReason;
    runBtn.querySelector("#ico-run").appendChild(Ico("terminal", { size: 13 }));
    runBtn.onclick = () =>
      openRunModal({ downloadUrl: script.download_url, name: script.name });

    const installBtn = bd.querySelector("#m-install");
    if (script._unavailableReason) installBtn.title = t("community.scriptUnavailableHelp");
    installBtn.onclick = () => handleCommunityInstallClick(script, installBtn);
  }

  function paint() {
    paintFeaturedRail();
    const q = state.communityQuery.toLowerCase();
    let filtered = scripts.filter((s) => {
      const libraryState = communityInstallState(s);
      if (state.communityLibraryFilter === "missing" && libraryState !== "install") return false;
      if (state.communityLibraryFilter === "present" && libraryState === "install") return false;
      if (state.communityLibraryFilter === "update" && libraryState !== "update") return false;
      const favoriteKey = communityFavoriteKey(s);
      if (state.communityFilter === "__favorites") {
        if (!state.favorites.has(favoriteKey)) return false;
      } else if (
        state.communityFilter !== "all" &&
        (s.category || "other").toLowerCase() !== state.communityFilter
      ) {
        return false;
      }
      if (!q) return true;
      return [s.name, s.description, s.author].some((v) =>
        (v || "").toLowerCase().includes(q),
      );
    });
    if (state.communitySort === "recent") {
      filtered.sort((a, b) => {
        const orderDiff =
          (b._communityOrder ?? -1) - (a._communityOrder ?? -1);
        if (orderDiff !== 0) return orderDiff;
        return (a.name || "").localeCompare(b.name || "");
      });
    } else {
      filtered.sort((a, b) =>
        (a[state.communitySort] || "").localeCompare(
          b[state.communitySort] || "",
        ),
      );
    }

    grid.innerHTML = "";
    // Featured carousel is the first full-width row of the grid (see CSS
    // grid-column: 1 / -1). It survives the innerHTML reset via its JS ref.
    if (!carouselEl.hidden) grid.appendChild(carouselEl);

    if (filtered.length === 0) {
      const empty = document.createElement("div");
      empty.style.cssText =
        "grid-column: 1/-1; text-align:center; padding:48px; color:var(--text-faint); font-size:13px;";
      if (q) empty.textContent = `No scripts match "${q}" with the current filters.`;
      else if (state.communityLibraryFilter === "missing")
        empty.textContent = t("community.emptyAllSaved");
      else if (state.communityLibraryFilter === "present")
        empty.textContent = t("community.emptyNoneSaved");
      else if (state.communityLibraryFilter === "update")
        empty.textContent = t("community.emptyNoUpdates");
      else if (state.communityFilter === "__favorites")
        empty.textContent = t("community.emptyNoFavorites");
      else empty.textContent = t("community.emptyCategory");
      grid.appendChild(empty);
      return;
    }

    filtered.forEach((s) => grid.appendChild(buildCommunityCard(s)));
  }

  function buildCommunityCard(s) {
      const spec = communityBtnSpec(s);
      const favoriteKey = communityFavoriteKey(s);
      const isFavorite = state.favorites.has(favoriteKey);
      const card = document.createElement("div");
      card.className = "c-card";
      const imageUrl = communityPreviewUrl(s);
      const cardHtml = [];
      if (imageUrl) {
        cardHtml.push(`
          <div class="c-card-preview">
            <img src="${escapeHtml(imageUrl)}" alt="${escapeHtml(s.name || "Community script preview")}" loading="lazy">
          </div>
        `);
      }
      cardHtml.push(`
        <div class="top-row">
          <h3>${escapeHtml(s.name || "(untitled)")}</h3>
          <div class="card-actions">
            ${s._featured ? `<span class="c-featured-badge">${escapeHtml(t("community.featured"))}</span>` : ""}
            <span class="tag">v${escapeHtml(s.version || "1.0.0")}</span>
            <button class="icon-btn c-favorite${isFavorite ? " active" : ""}" title="${isFavorite ? "Remove from favorites" : "Add to favorites"}"></button>
          </div>
        </div>
        <div class="author">${escapeHtml(t("community.by", { author: s.author || "community" }))}</div>
        <div class="desc">${escapeHtml(s.description || "")}</div>
        ${s._unavailableReason ? `<div class="community-unavailable-note">${escapeHtml(t("community.scriptUnavailableHelp"))}</div>` : ""}
        <div class="foot">
          <span class="tag">${escapeHtml((s.category || "other").toLowerCase())}</span>
          <div style="display:flex; gap:6px; align-items:center;">
            <button class="icon-btn c-save" title="Save to My Scripts (don't install)"></button>
            <button class="install-btn${spec.cls}"${spec.disabled ? " disabled" : ""}>${escapeHtml(spec.label)}</button>
          </div>
        </div>
      `);
      card.innerHTML = cardHtml.join("");

      const previewImg = card.querySelector(".c-card-preview img");
      if (previewImg) {
        previewImg.onerror = () => {
          const ph = document.createElement("div");
          ph.className = "c-card-preview-ph";
          ph.textContent = t("community.previewUnavailable");
          previewImg.replaceWith(ph);
        };
      }

      const favoriteBtn = card.querySelector(".c-favorite");
      favoriteBtn.appendChild(Ico("star", { size: 14, sw: 1.35 }));
      favoriteBtn.onclick = async (e) => {
        e.stopPropagation();
        await toggleCommunityFavorite(s, favoriteBtn);
      };

      const saveBtn = card.querySelector(".c-save");
      saveBtn.disabled = !!s._unavailableReason;
      if (s._unavailableReason) saveBtn.title = t("community.scriptUnavailableHelp");
      saveBtn.appendChild(Ico("download", { size: 13, sw: 1.4 }));
      saveBtn.onclick = async (e) => {
        e.stopPropagation();
        const saved = await saveCommunityScriptToLibrary(s, saveBtn);
        if (!saved) return;
        saveBtn.replaceChildren(Ico("check", { size: 13, sw: 1.6 }));
        saveBtn.title = "Saved to My Scripts";
        setTimeout(() => {
          saveBtn.replaceChildren(Ico("download", { size: 13, sw: 1.4 }));
          saveBtn.title = "Save to My Scripts (don't install)";
          saveBtn.disabled = false;
        }, 1600);
      };

      const btn = card.querySelector(".install-btn");
      if (s._unavailableReason) btn.title = t("community.scriptUnavailableHelp");
      btn.onclick = (e) => {
        e.stopPropagation();
        handleCommunityInstallClick(s, btn);
      };
      card.onclick = () => openCommunityDetailModal(s);
      return card;
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

// ---------- Affinity status ----------
function renderAffinityStatus(root) {
  const screen = document.createElement("div");
  screen.className = "screen affinity-status-screen";
  screen.innerHTML = `
    <div class="eyebrow">${escapeHtml(t("nav.support"))}</div>
    <div class="affinity-status-header">
      <div><h1>${escapeHtml(t("nav.affinityStatus"))}</h1><p class="subhead">${escapeHtml(t("affinityStatus.subtitle"))}</p></div>
      <button class="gh-btn" id="affinity-status-refresh">${escapeHtml(t("affinityStatus.refresh"))}</button>
    </div>
    <div id="affinity-status-content" aria-live="polite"></div>
    <details class="event-stream affinity-status-events">
      <summary>${escapeHtml(t("affinityStatus.eventStream"))}</summary>
      <div class="event-log" id="affinity-status-log"></div>
    </details>
  `;
  root.appendChild(screen);
  const button = screen.querySelector("#affinity-status-refresh");
  const content = screen.querySelector("#affinity-status-content");
  const log = screen.querySelector("#affinity-status-log");
  const pushEvent = (tag, message) => {
    const line = document.createElement("div");
    line.className = "event-line";
    line.innerHTML = `<span class="t">${new Date().toTimeString().slice(0, 8)}</span><span class="tag-${tag}">${tag.toUpperCase()}</span><span class="msg">${escapeHtml(message)}</span>`;
    log.prepend(line);
    while (log.children.length > 20) log.lastElementChild.remove();
  };
  const check = async () => {
    button.disabled = true;
    content.innerHTML = `<div class="affinity-status-loading loading-indicator">${escapeHtml(t("affinityStatus.checking"))}</div>`;
    pushEvent("info", t("affinityStatus.checking"));
    const result = await window.api.getAffinityHealth();
    if (!screen.isConnected) return;
    button.disabled = false;
    if (!result?.success) {
      pushEvent("warn", result?.error || t("affinityStatus.disconnected"));
      content.innerHTML = `
        <div class="affinity-status-card">
          <h2>${escapeHtml(t("affinityStatus.connection"))}</h2>
          <div class="affinity-status-row"><span>${escapeHtml(t("affinityStatus.address"))}</span><span>localhost:6767</span></div>
          <div class="affinity-status-row"><span>${escapeHtml(t("affinityStatus.status"))}</span><span class="affinity-status-badge bad">${escapeHtml(t("affinityStatus.disconnected"))}</span></div>
          <p>${escapeHtml(t("affinityStatus.offlineHelp"))}</p>
          <p class="affinity-status-error">${escapeHtml(result?.error || "")}</p>
        </div>`;
      return;
    }
    const { permissions, roots, desktopPath, desktopAllowed, latencyMs, serverVersion } = result.data;
    pushEvent("ok", t("affinityStatus.connectedIn", { ms: latencyMs }));
    const permissionRow = (label, enabled) => `<div class="affinity-status-row"><span>${escapeHtml(t(label))}</span><span class="affinity-status-badge ${enabled ? "good" : "bad"}">${escapeHtml(t(enabled ? "affinityStatus.allowed" : "affinityStatus.denied"))}</span></div>`;
    content.innerHTML = `
      <div class="affinity-status-card">
        <h2>${escapeHtml(t("affinityStatus.connection"))}</h2>
        <div class="affinity-status-row"><span>${escapeHtml(t("affinityStatus.address"))}</span><span>localhost:6767</span></div>
        <div class="affinity-status-row"><span>${escapeHtml(t("affinityStatus.serverVersion"))}</span><span>${escapeHtml(serverVersion || "—")}</span></div>
        <div class="affinity-status-row"><span>${escapeHtml(t("affinityStatus.latency"))}</span><span>${latencyMs} ms</span></div>
        <div class="affinity-status-row"><span>${escapeHtml(t("affinityStatus.status"))}</span><span class="affinity-status-badge good">${escapeHtml(t("affinityStatus.connected"))}</span></div>
      </div>
      <section class="affinity-status-card">
        <h2>${escapeHtml(t("affinityStatus.permissions"))}</h2>
        ${permissionRow("affinityStatus.fileSystem", permissions.fileSystem)}
        ${permissionRow("affinityStatus.desktop", desktopAllowed)}
        ${permissionRow("affinityStatus.network", permissions.network)}
        ${permissionRow("affinityStatus.ai", permissions.genAI)}
        ${!desktopAllowed ? `<p class="affinity-status-help">${escapeHtml(t("affinityStatus.desktopHelp"))}</p>` : ""}
      </section>
      <section class="affinity-status-card">
        <h2>${escapeHtml(t("affinityStatus.folders"))}</h2>
        <p>${escapeHtml(t("affinityStatus.desktopPath", { path: desktopPath || "—" }))}</p>
        ${roots.length ? `<ul class="affinity-status-roots">${roots.map((rootPath) => `<li>${escapeHtml(rootPath)}</li>`).join("")}</ul>` : `<p>${escapeHtml(t("affinityStatus.noFolders"))}</p>`}
      </section>
      <p class="affinity-status-note">${escapeHtml(t("affinityStatus.scopeNote"))}</p>
    `;
  };
  button.onclick = check;
  check();
}

// ---------- Useful links ----------
const RESOURCE_LINKS = [
  {
    group: "official",
    title: "nav.officialAffinitySdk",
    description: "resources.officialDescription",
    url: "https://sdk.affinity.studio/",
    domain: "sdk.affinity.studio",
    icon: "book",
    mark: "SDK",
    theme: "official",
  },
  {
    group: "community",
    title: "nav.codexAffinityMcp",
    description: "resources.mcpDescription",
    url: "https://github.com/Stolgeth/mcp.af",
    domain: "github.com/Stolgeth/mcp.af",
    icon: "plug",
    mark: "MCP",
    theme: "mcp",
    image: "assets/resource-mcp-wordmark.svg",
  },
  {
    group: "community",
    title: "resources.setupGuideTitle",
    description: "resources.setupGuideDescription",
    url: "https://bolloplayer.github.io/affinity-mcp-setup/",
    domain: "bolloplayer.github.io",
    icon: "book",
    mark: "GUIDE",
    theme: "guide",
    image: "assets/resource-affinity-mcp-guide.jpg",
  },
];

function renderResources(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `
    <div class="eyebrow">${escapeHtml(t("nav.support"))}</div>
    <h1>${escapeHtml(t("nav.resources"))}</h1>
    <p class="subhead">${escapeHtml(t("resources.subtitle"))}</p>
    <div class="resource-sections"></div>
  `;
  root.appendChild(screen);
  const grids = {};
  for (const group of ["official", "community"]) {
    const section = document.createElement("section");
    section.className = "resource-section";
    section.innerHTML = `<h2>${escapeHtml(t(`resources.${group}Section`))}</h2><div class="resource-grid"></div>`;
    screen.querySelector(".resource-sections").appendChild(section);
    grids[group] = section.querySelector(".resource-grid");
  }
  for (const resource of RESOURCE_LINKS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "resource-card";
    card.setAttribute("aria-label", `${t("resources.openLink")}: ${t(resource.title)}`);
    card.innerHTML = `
      <span class="resource-preview resource-preview-${resource.theme}${resource.image ? " resource-preview-image" : ""}">
        ${resource.image ? `<img class="resource-preview-photo" src="${escapeHtml(resource.image)}" alt="" loading="lazy">` : `<span class="resource-preview-icon"></span><span class="resource-preview-mark">${escapeHtml(resource.mark)}</span>`}
      </span>
      <span class="resource-card-content">
        <strong class="resource-card-title">${escapeHtml(t(resource.title))}</strong>
        <span class="resource-card-description">${escapeHtml(t(resource.description))}</span>
        <span class="resource-card-footer">
          <span class="resource-card-domain">${escapeHtml(resource.domain)}</span>
          <span class="resource-card-action">${escapeHtml(t("resources.openLink"))}<span class="resource-card-external"></span></span>
        </span>
      </span>
    `;
    if (!resource.image) card.querySelector(".resource-preview-icon").appendChild(Ico(resource.icon, { size: 32, sw: 1.4 }));
    card.querySelector(".resource-card-external").appendChild(Ico("external", { size: 12 }));
    card.onclick = () => window.api.openUrl(resource.url);
    grids[resource.group].appendChild(card);
  }
}

// ---------- Documentation screen ----------
let docsCache = null;
let docsCacheVersion = null;

async function renderDocs(root) {
  const screen = document.createElement("div");
  screen.className = "screen";
  screen.innerHTML = `
    <div class="eyebrow">${escapeHtml(t("nav.support"))}</div>
    <div class="docs-header">
      <div>
        <h1>${escapeHtml(t("nav.documentation"))}</h1>
        <p class="subhead" id="docs-sub"><span class="loading">${escapeHtml(t("docs.subtitleLoading"))}</span></p>
      </div>
      <div class="docs-header-actions">
        <button class="gh-btn compact" id="docs-export">${escapeHtml(t("docs.exportMarkdown"))}</button>
        <div class="docs-export-progress" id="docs-export-progress" hidden>
          <progress class="docs-progress" id="docs-progress" max="100" value="0"></progress>
        </div>
        <span id="docs-export-status" class="subhead"></span>
      </div>
    </div>

    <section class="api-monitor">
      <div class="api-monitor-head">
        <div><h2>${escapeHtml(t("docs.apiChanges"))}</h2><p id="api-monitor-status">${escapeHtml(t("docs.checkingVersion"))}</p></div>
        <button class="gh-btn compact" id="api-monitor-refresh" disabled>${escapeHtml(t("docs.checkNow"))}</button>
      </div>
      <div id="api-monitor-changes"></div>
      <div id="api-monitor-scan"></div>
    </section>

    <div class="search-bar" style="margin-bottom: 20px;">
      <div class="search-wrap">
        <span id="docs-search-ico"></span>
        <input id="docs-q" type="text" placeholder="${escapeHtml(t("docs.searchPlaceholder"))}" />
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

  const exportButton = screen.querySelector("#docs-export");
  const exportStatus = screen.querySelector("#docs-export-status");
  const progressBox = screen.querySelector("#docs-export-progress");
  const progressBar = screen.querySelector("#docs-progress");
  exportButton.onclick = async () => {
    exportButton.disabled = true;
    exportStatus.textContent = t("docs.exporting");
    exportStatus.classList.add("loading-indicator");
    progressBox.hidden = false;
    progressBar.value = 0;
    const stopProgress = window.api.onDocsProgress(({ done, total }) => {
      if (!screen.isConnected) return;
      progressBar.value = total ? Math.round(done / total * 100) : 0;
      exportStatus.textContent = t("docs.exportProgress", { done, total });
    });
    try {
      const result = await window.api.exportDocs();
      exportStatus.textContent = !result?.success
        ? result?.error || t("common.unknownError")
        : result.canceled ? "" : t("docs.exported", { version: result.data.version });
    } catch (error) {
      exportStatus.textContent = error.message || t("common.unknownError");
    } finally {
      stopProgress();
      progressBox.hidden = true;
      exportStatus.classList.remove("loading-indicator");
      exportButton.disabled = false;
    }
  };

  const monitorStatus = screen.querySelector("#api-monitor-status");
  const monitorChanges = screen.querySelector("#api-monitor-changes");
  const monitorScan = screen.querySelector("#api-monitor-scan");
  const refreshMonitor = screen.querySelector("#api-monitor-refresh");
  async function showApiMonitor(sync) {
    refreshMonitor.disabled = true;
    monitorStatus.textContent = t(sync ? "docs.checkingSdk" : "docs.loadingSnapshots");
    monitorStatus.classList.add("loading-indicator");
    let result;
    try {
      result = sync ? await window.api.syncApiMonitor() : await window.api.getApiMonitor();
    } catch (error) {
      result = { success: false, error: error.message };
    }
    const syncError = sync && !result?.success ? result?.error || "Affinity is unavailable." : null;
    if (syncError) {
      const cached = await window.api.getApiMonitor().catch(() => null);
      if (cached?.success && cached.data.currentVersion) result = cached;
    }
    monitorStatus.classList.remove("loading-indicator");
    if (!screen.isConnected) return;
    refreshMonitor.disabled = false;
    monitorChanges.replaceChildren();
    monitorScan.replaceChildren();
    if (!result?.success) {
      monitorStatus.textContent = result?.error || "Could not check Affinity SDK.";
      return;
    }
    const { currentVersion, previousVersion, changes } = result.data;
    if (currentVersion && currentVersion !== docsCacheVersion) {
      docsCache = null;
      docsCacheVersion = currentVersion;
    }
    if (!currentVersion) {
      monitorStatus.textContent = t("docs.noSnapshot");
      return;
    }
    if (!previousVersion) {
      monitorStatus.textContent = t("docs.firstSnapshot", { version: currentVersion });
      return;
    }
    monitorStatus.textContent = `${t("docs.changeCount", { previous: previousVersion, current: currentVersion, count: changes.length })}${syncError ? ` ${syncError}` : ""}`;
    if (!changes.length) return;
    const list = document.createElement("div");
    list.className = "api-change-list";
    for (const change of changes) {
      const row = document.createElement("div");
      row.className = "api-change-row";
      const label = document.createElement("div");
      label.className = "api-change-label";
      label.textContent = `${change.module} · ${change.kind}`;
      const before = document.createElement("code");
      before.textContent = change.before || "—";
      const after = document.createElement("code");
      after.textContent = change.after || "—";
      row.append(label, before, after);
      list.appendChild(row);
    }
    monitorChanges.appendChild(list);
    const scanButton = document.createElement("button");
    scanButton.className = "gh-btn compact";
    scanButton.textContent = t("docs.scanScripts");
    const scanResult = document.createElement("div");
    scanResult.className = "api-scan-result";
    scanButton.onclick = async () => {
      scanButton.disabled = true;
      scanResult.textContent = t("docs.scanningScripts");
      scanResult.classList.add("loading-indicator");
      let result;
      try { result = await window.api.scanApiCompatibility(); }
      catch (error) { result = { success: false, error: error.message }; }
      if (!screen.isConnected) return;
      scanResult.classList.remove("loading-indicator");
      scanButton.disabled = false;
      if (!result?.success) {
        scanResult.textContent = result?.error || "Could not scan scripts.";
        return;
      }
      const { scripts, failed } = result.data;
      scanResult.replaceChildren();
      const summary = document.createElement("p");
      summary.textContent = scripts.length
        ? t("docs.possibleScripts", { count: scripts.length })
        : t("docs.noDirectCalls");
      scanResult.appendChild(summary);
      for (const script of scripts) {
        const row = document.createElement("p");
        row.textContent = `${script.title}: ${script.calls.join(", ")}`;
        scanResult.appendChild(row);
      }
      if (failed) {
        const warning = document.createElement("p");
        warning.textContent = t("docs.unreadableScripts", { count: failed });
        scanResult.appendChild(warning);
      }
    };
    monitorScan.append(scanButton, scanResult);
  }
  refreshMonitor.onclick = async () => {
    const previousVersion = docsCacheVersion;
    await showApiMonitor(true);
    if (screen.isConnected && docsCacheVersion !== previousVersion) renderScreen();
  };
  await showApiMonitor(true);

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
    out.textContent = t("docs.searching");
    out.classList.add("loading-indicator");
    input.disabled = true;

    let r;
    try {
      r = await window.api.searchDocs(q);
    } catch (err) {
      input.disabled = false;
      out.classList.remove("loading-indicator");
      out.style.cssText =
        "display:block; margin-bottom: 28px; color: var(--danger-text); font-size: 12px; padding: 16px 20px; border: 1px solid var(--danger-border); background: var(--danger-bg); border-radius: var(--r-lg);";
      out.textContent =
        "IPC error: " + (err && err.message ? err.message : String(err));
      return;
    }
    input.disabled = false;
    out.classList.remove("loading-indicator");
    if (!r || !r.success) {
      out.style.cssText =
        "display:block; margin-bottom: 28px; color: var(--danger-text); font-size: 12px; padding: 16px 20px; border: 1px solid var(--danger-border); background: var(--danger-bg); border-radius: var(--r-lg);";
      out.textContent =
        (r && r.error) ||
        "Search failed with no error message. The MCP bridge may be offline.";
      return;
    }
    const { results = [], version, cached } = r.data || {};
    if (!results.length) {
      out.style.cssText =
        "display:block; margin-bottom: 28px; color: var(--text-faint); font-size: 12px; padding: 16px 20px; border: 1px solid var(--hair); background: var(--bg-card); border-radius: var(--r-lg);";
      out.textContent = t("docs.noResults", { query: q });
      return;
    }
    out.className = "doc-reader";
    out.style.cssText =
      "display:block; margin-bottom: 28px; padding: 20px 24px; border: 1px solid var(--hair); background: var(--bg-card); border-radius: var(--r-lg);";
    const close = document.createElement("button");
    close.className = "gh-btn compact";
    close.textContent = t("docs.clearSearch");
    close.style.marginBottom = "14px";
    close.onclick = () => {
      input.value = "";
      resetOut();
    };
    out.innerHTML = "";
    out.appendChild(close);
    if (cached) {
      const note = document.createElement("p");
      note.className = "subhead";
      note.textContent = t("docs.cachedVersion", { version });
      out.appendChild(note);
    }
    for (const match of results) {
      const button = document.createElement("button");
      button.className = "doc-search-hit";
      button.innerHTML = `<strong>${escapeHtml(match.title)}:${match.line}</strong><span>${escapeHtml(match.snippet)}</span>`;
      button.onclick = () => openDocReader({ title: match.title });
      out.appendChild(button);
    }
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
    if (res.cached) {
      exportStatus.textContent = t("docs.cachedVersion", { version: res.version });
    }
  }
  screen.querySelector("#docs-sub").textContent = t("docs.topicCount", { count: docsCache.length });

  const grid = document.createElement("div");
  grid.className = "docs-grid";
  docsCache.forEach((d, i) => {
    const card = document.createElement("div");
    card.className = "doc-card";
    card.innerHTML = `
      <div class="meta"><span>${String(i + 1).padStart(2, "0")}</span><span>Reference</span></div>
      <h3>${escapeHtml(d.title)}</h3>
      <div class="read">${escapeHtml(t("docs.read"))}</div>
    `;
    card.onclick = () => openDocReader(d);
    grid.appendChild(card);
  });
  body.appendChild(grid);
}

async function openDocReader(doc) {
  const main = document.getElementById("main");
  main.innerHTML = "";
  main.scrollTop = 0;
  const reader = document.createElement("div");
  reader.className = "doc-reader";
  const back = document.createElement("button");
  back.className = "gh-btn compact";
  back.style.marginBottom = "20px";
  back.textContent = t("docs.back");
  back.onclick = () => renderScreen();
  reader.appendChild(back);

  const title = document.createElement("h1");
  title.textContent = doc.title;
  reader.appendChild(title);

  const content = document.createElement("div");
  content.innerHTML = `<span class="loading">${escapeHtml(t("docs.loadingTopic"))}</span>`;
  reader.appendChild(content);

  main.appendChild(reader);
  if (doc.content == null) {
    let result;
    try {
      result = await window.api.readDocTopic(doc.title);
    } catch (error) {
      if (reader.isConnected) content.textContent = error.message || "Could not load documentation topic.";
      return;
    }
    if (!reader.isConnected) return;
    if (!result?.success) {
      content.textContent = result?.error || "Could not load documentation topic.";
      return;
    }
    doc.content = result.data;
  }
  content.innerHTML = window.marked && doc.content
    ? window.marked.parse(doc.content)
    : escapeHtml(doc.content || "");
}

// ---------- Upload / Download modals ----------
function openUploadModal() {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  bd.innerHTML = `
    <div class="modal">
      <div class="modal-head">
        <h3>${escapeHtml(t("app.addScript"))}</h3>
        <button class="icon-btn" id="m-close"></button>
      </div>
      <div class="modal-body">
        <p>${escapeHtml(t("upload.description"))}</p>
        <button class="gh-btn" id="m-pick" style="width:100%">${escapeHtml(t("upload.selectFile"))}</button>
        <div><label>${escapeHtml(t("upload.title"))}</label><input id="m-title" type="text"></div>
        <div><label>${escapeHtml(t("upload.optionalDescription"))}</label><input id="m-desc" type="text"></div>
      </div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-cancel">${escapeHtml(t("action.cancel"))}</button>
        <button class="accent-btn" id="m-save">${escapeHtml(t("upload.saveScript"))}</button>
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
    btn.innerHTML = `<span class="loading">${escapeHtml(t("action.saving"))}</span>`;
    btn.disabled = true;
    const r = await window.api.saveScript(title, desc, code);
    if (!r || !r.success) {
      alert((r && r.error) || "Save failed");
      btn.textContent = t("upload.saveScript");
      btn.disabled = false;
      return;
    }
    close();
    if (!r.pushed) {
      alert(
        "Saved locally, but couldn't install into Affinity. Make sure the Affinity bridge (MCP) is running, then install it from My Scripts.",
      );
    }
    if (state.nav === "local") renderScreen();
  };
}

function openDownloadModal(title) {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  const safe = title.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  bd.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-head"><h3>${escapeHtml(t("download.toLibrary"))}</h3></div>
      <div class="modal-body"><div><label>${escapeHtml(t("download.saveAs"))}</label><input id="m-name" type="text" value="${escapeHtml(safe)}"></div></div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-cancel">${escapeHtml(t("action.cancel"))}</button>
        <button class="accent-btn" id="m-ok">${escapeHtml(t("action.download"))}</button>
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
    btn.innerHTML = `<span class="loading">${escapeHtml(t("action.downloading"))}</span>`;
    btn.disabled = true;
    const r = await window.api.downloadFromMcp(title, name);
    if (!r || !r.success) {
      alert((r && r.error) || "Download failed");
      btn.textContent = t("action.download");
      btn.disabled = false;
      return;
    }
    close();
    state.nav = "local";
    renderNav();
    renderScreen();
  };
}

function openRenameLocalModal(script) {
  const bd = document.createElement("div");
  bd.className = "modal-backdrop";
  const currentBase = script.file.replace(/\.js$/i, "");
  bd.innerHTML = `
    <div class="modal" style="max-width:400px">
      <div class="modal-head">
        <h3>${escapeHtml(t("rename.heading"))}</h3>
        <button class="icon-btn" id="m-close"></button>
      </div>
      <div class="modal-body">
        <div>
          <label>${escapeHtml(t("rename.fileName"))}</label>
          <input id="m-name" type="text" value="${escapeHtml(currentBase)}" autocomplete="off" spellcheck="false">
        </div>
        <p id="m-preview"></p>
      </div>
      <div class="modal-foot">
        <button class="gh-btn" id="m-cancel">${escapeHtml(t("action.cancel"))}</button>
        <button class="accent-btn" id="m-ok">${escapeHtml(t("action.rename"))}</button>
      </div>
    </div>`;
  document.body.appendChild(bd);

  const input = bd.querySelector("#m-name");
  const preview = bd.querySelector("#m-preview");
  const okBtn = bd.querySelector("#m-ok");
  const close = () => bd.remove();
  const updatePreview = () => {
    const next = scriptFilenameFromInput(input.value);
    preview.textContent = next ? t("rename.preview", { name: next }) : t("rename.invalid");
    okBtn.disabled = !next || next === script.file;
  };

  bd.querySelector("#m-close").appendChild(Ico("close", { size: 12 }));
  bd.querySelector("#m-close").onclick = close;
  bd.querySelector("#m-cancel").onclick = close;
  bd.addEventListener("click", (e) => {
    if (e.target === bd) close();
  });
  input.addEventListener("input", updatePreview);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") okBtn.click();
  });

  okBtn.onclick = async () => {
    const next = scriptFilenameFromInput(input.value);
    if (!next || next === script.file) return;
    okBtn.innerHTML = `<span class="loading">${escapeHtml(t("action.renaming"))}</span>`;
    okBtn.disabled = true;
    const r = await window.api.renameLocalScript(script.file, next);
    if (!r || !r.success) {
      alert((r && r.error) || "Rename failed");
      okBtn.textContent = t("action.rename");
      updatePreview();
      return;
    }
    close();
    renderScreen();
  };

  input.focus();
  input.select();
  updatePreview();
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
  const backLabel = origin === "develop"
    ? t("editor.backToCodeEditor") : t("editor.backToMyScripts");

  // New scripts get a filename input in the header styled as an editable headline.
  // Existing scripts show the filename static with a dirty-dot indicator.
  const filenameHtml = isNew
    ? `<input id="ed-filename" type="text" placeholder="my-new-script" autocomplete="off" spellcheck="false">
       <span class="ed-ext">.js</span>`
    : `<span class="ed-dirty" id="ed-dirty"></span>${escapeHtml(filename)}`;

  screen.innerHTML = `
    <div class="editor-header">
      <button class="gh-btn compact" id="ed-back">${escapeHtml(backLabel)}</button>
      <div class="editor-filename${isNew ? " new" : ""}">${filenameHtml}</div>
      ${isNew ? "" : `<button class="gh-btn compact" id="ed-reload" title="${escapeHtml(t("editor.reloadTitle"))}">${escapeHtml(t("editor.reload"))}</button>`}
      <button class="gh-btn compact" id="ed-run" title="${escapeHtml(t("editor.runTitle"))}"><span id="ed-run-ico"></span> ${escapeHtml(t("action.run"))}</button>
      <button class="accent-btn compact" id="ed-save" disabled>${escapeHtml(t("action.save"))}</button>
    </div>
    <div class="editor-host" id="editor-host"></div>
  `;
  root.appendChild(screen);

  const backBtn = screen.querySelector("#ed-back");
  const saveBtn = screen.querySelector("#ed-save");
  let dirtyEl = screen.querySelector("#ed-dirty");
  const host = screen.querySelector("#editor-host");
  const nameInput = screen.querySelector("#ed-filename"); // null when not isNew
  backBtn.onclick = () => navigate(origin);

  const runBtn = screen.querySelector("#ed-run");
  runBtn.querySelector("#ed-run-ico").appendChild(Ico("terminal", { size: 12 }));
  runBtn.onclick = () => {
    if (!activeEditor) return;
    openRunModal({
      code: activeEditor.getValue(),
      name: isNew && nameInput ? nameInput.value.trim() || undefined : filename,
    });
  };

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

  const editorSettingsResult = await window.api.getEditorSettings();
  const editorSettings = editorSettingsResult?.success
    ? editorSettingsResult.data
    : { indentStyle: "spaces", tabSize: 2 };
  activeEditor = ace.edit(host, {
    mode: "ace/mode/javascript",
    theme: "ace/theme/tomorrow_night",
    tabSize: editorSettings.tabSize,
    useSoftTabs: editorSettings.indentStyle === "spaces",
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

  const attachReload = (reloadBtn) => {
    reloadBtn.onclick = async () => {
      if (state.editorDirty && !confirm("Discard unsaved changes and reload this script from disk?")) return;
      const bufferBeforeRead = activeEditor.getValue();
      reloadBtn.disabled = true;
      reloadBtn.textContent = "Reloading…";
      try {
        const result = await window.api.readLocalScript(state.editorFile);
        if (!screen.isConnected || !activeEditor) return;
        if (!result?.success) {
          alert("Reload failed: " + (result?.error || "Could not read file"));
          return;
        }
        if (activeEditor.getValue() !== bufferBeforeRead &&
            !confirm("The editor changed while reloading. Discard those changes and use the file from disk?")) return;
        activeEditor.setValue(result.data.code || "", -1);
        markDirty(false);
      } catch (error) {
        if (screen.isConnected) alert("Reload failed: " + error.message);
      } finally {
        if (screen.isConnected) {
          reloadBtn.disabled = false;
          reloadBtn.textContent = t("editor.reload");
        }
      }
    };
  };
  const reloadBtn = screen.querySelector("#ed-reload");
  if (reloadBtn) attachReload(reloadBtn);

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
      targetFilename = scriptFilenameFromInput(raw);
      if (!targetFilename) {
        alert("Please enter a valid name (letters, numbers, dashes).");
        nameInput && nameInput.focus();
        return;
      }
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
      dirtyEl = fnameEl.querySelector("#ed-dirty");
      const newReloadBtn = document.createElement("button");
      newReloadBtn.className = "gh-btn compact";
      newReloadBtn.id = "ed-reload";
      newReloadBtn.title = t("editor.reloadTitle");
      newReloadBtn.textContent = t("editor.reload");
      fnameEl.after(newReloadBtn);
      attachReload(newReloadBtn);
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
    <div class="eyebrow">${escapeHtml(t("nav.development"))}</div>
    <div class="screen-header">
      <div>
        <h1 style="margin-bottom:6px">${escapeHtml(t("nav.codeEditor"))}</h1>
        <p class="subhead" style="margin:0">${escapeHtml(t("editor.description"))}</p>
      </div>
      <div class="actions">
        <button class="accent-btn compact" id="btn-new-script"><span id="ico-new-plus"></span> ${escapeHtml(t("editor.newScript"))}</button>
      </div>
    </div>

    <div class="eyebrow" style="margin-bottom:12px">${escapeHtml(t("nav.myScripts"))}</div>
    <div class="dev-list" id="dev-local"></div>
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
      btn.textContent = t("action.edit");
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
}
