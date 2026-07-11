const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  SSEClientTransport,
} = require("@modelcontextprotocol/sdk/client/sse.js");
const { CallToolResultSchema } = require("@modelcontextprotocol/sdk/types.js");

const SERVER_URL = "http://localhost:6767/sse";
const DEFAULT_REPO =
  "https://raw.githubusercontent.com/JiriKrblich/Affinity-Community-Scripts/refs/heads/main/registry.json";
const COMMUNITY_ISSUES_URL =
  "https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new";

let client;
let transport;
let localScriptsDir;
let configPath;
let win;
ipcMain.on("app-version-sync", (e) => {
  e.returnValue = app.getVersion();
});

// --- Helper Functions ---
function getTextContent(result) {
  return (result.content || [])
    .filter((i) => i && i.type === "text")
    .map((i) => i.text)
    .join("\n");
}

// A render_* tool returns a base64 JPEG — either as an image content item or as
// text. Normalize both to a data: URL the renderer can drop into an <img>.
function getImageDataUrl(result) {
  const items = (result && result.content) || [];
  const img = items.find((i) => i && i.type === "image" && i.data);
  if (img) return `data:${img.mimeType || "image/jpeg"};base64,${img.data}`;
  const text = getTextContent(result).trim();
  if (!text) return "";
  return text.startsWith("data:") ? text : `data:image/jpeg;base64,${text}`;
}

function parseCsvTextContent(result) {
  const textChunks = (result.content || [])
    .filter((i) => i && i.type === "text")
    .map((i) => i.text);
  return [
    ...new Set(
      textChunks
        .join(",")
        .split(",")
        .map((n) => n.trim())
        .filter(Boolean),
    ),
  ];
}

// GitHub's raw CDN (raw.githubusercontent.com) caches files for ~5 minutes, so a
// freshly pushed registry.json / script can otherwise look stale when the app is
// reopened. Bust the edge cache with a unique query param + no-cache headers so we
// always pull the latest. Callers keep the clean URL for anything else (asset
// resolution, _source), passing it here only at the fetch call site.
function fetchFresh(url, options = {}) {
  const sep = url.includes("?") ? "&" : "?";
  const bustedUrl = `${url}${sep}_cb=${Date.now()}`;
  return fetch(bustedUrl, {
    cache: "no-store",
    ...options,
    headers: {
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      ...(options.headers || {}),
    },
  });
}

// Build a GitHub "new issue" URL whose body mirrors the community repo's
// contribute-script template fields (Script Name / Author / Description /
// Preview image / Version / Code), pre-filled from the script's metadata.
function shareIssuePayload(code, nameHint) {
  const meta = parseScriptMetadata(code, nameHint);
  const name = meta.name || nameHint;
  const title = `New script: ${name}`;
  const body =
    `**Script Name:** ${name}\n\n` +
    `**Author:** ${meta.author || ""}\n\n` +
    `**Contact:** _(your email, website, …)_\n\n` +
    `**Description:** ${meta.description || ""}\n\n` +
    `**Preview image:** _(drag and drop a 16:9 preview image here)_\n\n` +
    `**Version:** ${meta.version || ""}\n\n` +
    "**Code:**\n\n```js\n" +
    code +
    "\n```\n";
  const baseUrl = `${COMMUNITY_ISSUES_URL}?title=${encodeURIComponent(title)}`;
  const url = `${baseUrl}&body=${encodeURIComponent(body)}`;
  return { url, baseUrl, body, tooLong: url.length > 7000 };
}

function resolveCommunityAssetUrl(registryUrl, assetUrl) {
  if (!assetUrl) return "";
  try {
    return new URL(assetUrl, registryUrl).toString();
  } catch {
    return assetUrl;
  }
}

// Resolve a file sitting next to registry.json in the same repo folder, e.g.
// ".../main/registry.json" + "featured.json" -> ".../main/featured.json".
function deriveRepoFileUrl(registryUrl, filename) {
  try {
    return new URL(filename, registryUrl).toString();
  } catch {
    return "";
  }
}

