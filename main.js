const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { CallToolResultSchema } = require("@modelcontextprotocol/sdk/types.js");

const SERVER_URL = "http://localhost:6767/sse";
const DEFAULT_REPO = 'https://raw.githubusercontent.com/JiriKrblich/Affinity-Community-Scripts/refs/heads/main/registry.json';

let client;
let transport;
let localScriptsDir;
let configPath;
let win; 
ipcMain.on('app-version-sync', (e) => { e.returnValue = app.getVersion(); });

// --- Helper Functions ---
function getTextContent(result) {
  return (result.content || []).filter((i) => i && i.type === "text").map((i) => i.text).join("\n");
}

function parseCsvTextContent(result) {
  const textChunks = (result.content || []).filter((i) => i && i.type === "text").map((i) => i.text);
  return [...new Set(textChunks.join(",").split(",").map((n) => n.trim()).filter(Boolean))];
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
      if (transport) { try { await transport.close(); } catch {} }
      client = new Client({ name: "script-mgr-ui", version: "1.0.0" });
      transport = new SSEClientTransport(new URL(SERVER_URL));
      await client.connect(transport);
      // Affinity's MCP requires reading the preamble doc once per session before other
      // SDK-doc tools will return real data — otherwise list_sdk_documentation etc. respond
      // with an "ERROR: Listing failed" payload. Prime it best-effort.
      try {
        await client.request(
          { method: "tools/call", params: { name: "read_sdk_documentation_topic", arguments: { filename: "preamble" } } },
          CallToolResultSchema
        );
      } catch (primeErr) {
        console.warn('[MCP] preamble prime failed:', primeErr.message);
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
    return await client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
  } catch (err) {
    // If the session dropped (bridge restarted, etc.), reconnect once and retry.
    const msg = (err && err.message) ? err.message : String(err);
    if (/session not initialized|not connected|disconnected|closed/i.test(msg)) {
      mcpConnected = false;
      await ensureMcpConnected();
      return client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
    }
    throw err;
  }
}

