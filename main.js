const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("node:path");
const fs = require("node:fs/promises");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  SSEClientTransport,
} = require("@modelcontextprotocol/sdk/client/sse.js");
const { CallToolResultSchema } = require("@modelcontextprotocol/sdk/types.js");
const { MODULES, compareSnapshots, affectedCalls } = require("./api-monitor");
const { APP_LANGUAGES, initialAppLanguage } = require("./language");
const { markScriptAvailability } = require("./community-availability");
const { topicNames, markdownForSnapshot, searchSnapshot } = require("./sdk-docs");

const SERVER_URLS = ["http://[::1]:6767/sse", "http://127.0.0.1:6767/sse"];
const DEFAULT_REPO =
  "https://raw.githubusercontent.com/JiriKrblich/Affinity-Community-Scripts/refs/heads/main/registry.json";
const COMMUNITY_ISSUES_URL =
  "https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new";

let client;
let transport;
let localScriptsDir;
let defaultScriptsDir;
let watchedScriptsDirs = [];
let watcherControllers = [];
let configPath;
let win;
const suppressWatchUntil = new Map();
ipcMain.on("app-version-sync", (e) => {
  e.returnValue = app.getVersion();
});

function createMainWindow() {
  return new BrowserWindow({
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
}

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

const apiSnapshotsDir = () => path.join(app.getPath("userData"), "docs_versions");
let apiSyncPromise = null;
let activeAffinityVersion = null;

async function affinityVersion() {
  const result = await callTool(client, "execute_script", {
    script: "const { Application } = require('/application.js'); console.log(Application.shortVersion);",
  });
  const version = getTextContent(result).trim();
  if (result.isError || !/^\d+(?:\.\d+){1,4}$/.test(version))
    throw new Error("Affinity did not return a usable version.");
  return version;
}

async function storedApiSnapshots() {
  let names;
  try { names = await fs.readdir(apiSnapshotsDir()); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const snapshots = [];
  for (const name of names.filter((n) => /^\d+(?:\.\d+){1,4}\.json$/.test(n))) {
    try {
      const snapshot = JSON.parse(await fs.readFile(path.join(apiSnapshotsDir(), name), "utf8"));
      if (typeof snapshot.version === "string" && typeof snapshot.capturedAt === "string" &&
          snapshot.modules && MODULES.every((m) => typeof snapshot.modules[m] === "string"))
        snapshots.push(snapshot);
    } catch (error) { console.warn("[API monitor] Ignoring unreadable snapshot:", name, error.message); }
  }
  return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
}

const sdkDocsCachePath = () => path.join(app.getPath("userData"), "sdk_docs_snapshot.json");
let sdkDocsPromise = null;

async function cachedSdkDocs() {
  try {
    const data = JSON.parse(await fs.readFile(sdkDocsCachePath(), "utf8"));
    if (typeof data.version === "string" && Array.isArray(data.topics) &&
        data.topics.every((topic) => typeof topic.title === "string" && typeof topic.content === "string"))
      return data;
  } catch {}
  return null;
}

async function completeSdkDocsSnapshot() {
  if (sdkDocsPromise) return sdkDocsPromise;
  sdkDocsPromise = (async () => {
    const cached = await cachedSdkDocs();
    let version;
    try { version = await affinityVersion(); }
    catch (error) {
      if (cached) return { snapshot: cached, cached: true };
      throw error;
    }
    if (cached?.version === version) return { snapshot: cached, cached: false };
    try {
      const list = await callTool(client, "list_sdk_documentation", {});
      const names = topicNames(list);
      const topics = [];
      for (const name of names) {
        let content;
        let lastError;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await callTool(client, "read_sdk_documentation_topic", { filename: name });
            content = getTextContent(result);
            if (!content || /^error[:\s]/i.test(content.trim()))
              throw new Error(content || "Empty response");
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (!content || /^error[:\s]/i.test(content.trim()))
          throw new Error(`Could not read ${name} from Affinity: ${lastError?.message || "Unknown error"}`);
        topics.push({ title: name, content });
        if (win && !win.isDestroyed())
          win.webContents.send("sdk-docs-progress", { done: topics.length, total: names.length });
      }
      const snapshot = { version, capturedAt: new Date().toISOString(), topics };
      const target = sdkDocsCachePath();
      const temporary = `${target}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(snapshot), "utf8");
      await fs.rename(temporary, target);
      return { snapshot, cached: false };
    } catch (error) {
      if (cached) return { snapshot: cached, cached: true };
      throw error;
    }
  })().finally(() => { sdkDocsPromise = null; });
  return sdkDocsPromise;
}

async function syncApiMonitor() {
  if (apiSyncPromise) return apiSyncPromise;
  apiSyncPromise = (async () => {
    const version = await affinityVersion();
    const existing = await storedApiSnapshots();
    if (existing.some((s) => s.version === version)) {
      activeAffinityVersion = version;
      return version;
    }
    const list = await callTool(client, "list_sdk_documentation", {});
    const available = new Set(parseCsvTextContent(list));
    if (!MODULES.every((name) => available.has(name)))
      throw new Error("Affinity did not provide all JSLib modules needed for comparison.");
    const modules = {};
    for (const name of MODULES) {
      const result = await callTool(client, "read_sdk_documentation_topic", { filename: name });
      const content = getTextContent(result);
      if (result.isError || !content || /^error[:\s]/i.test(content.trim()))
        throw new Error(`Could not read ${name} from Affinity.`);
      modules[name] = content;
    }
    const previous = existing[0] || null;
    const snapshot = {
      version, capturedAt: new Date().toISOString(), modules,
      previousVersion: previous?.version || null,
      changes: previous ? compareSnapshots(previous, { modules }) : [],
    };
    await fs.mkdir(apiSnapshotsDir(), { recursive: true });
    const target = path.join(apiSnapshotsDir(), `${version}.json`);
    const temporary = `${target}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(snapshot), "utf8");
    await fs.rename(temporary, target);
    activeAffinityVersion = version;
    for (const old of [...existing, snapshot].sort((a, b) => b.capturedAt.localeCompare(a.capturedAt)).slice(3))
      await fs.rm(path.join(apiSnapshotsDir(), `${old.version}.json`), { force: true });
    return version;
  })().finally(() => { apiSyncPromise = null; });
  return apiSyncPromise;
}

async function apiMonitorStatus() {
  const snapshots = await storedApiSnapshots();
  const current = snapshots.find((s) => s.version === activeAffinityVersion) || snapshots[0];
  const previous = snapshots.find((s) => s.version !== current?.version);
  return {
    currentVersion: current?.version || null,
    previousVersion: current?.previousVersion || previous?.version || null,
    changes: current?.changes || (current && previous ? compareSnapshots(previous, current) : []),
  };
}

// GitHub's raw CDN (raw.githubusercontent.com) caches files for ~5 minutes, so a
// freshly pushed registry.json / script can otherwise look stale when the app is
// reopened. Bust the edge cache with a unique query param + no-cache headers so we
// always pull the latest. Callers keep the clean URL for anything else (asset
// resolution, _source), passing it here only at the fetch call site.
async function fetchFresh(url, options = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const sep = url.includes("?") ? "&" : "?";
    const bustedUrl = `${url}${sep}_cb=${Date.now()}-${attempt}`;
    try {
      return await fetch(bustedUrl, {
        cache: "no-store",
        ...options,
        signal: options.signal || AbortSignal.timeout(20000),
        headers: {
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      if (attempt || options.signal?.aborted) throw error;
    }
  }
}

const scriptAvailabilityCache = new Map();
async function communityScriptExists(url) {
  const cached = scriptAvailabilityCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.exists;
  let response = await fetchFresh(url, { method: "HEAD", signal: AbortSignal.timeout(6000) });
  // Some custom repositories reject HEAD even though GET works.
  if (response.status === 405 || response.status === 501) {
    response = await fetchFresh(url, {
      headers: { Range: "bytes=0-0" },
      signal: AbortSignal.timeout(6000),
    });
    await response.body?.cancel();
  }
  const exists = response.status !== 404 && response.status !== 410;
  if (exists) scriptAvailabilityCache.set(url, { exists, expires: Date.now() + 5 * 60_000 });
  return exists;
}

function githubScriptLocation(script) {
  if (!script || typeof script.id !== "string" || !script.id.trim())
    throw new Error("This script has no registry ID.");
  const url = new URL(script.download_url);
  if (url.protocol !== "https:" || url.hostname !== "raw.githubusercontent.com")
    throw new Error("Version history is available for GitHub-hosted scripts only.");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4 || !url.pathname.endsWith(".js"))
    throw new Error("Invalid GitHub script URL.");
  const [owner, repo, ref, ...rest] = parts;
  const branchParts = ref === "refs" && rest[0] === "heads" ? rest.slice(1) : rest;
  const fileParts = ref === "refs" && rest[0] === "heads" ? branchParts.slice(1) : rest;
  const branch = ref === "refs" && rest[0] === "heads" ? branchParts[0] : ref;
  if (!owner || !repo || !branch || !fileParts.length ||
      [owner, repo, branch, ...fileParts].some((p) => p === "." || p === ".."))
    throw new Error("Invalid GitHub script URL.");
  return { owner, repo, branch, filePath: fileParts.join("/") };
}

async function githubScriptCommits(script) {
  const location = githubScriptLocation(script);
  const { owner, repo, branch, filePath } = location;
  const api = new URL(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`);
  api.searchParams.set("sha", branch);
  api.searchParams.set("path", filePath);
  api.searchParams.set("per_page", "10");
  const response = await fetch(api, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(response.status === 403 ? "GitHub request limit reached. Try again later." : `GitHub history unavailable (HTTP ${response.status}).`);
  const commits = await response.json();
  if (!Array.isArray(commits)) throw new Error("Invalid GitHub history response.");
  return { location, commits: commits.filter((c) => /^[a-f0-9]{40}$/.test(c.sha)).map((c) => ({
    sha: c.sha,
    date: c.commit?.committer?.date || c.commit?.author?.date || "",
    message: (c.commit?.message || "").split("\n")[0],
  })) };
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
let mcpLastActivity = 0;
const MCP_IDLE_RECONNECT_MS = 5 * 60 * 1000;

// Establish (or re-establish) the MCP session. Safe to call multiple times — concurrent callers
// share the same in-flight promise. Throws if the bridge is unreachable so callers can surface
// a real error instead of falling through with a stale client.
async function ensureMcpConnected() {
  if (mcpConnectPromise) return mcpConnectPromise;
  if (mcpConnected && client && transport && Date.now() - mcpLastActivity < MCP_IDLE_RECONNECT_MS) return;
  mcpConnectPromise = (async () => {
    try {
      mcpConnected = false;
      if (transport) {
        try {
          await transport.close();
        } catch {}
      }
      client = null;
      transport = null;
      let lastError;
      let connected = false;
      for (const url of SERVER_URLS) {
        const candidate = new Client({ name: "script-mgr-ui", version: "1.0.0" });
        const candidateTransport = new SSEClientTransport(new URL(url));
        try {
          await candidate.connect(candidateTransport);
          client = candidate;
          transport = candidateTransport;
          candidate.onclose = () => { if (client === candidate) mcpConnected = false; };
          candidate.onerror = () => { if (client === candidate) mcpConnected = false; };
          connected = true;
          break;
        } catch (error) {
          lastError = error;
          try { await candidateTransport.close(); } catch {}
        }
      }
      if (!connected) throw lastError || new Error("Affinity MCP is unavailable.");
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
      mcpLastActivity = Date.now();
    } catch (err) {
      mcpConnected = false;
      throw err;
    } finally {
      mcpConnectPromise = null;
    }
  })();
  return mcpConnectPromise;
}

function isRecoverableMcpSessionError(error) {
  const msg = error && error.message ? error.message : String(error);
  return /session not initialized|session not found|not connected|disconnected|closed|http 404|fetch failed|econnreset|econnrefused|econnaborted|epipe|network error|timed out|timeout/i.test(
    msg,
  );
}

function canRetryMcpTool(name, error) {
  if (!["save_script_to_library", "execute_script", "add_sdk_hint", "report_sdk_issue"].includes(name)) return true;
  // Repeating a write or script execution after an uncertain transport failure can duplicate effects.
  return /session not initialized|session not found|not connected|http 404/i.test(error.message || "");
}

async function callTool(_clientIgnored, name, args) {
  await ensureMcpConnected();
  const request = () => client.request(
    { method: "tools/call", params: { name, arguments: args } },
    CallToolResultSchema,
  );
  try {
    const result = await request();
    mcpLastActivity = Date.now();
    if (result.isError) throw new Error(getTextContent(result) || `${name} failed in Affinity.`);
    return result;
  } catch (err) {
    // If the session dropped (bridge restarted, etc.), reconnect once and retry.
    if (isRecoverableMcpSessionError(err)) {
      mcpConnected = false;
      if (!canRetryMcpTool(name, err)) throw err;
      await ensureMcpConnected();
      const result = await request();
      mcpLastActivity = Date.now();
      if (result.isError) throw new Error(getTextContent(result) || `${name} failed in Affinity.`);
      return result;
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
  if (!APP_LANGUAGES.includes(config.language)) {
    config.language = config.language == null
      ? initialAppLanguage(app.getPreferredSystemLanguages()[0]) : "en";
    needsSave = true;
  }
  if (!["spaces", "tabs"].includes(config.editorIndentStyle)) {
    config.editorIndentStyle = "spaces";
    needsSave = true;
  }
  if (!Number.isInteger(config.editorTabSize) || config.editorTabSize < 1 || config.editorTabSize > 8) {
    config.editorTabSize = 2;
    needsSave = true;
  }
  if (config.scriptsDirectory !== null &&
      (typeof config.scriptsDirectory !== "string" || !path.isAbsolute(config.scriptsDirectory))) {
    config.scriptsDirectory = null;
    needsSave = true;
  }
  if (!Array.isArray(config.watchedFolders)) {
    config.watchedFolders = [];
    needsSave = true;
  }
  config.watchedFolders = [...new Set(config.watchedFolders.filter((p) => typeof p === "string" && path.isAbsolute(p)))];

  if (needsSave) await saveConfig(config);
  return config;
}

async function saveConfig(config) {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
}

function sameDirectory(a, b) {
  const normalize = (p) => process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);
  return normalize(a) === normalize(b);
}

async function scriptFiles(directory) {
  return (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
    .map((entry) => entry.name);
}

async function folderChangePlan(target) {
  if (typeof target !== "string" || !path.isAbsolute(target)) throw new Error("Choose an absolute folder path.");
  const stat = await fs.stat(target);
  if (!stat.isDirectory()) throw new Error("The selected path is not a folder.");
  const source = localScriptsDir;
  const sourceReal = await fs.realpath(source).catch(() => null);
  const targetReal = await fs.realpath(target);
  let sourceFiles = [];
  let sourceError = null;
  try { sourceFiles = await scriptFiles(source); }
  catch (error) { sourceError = error.message; }
  const targetFiles = await scriptFiles(target);
  const key = (name) => process.platform === "win32" ? name.toLowerCase() : name;
  const targetNames = new Set(targetFiles.map(key));
  return {
    source,
    target,
    same: sameDirectory(source, target) || (sourceReal && sameDirectory(sourceReal, targetReal)),
    sourceCount: sourceFiles.length,
    sourceError,
    targetCount: targetFiles.length,
    conflicts: sourceFiles.filter((name) => targetNames.has(key(name))),
  };
}

async function moveScriptsToFolder(source, target, choices) {
  const sourceFiles = await scriptFiles(source);
  const targetFiles = await scriptFiles(target);
  const key = (name) => process.platform === "win32" ? name.toLowerCase() : name;
  const occupied = new Set(targetFiles.map(key));
  const operations = [];
  const skipped = [];
  for (const name of sourceFiles) {
    let destination = name;
    let existing = occupied.has(key(name));
    if (existing) {
      const choice = choices?.[name];
      if (choice === "keep") { skipped.push(name); continue; }
      if (choice === "rename") {
        const stem = path.parse(name).name;
        let suffix = 1;
        do { destination = `${stem}-imported-${suffix++}.js`; }
        while (occupied.has(key(destination)));
        existing = false;
      } else if (choice !== "replace") {
        throw new Error(`Choose how to handle duplicate ${name}.`);
      }
    }
    occupied.add(key(destination));
    operations.push({ name, destination, replace: existing });
  }

  const staging = await fs.mkdtemp(path.join(target, ".asm-migration-"));
  const completed = [];
  try {
    for (let i = 0; i < operations.length; i++) {
      await fs.copyFile(path.join(source, operations[i].name), path.join(staging, `new-${i}`));
    }
    for (let i = 0; i < operations.length; i++) {
      const op = operations[i];
      const destination = path.join(target, op.destination);
      const backup = path.join(staging, `old-${i}`);
      if (!op.replace) {
        try { await fs.access(destination); throw new Error(`Destination changed during move: ${op.destination}`); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      if (op.replace) await fs.rename(destination, backup);
      try {
        await fs.rename(path.join(staging, `new-${i}`), destination);
      } catch (error) {
        if (op.replace) await fs.rename(backup, destination);
        throw error;
      }
      completed.push({ destination, backup: op.replace ? backup : null });
    }
    return {
      moved: operations.map((op) => op.name), skipped,
      async rollback() {
        for (const item of completed.reverse()) {
          await fs.unlink(item.destination);
          if (item.backup) await fs.rename(item.backup, item.destination);
        }
        await fs.rm(staging, { recursive: true, force: true });
      },
      async finish() {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        const leftBehind = [...skipped];
        for (const op of operations) {
          try {
            const original = await fs.readFile(path.join(source, op.name));
            const copied = await fs.readFile(path.join(target, op.destination));
            if (!original.equals(copied)) { leftBehind.push(op.name); continue; }
            await fs.unlink(path.join(source, op.name));
          } catch { leftBehind.push(op.name); }
        }
        return leftBehind;
      },
    };
  } catch (error) {
    for (const item of completed.reverse()) {
      await fs.unlink(item.destination).catch(() => {});
      if (item.backup) await fs.rename(item.backup, item.destination).catch(() => {});
    }
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function hasDuplicateScriptTitle(currentPath, title) {
  const normalized = String(title || "").toLowerCase();
  for (const directory of new Set([localScriptsDir, ...watchedScriptsDirs])) {
    let files;
    try { files = await scriptFiles(directory); } catch { continue; }
    for (const file of files) {
      const full = path.join(directory, file);
      if (full === currentPath) continue;
      try {
        const code = (await fs.readFile(full, "utf8")).slice(0, 4096);
        const meta = parseScriptMetadata(code, path.parse(file).name);
        if (meta.name.toLowerCase() === normalized) return true;
      } catch {}
    }
  }
  return false;
}

// --- Watch mode: re-push edited scripts to the bridge and notify the renderer ---
async function startWatcher(directory, signal) {
  const pending = new Map(); // filename -> timer (debounce)

  const handleChange = async (filename) => {
    if (signal.aborted) return;
    if (!filename || !filename.endsWith(".js")) return;
    const full = path.join(directory, filename);
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
        if (Date.now() < (suppressWatchUntil.get(full) || 0)) {
          if (win && !win.isDestroyed()) win.webContents.send("local-scripts-changed");
          return;
        }
        const listResult = await callTool(client, "list_library_scripts", {});
        const titles = parseCsvTextContent(listResult).map((t) =>
          t.toLowerCase(),
        );
        const code = await fs.readFile(full, "utf8");
        const metadata = parseScriptMetadata(code, path.parse(filename).name);
        const stem = path.parse(filename).name.toLowerCase();
        if ((titles.includes(stem) || titles.includes(metadata.name.toLowerCase())) &&
            !(await hasDuplicateScriptTitle(full, metadata.name))) {
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
        if (!signal.aborted) handleChange(filename);
      }, 300),
    );
  };

  try {
    const watcher = fs.watch(directory, { signal });
    for await (const { filename } of watcher) {
      debounced(filename);
    }
  } catch (err) {
    if (err.name === "AbortError" || signal.aborted) return;
    console.warn("watch mode falling back to polling:", directory, err.message);
    const seen = new Map();
    while (!signal.aborted) {
      try {
        const files = await scriptFiles(directory);
        const present = new Set(files);
        for (const filename of files) {
          const stat = await fs.stat(path.join(directory, filename));
          const marker = `${stat.mtimeMs}:${stat.size}`;
          if (seen.has(filename) && seen.get(filename) !== marker) debounced(filename);
          seen.set(filename, marker);
        }
        for (const filename of seen.keys()) if (!present.has(filename)) seen.delete(filename);
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
}

function restartWatchers() {
  watcherControllers.forEach((controller) => controller.abort());
  watcherControllers = [];
  for (const directory of new Set([localScriptsDir, ...watchedScriptsDirs])) {
    const controller = new AbortController();
    watcherControllers.push(controller);
    startWatcher(directory, controller.signal);
  }
}

app.whenReady().then(async () => {
  defaultScriptsDir = path.join(app.getPath("userData"), "MyScripts");
  configPath = path.join(app.getPath("userData"), "config.json");
  await fs.mkdir(defaultScriptsDir, { recursive: true });
  const startupConfig = await getConfig();
  localScriptsDir = startupConfig.scriptsDirectory || defaultScriptsDir;
  watchedScriptsDirs = startupConfig.watchedFolders;

  // Eagerly attempt to connect so the Server Bridge status is accurate on first paint;
  // failure is non-fatal — ensureMcpConnected() will retry on demand when a tool call
  // happens (user opens Documentation, SDK search, etc.).
  ensureMcpConnected().catch((err) =>
    console.warn("[MCP] initial connect failed:", err.message),
  );

  restartWatchers(); // fire-and-forget

  win = createMainWindow();

  // ==========================================
  // --- LOCAL SCRIPTS & MCP ---
  // ==========================================

  ipcMain.handle("get-affinity-health", async () => {
    const started = Date.now();
    try {
      const result = await callTool(client, "execute_script", {
        script: "const { Environment } = require('/environment.js'); const { Application } = require('/application.js'); console.log(JSON.stringify({ permissions: Environment.permissions, roots: Environment.fileSystemRoots, desktopPath: Application.userDesktopPath }));",
      });
      const output = getTextContent(result).trim();
      const data = JSON.parse(output.split(/\r?\n/).at(-1));
      if (!data || typeof data.permissions !== "object" || !Array.isArray(data.roots))
        throw new Error("Affinity returned incomplete permission information.");
      const desktop = path.resolve(String(data.desktopPath || ""));
      const desktopAllowed = !!data.permissions.fileSystem && !!data.desktopPath && data.roots.some((root) => {
        const relative = path.relative(path.resolve(String(root)), desktop);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
      });
      return { success: true, data: {
        ...data,
        desktopAllowed,
        latencyMs: Date.now() - started,
        serverVersion: client.getServerVersion()?.version || null,
      } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-script-folders", async () => ({
    success: true,
    data: { primary: localScriptsDir, default: defaultScriptsDir, watched: watchedScriptsDirs },
  }));

  ipcMain.handle("open-script-folder", async (event, folder) => {
    try {
      const selected = folder || localScriptsDir;
      if (![localScriptsDir, ...watchedScriptsDirs].some((p) => sameDirectory(p, selected)))
        throw new Error("Folder is not in the library.");
      const error = await shell.openPath(selected);
      if (error) throw new Error(error);
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("choose-script-folder", async () => {
    const result = await dialog.showOpenDialog(win, {
      properties: ["openDirectory"], defaultPath: localScriptsDir,
    });
    return result.canceled ? { success: false, canceled: true } : { success: true, path: result.filePaths[0] };
  });

  ipcMain.handle("plan-script-folder-change", async (event, target) => {
    try { return { success: true, data: await folderChangePlan(target) }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("apply-script-folder-change", async (event, target, move, choices) => {
    try {
      const plan = await folderChangePlan(target);
      if (plan.same) return { success: true, data: { ...plan, leftBehind: [] } };
      if (move && plan.sourceError) throw new Error(`Cannot move scripts from the current folder: ${plan.sourceError}`);
      const config = await getConfig();
      const migration = move ? await moveScriptsToFolder(plan.source, plan.target, choices) : null;
      config.scriptsDirectory = sameDirectory(target, defaultScriptsDir) ? null : target;
      const oldWatched = config.watchedFolders;
      config.watchedFolders = oldWatched.filter((p) => !sameDirectory(p, target));
      if (((!move && plan.sourceCount) || migration?.skipped.length) && !config.watchedFolders.some((p) => sameDirectory(p, plan.source)))
        config.watchedFolders.push(plan.source);
      try { await saveConfig(config); }
      catch (error) {
        if (migration) await migration.rollback();
        throw error;
      }
      localScriptsDir = target;
      watchedScriptsDirs = config.watchedFolders;
      restartWatchers();
      const leftBehind = migration ? await migration.finish() : plan.sourceCount ? await scriptFiles(plan.source) : [];
      if (leftBehind.length && !config.watchedFolders.some((p) => sameDirectory(p, plan.source))) {
        config.watchedFolders.push(plan.source);
        await saveConfig(config);
        watchedScriptsDirs = config.watchedFolders;
        restartWatchers();
      }
      win.webContents.send("local-scripts-changed");
      return { success: true, data: { primary: target, leftBehind } };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("add-watched-folder", async (event, folder) => {
    try {
      if (typeof folder !== "string" || !path.isAbsolute(folder)) throw new Error("Invalid folder path.");
      if (!(await fs.stat(folder)).isDirectory()) throw new Error("Selected path is not a folder.");
      if (sameDirectory(folder, localScriptsDir) ||
          await fs.realpath(folder) === await fs.realpath(localScriptsDir).catch(() => null))
        throw new Error("This is already the main scripts folder.");
      const config = await getConfig();
      if (!config.watchedFolders.some((p) => sameDirectory(p, folder))) config.watchedFolders.push(folder);
      await saveConfig(config);
      watchedScriptsDirs = config.watchedFolders;
      restartWatchers();
      win.webContents.send("local-scripts-changed");
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("remove-watched-folder", async (event, folder) => {
    try {
      const config = await getConfig();
      config.watchedFolders = config.watchedFolders.filter((p) => !sameDirectory(p, folder));
      await saveConfig(config);
      watchedScriptsDirs = config.watchedFolders;
      restartWatchers();
      win.webContents.send("local-scripts-changed");
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("list-watched-scripts", async () => {
    const data = [];
    const errors = [];
    for (const folder of watchedScriptsDirs) {
      try {
        for (const file of await scriptFiles(folder)) {
          const full = path.join(folder, file);
          const stat = await fs.stat(full);
          const code = await fs.readFile(full, "utf8");
          data.push({ folder, file, ...parseScriptMetadata(code, path.parse(file).name),
            size: stat.size, modified: stat.mtimeMs });
        }
      } catch (error) { errors.push({ folder, error: error.message }); }
    }
    return { success: true, data, errors };
  });

  ipcMain.handle("push-watched-script", async (event, folder, filename) => {
    try {
      if (!watchedScriptsDirs.some((p) => sameDirectory(p, folder))) throw new Error("Folder is not watched.");
      const file = assertLocalScriptFilename(filename);
      const code = await fs.readFile(path.join(folder, file), "utf8");
      const meta = parseScriptMetadata(code, path.parse(file).name);
      await callTool(client, "save_script_to_library", {
        title: meta.name, description: meta.description, code,
      });
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

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

  ipcMain.handle("list-community-scripts", async (event, verifyFiles = false) => {
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
      return {
        success: true,
        data: verifyFiles
          ? await markScriptAvailability(allScripts, communityScriptExists)
          : allScripts,
        errors: repoErrors,
      };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("list-script-history", async (event, script) => {
    try {
      const { location, commits } = await githubScriptCommits(script);
      const { owner, repo, filePath } = location;
      const data = await Promise.all(commits.map(async (commit) => {
        const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit.sha}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
        try {
          const response = await fetch(rawUrl);
          if (!response.ok) return commit;
          const code = await response.text();
          return { ...commit, version: parseScriptMetadata(code).version };
        } catch {
          return commit;
        }
      }));
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("save-script-revision", async (event, script, sha, action = "copy", targetFilename) => {
    try {
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid revision.");
      if (!["copy", "install", "downgrade"].includes(action)) throw new Error("Invalid revision action.");
      const { location, commits } = await githubScriptCommits(script);
      if (!commits.some((commit) => commit.sha === sha))
        throw new Error("Revision is not in this script's recent history.");
      const { owner, repo, filePath } = location;
      const rawUrl = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${sha}/${filePath.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetch(rawUrl);
      if (!response.ok) throw new Error(`Cannot download revision (HTTP ${response.status}).`);
      const code = await response.text();
      const meta = parseScriptMetadata(code, script.name || script.id);
      const copyCode = upsertMetadataHeader(code, { name: `${meta.name} (rev ${sha.slice(0, 7)})` });
      const base = localScriptFilenameFromInput(script.name || script.id).replace(/\.js$/, "");
      if (action !== "copy") {
        const filename = action === "downgrade" ? assertLocalScriptFilename(targetFilename) : `${base}.js`;
        const fullPath = path.join(localScriptsDir, filename);
        const historicalCode = upsertMetadataHeader(code, {
          name: meta.name || script.name,
          description: meta.description || script.description,
          author: meta.author || script.author,
        });
        if (action === "install") {
          await fs.writeFile(fullPath, historicalCode, { encoding: "utf8", flag: "wx" });
          try {
            await callTool(client, "save_script_to_library", {
              title: meta.name || script.name,
              description: meta.description || script.description || "",
              code: historicalCode,
            });
            return { success: true, filename, version: meta.version, installed: true };
          } catch (error) {
            return { success: true, filename, version: meta.version, installed: false,
              warning: `Saved in My Scripts, but Affinity installation failed: ${error.message}` };
          }
        }
        const currentCode = await fs.readFile(fullPath, "utf8");
        let backup;
        let backedUp = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          backup = `${base}-backup-${Date.now()}${attempt ? `-${attempt}` : ""}.js`;
          try {
            await fs.writeFile(path.join(localScriptsDir, backup), currentCode, { encoding: "utf8", flag: "wx" });
            backedUp = true;
            break;
          } catch (error) {
            if (error.code !== "EEXIST") throw error;
          }
        }
        if (!backedUp) throw new Error("Could not back up the current script.");
        suppressWatchUntil.set(fullPath, Date.now() + 3000);
        await fs.writeFile(fullPath, historicalCode, "utf8");
        return { success: true, filename, backup, version: meta.version };
      }
      let filename;
      for (let attempt = 0; attempt < 100; attempt++) {
        filename = `${base}-${sha.slice(0, 7)}${attempt ? `-${attempt + 1}` : ""}.js`;
        try {
          await fs.writeFile(path.join(localScriptsDir, filename), copyCode, { encoding: "utf8", flag: "wx" });
          return { success: true, filename, version: meta.version };
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      throw new Error("Could not create a unique local filename.");
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

  ipcMain.handle("get-editor-settings", async () => {
    try {
      const config = await getConfig();
      return { success: true, data: { indentStyle: config.editorIndentStyle, tabSize: config.editorTabSize } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-locale", async (event, language) => {
    try {
      if (typeof language !== "string" || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(language))
        throw new Error("Invalid language code.");
      const readMessages = async (code) => {
        const content = await fs.readFile(path.join(__dirname, "locales", `${code}.json`), "utf8");
        const messages = JSON.parse(content);
        if (!messages || typeof messages !== "object" || Array.isArray(messages) ||
            Object.values(messages).some((value) => typeof value !== "string"))
          throw new Error(`Invalid ${code} language dictionary.`);
        return messages;
      };
      const english = await readMessages("en");
      const translated = language === "en" ? {} : await readMessages(language);
      return { success: true, data: { ...english, ...translated } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-app-language", async () => {
    try {
      const config = await getConfig();
      return { success: true, data: config.language };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("set-app-language", async (event, language) => {
    try {
      if (!APP_LANGUAGES.includes(language)) throw new Error("Unsupported language.");
      const config = await getConfig();
      config.language = language;
      await saveConfig(config);
      return { success: true, data: language };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("set-editor-settings", async (event, settings) => {
    try {
      if (!["spaces", "tabs"].includes(settings?.indentStyle) || !Number.isInteger(settings?.tabSize) || settings.tabSize < 1 || settings.tabSize > 8)
        throw new Error("Invalid editor indentation settings.");
      const config = await getConfig();
      config.editorIndentStyle = settings.indentStyle;
      config.editorTabSize = settings.tabSize;
      await saveConfig(config);
      return { success: true, data: { indentStyle: config.editorIndentStyle, tabSize: config.editorTabSize } };
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
          return { success: true, installed: true };
        } catch (mcpErr) {
          return { success: true, installed: false, warning: mcpErr.message };
        }
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
      return { success: true, data: topicNames(listResult).map((title) => ({ title })) };
    } catch (error) {
      const cached = await cachedSdkDocs();
      if (cached) return {
        success: true, data: cached.topics.map(({ title }) => ({ title })),
        cached: true, version: cached.version,
      };
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("read-doc-topic", async (event, filename) => {
    try {
      if (typeof filename !== "string" || !/^[a-zA-Z0-9/_-]+\.(js|json)$/.test(filename) ||
          filename.split("/").includes(".."))
        throw new Error("Invalid documentation topic.");
      const result = await callTool(client, "read_sdk_documentation_topic", { filename });
      const content = getTextContent(result);
      if (result.isError || !content || /^error[:\s]/i.test(content.trim()))
        throw new Error(`Affinity could not load ${filename}.`);
      return { success: true, data: content };
    } catch (error) {
      const cached = await cachedSdkDocs();
      const topic = cached?.topics.find((item) => item.title === filename);
      if (topic) return { success: true, data: topic.content, cached: true, version: cached.version };
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("search-docs", async (event, query) => {
    try {
      const { snapshot, cached } = await completeSdkDocsSnapshot();
      return { success: true, data: {
        results: searchSnapshot(snapshot, query), version: snapshot.version, cached,
      } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("export-docs", async () => {
    try {
      const { snapshot, cached } = await completeSdkDocsSnapshot();
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: "Export Affinity SDK documentation",
        defaultPath: `Affinity-SDK-${snapshot.version}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (canceled || !filePath) return { success: true, canceled: true };
      await fs.writeFile(filePath, markdownForSnapshot(snapshot), "utf8");
      return { success: true, data: { filePath, version: snapshot.version, cached } };
    } catch (error) {
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle("get-api-monitor", async () => {
    try { return { success: true, data: await apiMonitorStatus() }; }
    catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("sync-api-monitor", async () => {
    try {
      await syncApiMonitor();
      return { success: true, data: await apiMonitorStatus() };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle("scan-api-compatibility", async () => {
    try {
      const { changes } = await apiMonitorStatus();
      if (!changes.length) return { success: true, data: { scripts: [], failed: 0 } };
      const list = await callTool(client, "list_library_scripts", {});
      const listText = getTextContent(list).trim();
      const titles = !listText || listText === "{}" ? [] : parseCsvTextContent(list);
      const scripts = [];
      let failed = 0;
      for (const title of titles) {
        try {
          const result = await callTool(client, "read_library_script", { title });
          if (result.isError) throw new Error("Could not read script.");
          const calls = affectedCalls(getTextContent(result), changes);
          if (calls.length) scripts.push({ title, calls });
        } catch { failed++; }
      }
      return { success: true, data: { scripts, failed } };
    } catch (error) { return { success: false, error: error.message }; }
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

  // A version check is cheap when a snapshot already exists; new versions trigger the JSLib capture.
  setTimeout(() => syncApiMonitor().catch((error) =>
    console.warn("[API monitor] Sync deferred:", error.message)), 5000);

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
    win = createMainWindow();
    win.loadFile("index.html");
  }
});