// Normalize the many shapes a featured.json may take into a Set of script ids:
//   ["id1", "id2"]
//   { "featured": ["id1", "id2"] }
//   { "featured": [{ "id": "id1" }, ...] }
function parseFeaturedIds(data) {
  const list = Array.isArray(data)
    ? data
    : data && Array.isArray(data.featured)
      ? data.featured
      : [];
  const ids = new Set();
  for (const entry of list) {
    if (typeof entry === "string") {
      ids.add(entry.trim());
    } else if (entry && typeof entry === "object" && entry.id) {
      ids.add(String(entry.id).trim());
    }
  }
  ids.delete("");
  return ids;
}

// Best-effort fetch of a repo's featured.json. Missing/invalid file is not an
// error — featured is an optional, additive layer on top of registry.json.
async function fetchFeaturedIds(registryUrl) {
  const featuredUrl = deriveRepoFileUrl(registryUrl, "featured.json");
  if (!featuredUrl) return new Set();
  try {
    const res = await fetchFresh(featuredUrl);
    if (!res.ok) return new Set();
    return parseFeaturedIds(await res.json());
  } catch {
    return new Set();
  }
}

function assertLocalScriptFilename(filename) {
  if (!filename || typeof filename !== "string") {
    throw new Error("Missing script filename.");
  }
  if (path.basename(filename) !== filename || path.extname(filename) !== ".js") {
    throw new Error("Invalid script filename.");
  }
  return filename;
}

function localScriptFilenameFromInput(input) {
  const base = String(input || "")
    .trim()
    .replace(/\.js$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!base) throw new Error("Please enter a valid script name.");
  return `${base}.js`;
}

function readMetadataField(header, field) {
  const re = new RegExp(`^\\s*\\*?\\s*${field}:\\s*(.*)$`, "im");
  const match = header.match(re);
  return match ? match[1].trim() : "";
}

function parseScriptMetadata(code, fallbackName = "") {
  const meta = {
    name: fallbackName,
    description: "",
    version: "",
    author: "",
  };
  const headerMatch = String(code || "").match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!headerMatch) return meta;

  const header = headerMatch[1];
  meta.name = readMetadataField(header, "name") || meta.name;
  meta.description = readMetadataField(header, "description");
  meta.version = readMetadataField(header, "version");
  meta.author = readMetadataField(header, "author");
  return meta;
}

function metadataValue(value) {
  return String(value || "").replace(/\s*\n+\s*/g, " ").trim();
}

function upsertMetadataHeader(code, metadata) {
  const fields = {
    name: metadataValue(metadata.name),
    description: metadataValue(metadata.description),
    version: metadataValue(metadata.version),
    author: metadataValue(metadata.author),
  };
  const presentFields = Object.entries(fields).filter(([, value]) => value);
  if (presentFields.length === 0) return code;

  const source = String(code || "");
  const headerMatch = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  if (!headerMatch) {
    const header =
      "/**\n" +
      presentFields.map(([key, value]) => ` * ${key}: ${value}`).join("\n") +
      "\n */\n\n";
    return header + source.replace(/^\s+/, "");
  }

  let header = headerMatch[1];
  for (const [key, value] of presentFields) {
    const re = new RegExp(`(^\\s*\\*?\\s*${key}:\\s*).*$`, "im");
    if (re.test(header)) {
      header = header.replace(re, (line, prefix) => `${prefix}${value}`);
    } else {
      header += `\n * ${key}: ${value}`;
    }
  }
  return source.replace(headerMatch[0], `/**${header}*/`);
}

let mcpConnected = false;
let mcpConnectPromise = null;