// --- Bezpečná správa konfigurace ---
async function getConfig() {
  let config = {};
  let needsSave = false;

  try {
    const data = await fs.readFile(configPath, 'utf8');
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

  if (needsSave) await saveConfig(config);
  return config;
}

async function saveConfig(config) {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
}

// --- Watch mode: re-push edited scripts to the bridge and notify the renderer ---
async function startWatcher() {
  const pending = new Map(); // filename -> timer (debounce)

  const handleChange = async (filename) => {
    if (!filename || !filename.endsWith('.js')) return;
    const full = path.join(localScriptsDir, filename);
    let exists = false;
    try { await fs.stat(full); exists = true; } catch {}

    if (exists) {
      // Only auto-sync if the script is already installed in Affinity. New or
      // newly-saved files stay local until the user explicitly clicks the
      // install dot in My Scripts.
      try {
        const listResult = await callTool(client, "list_library_scripts", {});
        const titles = parseCsvTextContent(listResult).map(t => t.toLowerCase());
        const stem = path.parse(filename).name.toLowerCase();
        if (titles.includes(stem)) {
          const code = await fs.readFile(full, 'utf8');
          await callTool(client, "save_script_to_library", {
            title: path.parse(filename).name,
            description: "Updated via Script Manager watch mode",
            code,
          }).catch(() => {});
        }
      } catch {} // bridge offline or not installed — renderer still gets the change ping
    }
    if (win && !win.isDestroyed()) win.webContents.send('local-scripts-changed');
  };

  const debounced = (filename) => {
    const prev = pending.get(filename);
    if (prev) clearTimeout(prev);
    pending.set(filename, setTimeout(() => {
      pending.delete(filename);
      handleChange(filename);
    }, 300));
  };

  try {
    const watcher = fs.watch(localScriptsDir);
    for await (const { filename } of watcher) {
      debounced(filename);
    }
  } catch (err) {
    console.warn('watch mode error:', err.message);
  }
}

app.whenReady().then(async () => {
  localScriptsDir = path.join(app.getPath('userData'), 'MyScripts');
  configPath = path.join(app.getPath('userData'), 'config.json');
  await fs.mkdir(localScriptsDir, { recursive: true });

  // Eagerly attempt to connect so the Server Bridge status is accurate on first paint;
  // failure is non-fatal — ensureMcpConnected() will retry on demand when a tool call
  // happens (user opens Documentation, SDK search, etc.).
  ensureMcpConnected().catch((err) => console.warn('[MCP] initial connect failed:', err.message));

  startWatcher(); // fire-and-forget

  win = new BrowserWindow({
    width: 1200, height: 820, title: "Affinity Script Manager",
    minWidth: 960, minHeight: 600,
    backgroundColor: '#1f1f1f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });

  // ==========================================
  // --- LOCAL SCRIPTS & MCP ---
  // ==========================================

  ipcMain.handle('list-local-scripts', async () => {
    try {
      const files = (await fs.readdir(localScriptsDir)).filter(f => f.endsWith('.js'));
      const out = [];
      for (const file of files) {
        const full = path.join(localScriptsDir, file);
        const stat = await fs.stat(full);
        let name = path.parse(file).name;
        let description = '';
        let version = '';
        try {
          const head = (await fs.readFile(full, 'utf8')).slice(0, 4096);
          const m = head.match(/^\s*\/\*\*([\s\S]*?)\*\//);
          if (m) {
            const h = m[1];
            const n = h.match(/name:\s*(.+)/i);         if (n) name = n[1].trim();
            const d = h.match(/description:\s*(.+)/i);   if (d) description = d[1].trim();
            const v = h.match(/version:\s*(.+)/i);       if (v) version = v[1].trim();
          }
        } catch {}
        out.push({ file, name, description, version, size: stat.size, modified: stat.mtimeMs });
      }
      return { success: true, data: out };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('delete-local-script', async (e, filename) => {
    try {
      await fs.unlink(path.join(localScriptsDir, filename));
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('read-local-script', async (e, filename) => {
    try {
      const code = await fs.readFile(path.join(localScriptsDir, filename), 'utf8');
      return { success: true, data: { code } };
    } catch (err) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('save-local-script', async (e, filename, code) => {
    try {
      await fs.writeFile(path.join(localScriptsDir, filename), code, 'utf8');
      return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  ipcMain.handle('select-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { 
      properties: ['openFile'], 
      filters: [{ name: 'JavaScript', extensions: ['js'] }] 
    });
    
    if (canceled || filePaths.length === 0) return { success: false };
    
    const code = await fs.readFile(filePaths[0], "utf8");
    
    // Výchozí hodnoty (pokud skript nemá hlavičku)
    let parsedName = path.parse(filePaths[0]).name;
    let parsedDesc = "";

    // Pokusíme se najít hlavičku /** ... */ na začátku souboru
    const headerMatch = code.match(/^\s*\/\*\*([\s\S]*?)\*\//);
    if (headerMatch) {
      const headerContent = headerMatch[1];
      
      // Vytažení hodnot pomocí Regexu
      const nameMatch = headerContent.match(/name:\s*(.+)/i);
      const descMatch = headerContent.match(/description:\s*(.+)/i);
      
      if (nameMatch) parsedName = nameMatch[1].trim();
      if (descMatch) parsedDesc = descMatch[1].trim();
    }

    return { success: true, data: { name: parsedName, description: parsedDesc, code } };
  });

  ipcMain.handle('export-to-disk', async (event, filename) => {
    try {
      const code = await fs.readFile(path.join(localScriptsDir, filename), "utf8");
      const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: filename });
      if (canceled || !filePath) return { success: false, error: 'Cancelled' };
      await fs.writeFile(filePath, code, "utf8");
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('push-to-mcp', async (event, filename) => {
    try {
      const filePath = path.join(localScriptsDir, filename);
      const code = await fs.readFile(filePath, "utf8");
      await callTool(client, "save_script_to_library", { title: path.parse(filename).name, description: "Pushed from Local Library", code });
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });


  ipcMain.handle('list-mcp-scripts', async () => {
    try {
      const result = await callTool(client, "list_library_scripts", {});
      return { success: true, data: getTextContent(result) || result };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // "Add Script" — writes to disk only. Does NOT push to MCP: installation is an explicit
  // action via the install dot on the My Scripts row.
  ipcMain.handle('save-script', async (event, title, description, code) => {
    try {
      const safeFilename = title.toLowerCase().replace(/[^a-z0-9_-]/g, '-') + '.js';
      await fs.writeFile(path.join(localScriptsDir, safeFilename), code, "utf8");
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('download-from-mcp', async (event, mcpTitle, localName) => {
    try {
      const result = await callTool(client, "read_library_script", { title: mcpTitle });
      const code = getTextContent(result);
      if (!code) return { success: false, error: "Empty script." };
      const safeFilename = localName.toLowerCase().replace(/[^a-z0-9_-]/g, '-') + '.js';
      await fs.writeFile(path.join(localScriptsDir, safeFilename), code, "utf8");
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // ==========================================
  // --- COMMUNITY SCRIPTS & SETTINGS ---
  // ==========================================

  ipcMain.handle('get-repos', async () => {
    const config = await getConfig();
    return { success: true, data: config.repositories };
  });

  ipcMain.handle('add-repo', async (event, url) => {
    try {
      let rawUrl = url;
      
      if (url.includes('github.com')) {
        const match = url.match(/github\.com\/([^\/]+\/[^\/\?#]+)/);
        if (match) {
          const cleanRepo = match[1].replace('.git', '');
          rawUrl = `https://raw.githubusercontent.com/${cleanRepo}/refs/heads/main/registry.json`;
        } else {
          return { success: false, error: "Invalid GitHub URL format. Use https://github.com/user/repo" };
        }
      } else if (!url.includes('raw.githubusercontent.com')) {
        return { success: false, error: "Please provide a valid GitHub repository URL." };
      }

      const config = await getConfig();
      if (!config.repositories.includes(rawUrl)) {
        config.repositories.push(rawUrl);
        await saveConfig(config);
        win.webContents.send('repos-changed'); 
      }
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('remove-repo', async (event, url) => {
    if (url === DEFAULT_REPO) return { success: false, error: "Cannot remove default repository." };
    try {
      const config = await getConfig();
      config.repositories = config.repositories.filter(r => r !== url);
      await saveConfig(config);
      win.webContents.send('repos-changed'); 
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('list-community-scripts', async () => {
    try {
      const config = await getConfig();
      let allScripts = [];

      for (const url of config.repositories) {
        try {
          const response = await fetch(url);
          if (response.ok) {
            const registry = await response.json();
            const scriptsWithSource = (registry.scripts || []).map(script => ({ ...script, _source: url }));
            allScripts = allScripts.concat(scriptsWithSource);
          }
        } catch (err) {
          console.warn(`Failed to fetch repo: ${url}`);
        }
      }
      return { success: true, data: allScripts }; 
    } catch (error) { 
      return { success: false, error: error.message }; 
    }
  });

  ipcMain.handle('download-community-script', async (event, downloadUrl, filename) => {
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error("Error downloading file from server.");
      const code = await response.text();
      const safeName = filename.toLowerCase().replace(/[^a-z0-9_-]/g, '-') + '.js';

      await fs.writeFile(path.join(localScriptsDir, safeName), code, "utf8");

      try {
        await callTool(client, "save_script_to_library", { title: filename, description: "Installed from Community Scripts", code });
      } catch (mcpErr) {}

      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // Save-only: download to disk without pushing to the MCP bridge. Used by the "save" icon
  // next to Install on community cards, for users who want to inspect / edit before activating.
  ipcMain.handle('save-community-script', async (event, downloadUrl, filename) => {
    try {
      const response = await fetch(downloadUrl);
      if (!response.ok) throw new Error("Error downloading file from server.");
      const code = await response.text();
      const safeName = filename.toLowerCase().replace(/[^a-z0-9_-]/g, '-') + '.js';
      await fs.writeFile(path.join(localScriptsDir, safeName), code, "utf8");
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // ==========================================
  // --- DOCUMENTATION, SEARCH & UPDATES ---
  // ==========================================

  ipcMain.on('open-external-repo', () => shell.openExternal('https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new'));
  ipcMain.on('open-url', (event, url) => shell.openExternal(url));

  ipcMain.handle('fetch-docs', async () => {
    try {
      const listResult = await callTool(client, "list_sdk_documentation", {});
      const rawText = getTextContent(listResult).trim();
      // Affinity's tools occasionally return an error message as content with a successful RPC.
      if (!rawText || /^error[:\s]/i.test(rawText)) {
        return { success: false, error: 'Affinity did not return a topic list: ' + (rawText || 'empty response') };
      }
      const fileNames = parseCsvTextContent(listResult)
        .filter(n => n && !/^error/i.test(n) && n !== 'preamble'); // preamble is an init marker, not a user-facing topic
      const docs = [];
      for (const fileName of fileNames) {
        try {
          const readResult = await callTool(client, "read_sdk_documentation_topic", { filename: fileName });
          const content = getTextContent(readResult);
          // Skip topics whose content is itself an error response.
          if (content && !/^error[:\s]/i.test(content.trim())) {
            docs.push({ title: fileName, content });
          }
        } catch (e) {}
      }
      return { success: true, data: docs };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('search-docs', async (event, query) => {
    try {
      const result = await callTool(client, "search_sdk_hints", { prompt: query });
      return { success: true, data: getTextContent(result) || JSON.stringify(result, null, 2) };
    } catch (error) { return { success: false, error: error.message }; }
  });

  async function checkForUpdates(isManualCheck = false) {
    try {
      const currentVersion = app.getVersion(); 
      const response = await fetch(`https://api.github.com/repos/JiriKrblich/Affinity-Script-Manager/releases/latest`);
      if (!response.ok) throw new Error("Could not connect to GitHub.");
      
      const release = await response.json();
      const latestVersion = release.tag_name.replace('v', ''); 

      const v1 = latestVersion.split('.').map(Number);
      const v2 = currentVersion.split('.').map(Number);
      let isNewer = false;
      
      for (let i = 0; i < 3; i++) {
        if ((v1[i] || 0) > (v2[i] || 0)) { isNewer = true; break; }
        if ((v1[i] || 0) < (v2[i] || 0)) { break; }
      }

      if (isNewer) {
        win.webContents.send('update-available', release.html_url, latestVersion);
        const { response: btnIndex } = await dialog.showMessageBox(win, {
          type: 'info',
          title: 'Update Available',
          message: `A new version of Affinity Script Manager (v${latestVersion}) is available!`,
          detail: 'Would you like to download it now?',
          buttons: ['Update', 'Later'],
          defaultId: 0, cancelId: 1
        });
        if (btnIndex === 0) shell.openExternal(release.html_url);
        return { success: true, hasUpdate: true };
      } else {
        return { success: true, hasUpdate: false };
      }
    } catch (error) {
      if (isManualCheck) dialog.showErrorBox("Update Check Failed", error.message);
      return { success: false, error: error.message };
    }
  }

  ipcMain.handle('check-updates', async () => await checkForUpdates(true));
  win.webContents.once('did-finish-load', () => checkForUpdates(false));

  win.loadFile('index.html');
});

app.on('window-all-closed', async () => {
  if (transport) await transport.close().catch(()=>{});
  if (process.platform !== 'darwin') app.quit();
});