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
let settingsWin = null; 

// --- Helper Functions ---
function getTextContent(result) {
  return (result.content || []).filter((i) => i && i.type === "text").map((i) => i.text).join("\n");
}

function parseCsvTextContent(result) {
  const textChunks = (result.content || []).filter((i) => i && i.type === "text").map((i) => i.text);
  return [...new Set(textChunks.join(",").split(",").map((n) => n.trim()).filter(Boolean))];
}

async function callTool(client, name, args) {
  return client.request({ method: "tools/call", params: { name, arguments: args } }, CallToolResultSchema);
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

app.whenReady().then(async () => {
  localScriptsDir = path.join(app.getPath('userData'), 'MyScripts');
  configPath = path.join(app.getPath('userData'), 'config.json');
  await fs.mkdir(localScriptsDir, { recursive: true });

  client = new Client({ name: "script-mgr-ui", version: "1.0.0" });
  transport = new SSEClientTransport(new URL(SERVER_URL));
  await client.connect(transport).catch(console.error);

  win = new BrowserWindow({
    width: 1100, height: 800, title: "Affinity Script Manager",
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });

  // ==========================================
  // --- LOCAL SCRIPTS & MCP ---
  // ==========================================

  ipcMain.handle('list-local-scripts', async () => {
    try {
      const files = await fs.readdir(localScriptsDir);
      return { success: true, data: files.filter(f => f.endsWith('.js')) };
    } catch (e) { return { success: false, error: e.message }; }
  });

  ipcMain.handle('delete-local-script', async (e, filename) => {
    try {
      await fs.unlink(path.join(localScriptsDir, filename));
      return { success: true };
    } catch (e) { return { success: false, error: e.message }; }
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

  ipcMain.handle('save-script', async (event, title, description, code) => {
    try {
      await callTool(client, "save_script_to_library", { title, description: description || "Uploaded via Script Manager", code });
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

  ipcMain.on('open-settings', () => {
    if (settingsWin) {
      settingsWin.focus(); 
      return;
    }
    settingsWin = new BrowserWindow({
      width: 550, height: 600,
      title: "Settings",
      parent: win, 
      autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
    });
    settingsWin.loadFile('settings.html');
    settingsWin.on('closed', () => { settingsWin = null; });
  });

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

  // ==========================================
  // --- DOCUMENTATION, SEARCH & UPDATES ---
  // ==========================================

  ipcMain.on('open-external-repo', () => shell.openExternal('https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new'));
  ipcMain.on('open-url', (event, url) => shell.openExternal(url));

  ipcMain.handle('fetch-docs', async () => {
    try {
      const listResult = await callTool(client, "list_sdk_documentation", {});
      const fileNames = parseCsvTextContent(listResult);
      const docs = [];
      for (const fileName of fileNames) {
        try {
          const readResult = await callTool(client, "read_sdk_documentation_topic", { filename: fileName });
          docs.push({ title: fileName, content: getTextContent(readResult) });
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