// Establish (or re-establish) the MCP session. Safe to call multiple times — concurrent callers
// share the same in-flight promise. Throws if the bridge is unreachable so callers can surface
// a real error instead of falling through with a stale client.
async function ensureMcpConnected() {
  if (mcpConnected && client && transport) return;
  if (mcpConnectPromise) return mcpConnectPromise;
  mcpConnectPromise = (async () => {
    try {
      if (transport) {
        try {
          await transport.close();
        } catch {}
      }
      client = new Client({ name: "script-mgr-ui", version: "1.0.0" });
      transport = new SSEClientTransport(new URL(SERVER_URL));
      await client.connect(transport);
      // Affinity's MCP requires reading the preamble doc once per session before other
      // SDK-doc tools will return real data — otherwise list_sdk_documentation etc. respond
      // with an "ERROR: Listing failed" payload. Prime it best-effort.
      try {
        await client.request(
          {
            method: "tools/call",
            params: {
              name: "read_sdk_documentation_topic",
              arguments: { filename: "preamble" },
            },
          },
          CallToolResultSchema,
        );
      } catch (primeErr) {
        console.warn("[MCP] preamble prime failed:", primeErr.message);
      }
      mcpConnected = true;
    } catch (err) {
      mcpConnected = false;
      throw err;
    } finally {
      mcpConnectPromise = null;
    }
  })();
  return mcpConnectPromise;
}

async function callTool(_clientIgnored, name, args) {
  await ensureMcpConnected();
  try {
    return await client.request(
      { method: "tools/call", params: { name, arguments: args } },
      CallToolResultSchema,
    );
  } catch (err) {
    // If the session dropped (bridge restarted, etc.), reconnect once and retry.
    const msg = err && err.message ? err.message : String(err);
    if (
      /session not initialized|not connected|disconnected|closed/i.test(msg)
    ) {
      mcpConnected = false;
      await ensureMcpConnected();
      return client.request(
        { method: "tools/call", params: { name, arguments: args } },
        CallToolResultSchema,
      );
    }
    throw err;
  }
}

// --- Bezpečná správa konfigurace ---
async function getConfig() {
  let config = {};
  let needsSave = false;

  try {
    const data = await fs.readFile(configPath, "utf8");
    config = JSON.parse(data);
  } catch (e) {
    needsSave = true;
  }

  if (!config.repositories || !Array.isArray(config.repositories)) {
    config.repositories = [DEFAULT_REPO];
    needsSave = true;
  } else if (!config.repositories.includes(DEFAULT_REPO)) {
    config.repositories.unshift(DEFAULT_REPO);
    needsSave = true;
  }

  // Unified favorites keyed by script stem — shared by My Scripts and Community
  // (favoriting a community script marks its local copy, and vice versa).
  if (!config.favoriteScripts || !Array.isArray(config.favoriteScripts)) {
    const migrated = Array.isArray(config.favoriteLocalScripts)
      ? config.favoriteLocalScripts.map((f) =>
          String(f).replace(/\.js$/i, "").toLowerCase(),
        )
      : [];
    config.favoriteScripts = [...new Set(migrated)];
    needsSave = true;
  }
  if (config.favoriteCommunityScripts || config.favoriteLocalScripts) {
    delete config.favoriteCommunityScripts;
    delete config.favoriteLocalScripts;
    needsSave = true;
  }

  if (typeof config.sidebarCollapsed !== "boolean") {
    config.sidebarCollapsed = false;
    needsSave = true;
  }

  if (needsSave) await saveConfig(config);
  return config;
}

async function saveConfig(config) {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

// --- Watch mode: re-push edited scripts to the bridge and notify the renderer ---
async function startWatcher() {
  const pending = new Map(); // filename -> timer (debounce)

  const handleChange = async (filename) => {
    if (!filename || !filename.endsWith(".js")) return;
    const full = path.join(localScriptsDir, filename);
    let exists = false;
    try {
      await fs.stat(full);
      exists = true;
    } catch {}

    if (exists) {
      // Only auto-sync if the script is already installed in Affinity. New or
      // newly-saved files stay local until the user explicitly clicks the
      // install dot in My Scripts.
      try {
        const listResult = await callTool(client, "list_library_scripts", {});
        const titles = parseCsvTextContent(listResult).map((t) =>
          t.toLowerCase(),
        );
        const stem = path.parse(filename).name.toLowerCase();
        if (titles.includes(stem)) {
          const code = await fs.readFile(full, "utf8");
          const metadata = parseScriptMetadata(code, path.parse(filename).name);
          await callTool(client, "save_script_to_library", {
            title: metadata.name || path.parse(filename).name,
            description: metadata.description,
            code,
          }).catch(() => {});
        }
      } catch {} // bridge offline or not installed — renderer still gets the change ping
    }
    if (win && !win.isDestroyed())
      win.webContents.send("local-scripts-changed");
  };

  const debounced = (filename) => {
    const prev = pending.get(filename);
    if (prev) clearTimeout(prev);
    pending.set(
      filename,
      setTimeout(() => {
        pending.delete(filename);
        handleChange(filename);
      }, 300),
    );
  };

  try {
    const watcher = fs.watch(localScriptsDir);
    for await (const { filename } of watcher) {
      debounced(filename);
    }
  } catch (err) {
    console.warn("watch mode error:", err.message);
  }
}

app.whenReady().then(async () => {
  localScriptsDir = path.join(app.getPath("userData"), "MyScripts");
  configPath = path.join(app.getPath("userData"), "config.json");
  await fs.mkdir(localScriptsDir, { recursive: true });

  // Eagerly attempt to connect so the Server Bridge status is accurate on first paint;
  // failure is non-fatal — ensureMcpConnected() will retry on demand when a tool call
  // happens (user opens Documentation, SDK search, etc.).
  ensureMcpConnected().catch((err) =>
    console.warn("[MCP] initial connect failed:", err.message),
  );

  startWatcher(); // fire-and-forget

  win = new BrowserWindow({
    width: 1200,
    height: 820,
    title: "Script Manager for Affinity",
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#1f1f1f",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset",
          trafficLightPosition: { x: 14, y: 16 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  // ==========================================
  // --- LOCAL SCRIPTS & MCP ---
  // ==========================================

  ipcMain.handle("list-local-scripts", async () => {
    try {
      const files = (await fs.readdir(localScriptsDir)).filter((f) =>
        f.endsWith(".js"),
      );
      const out = [];
      for (const file of files) {
        const full = path.join(localScriptsDir, file);
        const stat = await fs.stat(full);
        let metadata = {
          name: path.parse(file).name,
          description: "",
          version: "",
        };
        try {
          const head = (await fs.readFile(full, "utf8")).slice(0, 4096);
          metadata = parseScriptMetadata(head, metadata.name);
        } catch {}
        out.push({
          file,
          name: metadata.name,
          description: metadata.description,
          version: metadata.version,
          size: stat.size,
          modified: stat.mtimeMs,
        });
      }
      return { success: true, data: out };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("delete-local-script", async (e, filename) => {
    try {
      await fs.unlink(path.join(localScriptsDir, filename));
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle("read-local-script", async (e, filename) => {
    try {
      const code = await fs.readFile(
        path.join(localScriptsDir, filename),
        "utf8",
      );
      return { success: true, data: { code } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("save-local-script", async (e, filename, code) => {
    try {
      await fs.writeFile(path.join(localScriptsDir, filename), code, "utf8");
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("rename-local-script", async (e, filename, newName) => {
    try {
      const oldFilename = assertLocalScriptFilename(filename);
      const nextFilename = localScriptFilenameFromInput(newName);
      if (oldFilename === nextFilename) {
        return { success: true, data: { filename: nextFilename } };
      }

      const oldPath = path.join(localScriptsDir, oldFilename);
      const nextPath = path.join(localScriptsDir, nextFilename);

      try {
        await fs.access(nextPath);
        return {
          success: false,
          error: `A script named ${nextFilename} already exists.`,
        };
      } catch {}

      await fs.rename(oldPath, nextPath);
      win.webContents.send("local-scripts-changed");
      return { success: true, data: { filename: nextFilename } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle("select-file", async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      properties: ["openFile"],
      filters: [{ name: "JavaScript", extensions: ["js"] }],
    });

    if (canceled || filePaths.length === 0) return { success: false };

    const code = await fs.readFile(filePaths[0], "utf8");

    // Výchozí hodnoty (pokud skript nemá hlavičku)
    const metadata = parseScriptMetadata(code, path.parse(filePaths[0]).name);

    return {
      success: true,
      data: {
        name: metadata.name,
        description: metadata.description,
        code,
      },
    };
  });

  ipcMain.handle("export-to-disk", async (event, filename) => {
    try {
      const code = await fs.readFile(
        path.join(localScriptsDir, filename),
        "utf8",
      );
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: filename,
      });
      if (canceled || !filePath) return { success: false, error: "Cancelled" };
      await fs.writeFile(filePath, code, "utf8");
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("push-to-mcp", async (event, filename) => {
    try {
      const filePath = path.join(localScriptsDir, filename);
      const code = await fs.readFile(filePath, "utf8");
      const metadata = parseScriptMetadata(code, path.parse(filename).name);
      await callTool(client, "save_script_to_library", {
        title: metadata.name || path.parse(filename).name,
        description: metadata.description,
        code,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("list-mcp-scripts", async () => {
    try {
      const result = await callTool(client, "list_library_scripts", {});
      return { success: true, data: getTextContent(result) || result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Run a script in Affinity directly (without installing it to the library).
  // Scripts don't return values — they log via console.log — so `output` is the
  // captured console text.
  ipcMain.handle("execute-script", async (event, code) => {
    try {
      const result = await callTool(client, "execute_script", { script: code });
      return { success: true, output: getTextContent(result) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Fetch a community script by its raw URL and run it in Affinity without
  // installing ("Run without install" from the community detail popup).
  ipcMain.handle("run-community-script", async (event, downloadUrl) => {
    try {
      const response = await fetchFresh(downloadUrl);
      if (!response.ok) throw new Error("Couldn't download the script.");
      const code = await response.text();
      const result = await callTool(client, "execute_script", { script: code });
      return { success: true, output: getTextContent(result) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Render the active document's first spread to a JPEG so the run result can be
  // previewed inline. Needs the document's sessionUuid, which we read via a tiny
  // helper script.
  ipcMain.handle("render-active-preview", async () => {
    try {
      const uuidRes = await callTool(client, "execute_script", {
        script:
          "const { Document } = require('/document'); console.log(Document.current.sessionUuid);",
      });
      const uuid = getTextContent(uuidRes).trim();
      if (!uuid)
        return { success: false, error: "No active document to preview." };
      const render = await callTool(client, "render_spread", {
        document_session_uuid: uuid,
        spread_index: 0,
      });
      const image = getImageDataUrl(render);
      if (!image) return { success: false, error: "Nothing was rendered." };
      return { success: true, image };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // "Add Script" — saves to disk and auto-installs into Affinity via the bridge.
  // The local save is authoritative; pushing to the bridge is best-effort so an
  // offline bridge still saves the file (reported via `pushed`/`pushError`).
  ipcMain.handle("save-script", async (event, title, description, code) => {
    try {
      const safeFilename =
        title.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
      const codeWithMetadata = upsertMetadataHeader(code, {
        name: title,
        description,
      });
      await fs.writeFile(
        path.join(localScriptsDir, safeFilename),
        codeWithMetadata,
        "utf8",
      );

      let pushed = false;
      let pushError = null;
      try {
        await callTool(client, "save_script_to_library", {
          title,
          description,
          code: codeWithMetadata,
        });
        pushed = true;
      } catch (err) {
        pushError = err && err.message ? err.message : String(err);
      }
      return { success: true, pushed, pushError };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("download-from-mcp", async (event, mcpTitle, localName) => {
    try {
      const result = await callTool(client, "read_library_script", {
        title: mcpTitle,
      });
      const code = getTextContent(result);
      if (!code) return { success: false, error: "Empty script." };
      const safeFilename =
        localName.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
      await fs.writeFile(
        path.join(localScriptsDir, safeFilename),
        code,
        "utf8",
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Build a pre-filled "contribute this script" GitHub issue for a local script.
  // Auth + commit happen on github.com; the app never touches a token. Long
  // scripts overflow the URL, so we also return the body for a clipboard fallback.
  ipcMain.handle("build-share-issue", async (event, filename) => {
    try {
      assertLocalScriptFilename(filename);
      const code = await fs.readFile(
        path.join(localScriptsDir, filename),
        "utf8",
      );
      return { success: true, ...shareIssuePayload(code, path.parse(filename).name) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Same, but for a script that lives only in Affinity (Just in Affinity tab).
  ipcMain.handle("build-share-issue-mcp", async (event, mcpTitle) => {
    try {
      const result = await callTool(client, "read_library_script", {
        title: mcpTitle,
      });
      const code = getTextContent(result);
      if (!code) return { success: false, error: "Empty script." };
      return { success: true, ...shareIssuePayload(code, mcpTitle) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Read a script from the Affinity library and return its parsed metadata
  // (name/description/…). The bridge list only exposes titles, so this is how the
  // "Just in Affinity" rows get a description.
  ipcMain.handle("read-mcp-metadata", async (event, mcpTitle) => {
    try {
      const result = await callTool(client, "read_library_script", {
        title: mcpTitle,
      });
      const code = getTextContent(result);
      return { success: true, data: parseScriptMetadata(code, mcpTitle) };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Read a script from the Affinity library and save it to an arbitrary folder
  // via the native save dialog (used by "Download to folder" for orphan scripts).
  ipcMain.handle("export-mcp-to-disk", async (event, mcpTitle) => {
    try {
      const result = await callTool(client, "read_library_script", {
        title: mcpTitle,
      });
      const code = getTextContent(result);
      if (!code) return { success: false, error: "Empty script." };
      const safeName =
        String(mcpTitle).toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        defaultPath: safeName,
      });
      if (canceled || !filePath) return { success: false, error: "Cancelled" };
      await fs.writeFile(filePath, code, "utf8");
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // ==========================================
  // --- COMMUNITY SCRIPTS & SETTINGS ---
  // ==========================================

  ipcMain.handle("get-repos", async () => {
    const config = await getConfig();
    return { success: true, data: config.repositories };
  });

  ipcMain.handle("add-repo", async (event, url) => {
    try {
      let rawUrl = url;

      if (url.includes("github.com")) {
        const match = url.match(/github\.com\/([^\/]+\/[^\/\?#]+)/);
        if (match) {
          const cleanRepo = match[1].replace(".git", "");
          rawUrl = `https://raw.githubusercontent.com/${cleanRepo}/refs/heads/main/registry.json`;
        } else {
          return {
            success: false,
            error:
              "Invalid GitHub URL format. Use https://github.com/user/repo",
          };
        }
      } else if (!url.includes("raw.githubusercontent.com")) {
        return {
          success: false,
          error: "Please provide a valid GitHub repository URL.",
        };
      }

      const config = await getConfig();
      if (!config.repositories.includes(rawUrl)) {
        config.repositories.push(rawUrl);
        await saveConfig(config);
        win.webContents.send("repos-changed");
      }
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("remove-repo", async (event, url) => {
    if (url === DEFAULT_REPO)
      return { success: false, error: "Cannot remove default repository." };
    try {
      const config = await getConfig();
      config.repositories = config.repositories.filter((r) => r !== url);
      await saveConfig(config);
      win.webContents.send("repos-changed");
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("list-community-scripts", async () => {
    try {
      const config = await getConfig();
      let allScripts = [];
      let communityOrder = 0;
      // Per-repo failures, distinguished by cause so the UI can explain *why*:
      //   unreachable  — network/DNS/connection error (fetch threw)
      //   unavailable  — reached the server but got a non-OK HTTP status (e.g. 404)
      //   invalid-json — downloaded but the body is not valid JSON (bad syntax)
      const repoErrors = [];

      for (const url of config.repositories) {
        const isDefault = url === DEFAULT_REPO;

        let response;
        try {
          response = await fetchFresh(url);
        } catch (err) {
          repoErrors.push({
            url,
            isDefault,
            reason: "unreachable",
            detail: err && err.message ? err.message : String(err),
          });
          continue;
        }

        if (!response.ok) {
          repoErrors.push({
            url,
            isDefault,
            reason: "unavailable",
            detail: `HTTP ${response.status}${response.statusText ? " " + response.statusText : ""}`,
          });
          continue;
        }

        let registry;
        try {
          registry = await response.json();
        } catch (err) {
          repoErrors.push({
            url,
            isDefault,
            reason: "invalid-json",
            detail: err && err.message ? err.message : String(err),
          });
          continue;
        }

        // Featured is an optional sibling file; fetch it in parallel-safe,
        // non-fatal fashion so a repo without featured.json still works.
        const featuredIds = await fetchFeaturedIds(url);
        const scriptsWithSource = (registry.scripts || []).map((script) => ({
          ...script,
          _source: url,
          _featured: featuredIds.has(script.id),
          _imageUrl: resolveCommunityAssetUrl(
            url,
            script.image ||
              script.image_url ||
              script.preview_image ||
              script.screenshot,
          ),
          _communityOrder: communityOrder++,
        }));
        allScripts = allScripts.concat(scriptsWithSource);
      }
      return { success: true, data: allScripts, errors: repoErrors };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  // Unified favorites — keyed by script stem, shared across My Scripts + Community.
  ipcMain.handle("get-favorites", async () => {
    try {
      const config = await getConfig();
      return { success: true, data: config.favoriteScripts };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("toggle-favorite", async (event, stem) => {
    try {
      const key = String(stem || "")
        .replace(/\.js$/i, "")
        .toLowerCase();
      if (!key) return { success: false, error: "Missing script key." };
      const config = await getConfig();
      const index = config.favoriteScripts.indexOf(key);
      if (index >= 0) config.favoriteScripts.splice(index, 1);
      else config.favoriteScripts.push(key);
      await saveConfig(config);
      return { success: true, data: config.favoriteScripts };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-sidebar-collapsed", async () => {
    try {
      const config = await getConfig();
      return { success: true, data: config.sidebarCollapsed };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("set-sidebar-collapsed", async (event, collapsed) => {
    try {
      const config = await getConfig();
      config.sidebarCollapsed = Boolean(collapsed);
      await saveConfig(config);
      return { success: true, data: config.sidebarCollapsed };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(
    "download-community-script",
    async (event, downloadUrl, filename, metadata = {}) => {
      try {
        const response = await fetchFresh(downloadUrl);
        if (!response.ok)
          throw new Error("Error downloading file from server.");
        const code = await response.text();
        const downloadedMetadata = parseScriptMetadata(code, filename);
        const finalMetadata = {
          ...downloadedMetadata,
          name: metadata.name || filename,
          description: metadata.description || downloadedMetadata.description,
          version: metadata.version || downloadedMetadata.version,
          author: metadata.author || downloadedMetadata.author,
        };
        const codeWithMetadata = upsertMetadataHeader(code, finalMetadata);
        const safeName =
          filename.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";

        await fs.writeFile(
          path.join(localScriptsDir, safeName),
          codeWithMetadata,
          "utf8",
        );

        try {
          await callTool(client, "save_script_to_library", {
            title: finalMetadata.name || filename,
            description: finalMetadata.description,
            code: codeWithMetadata,
          });
        } catch (mcpErr) {}

        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  );

  // Save-only: download to disk without pushing to the MCP bridge. Used by the "save" icon
  // next to Install on community cards, for users who want to inspect / edit before activating.
  ipcMain.handle(
    "save-community-script",
    async (event, downloadUrl, filename, metadata = {}) => {
      try {
        const response = await fetchFresh(downloadUrl);
        if (!response.ok)
          throw new Error("Error downloading file from server.");
        const code = await response.text();
        const downloadedMetadata = parseScriptMetadata(code, filename);
        const finalMetadata = {
          ...downloadedMetadata,
          name: metadata.name || filename,
          description: metadata.description || downloadedMetadata.description,
          version: metadata.version || downloadedMetadata.version,
          author: metadata.author || downloadedMetadata.author,
        };
        const codeWithMetadata = upsertMetadataHeader(code, finalMetadata);
        const safeName =
          filename.toLowerCase().replace(/[^a-z0-9_-]/g, "-") + ".js";
        await fs.writeFile(
          path.join(localScriptsDir, safeName),
          codeWithMetadata,
          "utf8",
        );
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    },
  );

  // ==========================================
  // --- DOCUMENTATION, SEARCH & UPDATES ---
  // ==========================================

  ipcMain.on("open-external-repo", () =>
    shell.openExternal(
      "https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new?template=contribute-script.md",
    ),
  );
  ipcMain.on("open-url", (event, url) => shell.openExternal(url));

  ipcMain.handle("fetch-docs", async () => {
    try {
      const listResult = await callTool(client, "list_sdk_documentation", {});
      const rawText = getTextContent(listResult).trim();
      // Affinity's tools occasionally return an error message as content with a successful RPC.
      if (!rawText || /^error[:\s]/i.test(rawText)) {
        return {
          success: false,
          error:
            "Affinity did not return a topic list: " +
            (rawText || "empty response"),
        };
      }
      const fileNames = parseCsvTextContent(listResult).filter(
        (n) => n && !/^error/i.test(n) && n !== "preamble",
      ); // preamble is an init marker, not a user-facing topic
      const docs = [];
      for (const fileName of fileNames) {
        try {
          const readResult = await callTool(
            client,
            "read_sdk_documentation_topic",
            { filename: fileName },
          );
          const content = getTextContent(readResult);
          // Skip topics whose content is itself an error response.
          if (content && !/^error[:\s]/i.test(content.trim())) {
            docs.push({ title: fileName, content });
          }
        } catch (e) {}
      }
      return { success: true, data: docs };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("search-docs", async (event, query) => {
    try {
      const result = await callTool(client, "search_sdk_hints", {
        prompt: query,
      });
      return {
        success: true,
        data: getTextContent(result) || JSON.stringify(result, null, 2),
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  async function checkForUpdates(isManualCheck = false) {
    try {
      const currentVersion = app.getVersion();
      const response = await fetch(
        `https://api.github.com/repos/JiriKrblich/Affinity-Script-Manager/releases/latest`,
      );
      if (!response.ok) throw new Error("Could not connect to GitHub.");

      const release = await response.json();
      const latestVersion = release.tag_name.replace("v", "");

      const v1 = latestVersion.split(".").map(Number);
      const v2 = currentVersion.split(".").map(Number);
      let isNewer = false;

      for (let i = 0; i < 3; i++) {
        if ((v1[i] || 0) > (v2[i] || 0)) {
          isNewer = true;
          break;
        }
        if ((v1[i] || 0) < (v2[i] || 0)) {
          break;
        }
      }

      if (isNewer) {
        win.webContents.send(
          "update-available",
          release.html_url,
          latestVersion,
        );
        const { response: btnIndex } = await dialog.showMessageBox(win, {
          type: "info",
          title: "Update Available",
          message: `A new version of Affinity Script Manager (v${latestVersion}) is available!`,
          detail: "Would you like to download it now?",
          buttons: ["Update", "Later"],
          defaultId: 0,
          cancelId: 1,
        });
        if (btnIndex === 0) shell.openExternal(release.html_url);
        return { success: true, hasUpdate: true };
      } else {
        return { success: true, hasUpdate: false };
      }
    } catch (error) {
      if (isManualCheck)
        dialog.showErrorBox("Update Check Failed", error.message);
      return { success: false, error: error.message };
    }
  }

  ipcMain.handle("check-updates", async () => await checkForUpdates(true));
  win.webContents.once("did-finish-load", () => checkForUpdates(false));

  win.loadFile("index.html");
});

app.on("window-all-closed", async () => {
  if (process.platform !== "darwin") {
    if (transport) await transport.close().catch(() => {});
    app.quit();
  }
});

// Activation of window for macOS when user closes window
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    win = new BrowserWindow({
      width: 1200,
      height: 820,
      title: "Script Manager for Affinity",
      minWidth: 960,
      minHeight: 600,
      backgroundColor: "#1f1f1f",
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
      },
    });
    win.loadFile("index.html");
  }
});
