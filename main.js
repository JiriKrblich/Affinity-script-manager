const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { CallToolResultSchema } = require("@modelcontextprotocol/sdk/types.js");

const SERVER_URL = "http://localhost:6767/sse";

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

let client;
let transport;
let localScriptsDir;

app.whenReady().then(async () => {
  localScriptsDir = path.join(app.getPath('userData'), 'MyScripts');
  await fs.mkdir(localScriptsDir, { recursive: true });

  client = new Client({ name: "script-mgr-ui", version: "1.0.0" });
  transport = new SSEClientTransport(new URL(SERVER_URL));
  await client.connect(transport).catch(console.error);

  const win = new BrowserWindow({
    width: 1100, height: 800, title: "Affinity Script Manager",
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });

  // ==========================================
  // --- LOCAL SCRIPTS (Files on Disk) ---
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
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JavaScript', extensions: ['js'] }] });
    if (canceled || filePaths.length === 0) return { success: false };
    const code = await fs.readFile(filePaths[0], "utf8");
    const name = path.parse(filePaths[0]).name;
    return { success: true, data: { name, code } };
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
      const title = path.parse(filename).name;
      const description = "Pushed from Local Library";
      await callTool(client, "save_script_to_library", { title, description, code });
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // ==========================================
  // --- AFFINITY MCP COMMUNICATION (Cloud) ---
  // ==========================================

  ipcMain.handle('list-mcp-scripts', async () => {
    try {
      const result = await callTool(client, "list_library_scripts", {});
      return { success: true, data: getTextContent(result) || result };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.handle('save-script', async (event, title, description, code) => {
    try {
      const safeDescription = description ? description : "Uploaded via Script Manager";
      await callTool(client, "save_script_to_library", { title, description: safeDescription, code });
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
  // --- COMMUNITY SCRIPTS (Marketplace) ---
  // ==========================================

  const REGISTRY_URL = 'https://raw.githubusercontent.com/JiriKrblich/Affinity-Community-Scripts/refs/heads/main/registry.json';

  ipcMain.handle('list-community-scripts', async () => {
    try {
      const response = await fetch(REGISTRY_URL);
      if (!response.ok) throw new Error("Could not load community registry. Check your connection.");
      const registry = await response.json();
      return { success: true, data: registry.scripts }; 
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
        await callTool(client, "save_script_to_library", { 
          title: filename, 
          description: "Installed from Community Scripts", 
          code: code 
        });
      } catch (mcpErr) {
        console.warn("Script downloaded locally, but failed to push to MCP instantly:", mcpErr);
      }
      
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  ipcMain.on('open-external-repo', () => {
    shell.openExternal('https://github.com/JiriKrblich/Affinity-Community-Scripts/issues/new');
  });

  ipcMain.on('open-url', (event, url) => {
    shell.openExternal(url);
  });

  // ==========================================
  // --- DOCUMENTATION & SEARCH ---
  // ==========================================

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

  // ==========================================
  // --- GITHUB UPDATE CHECK ---
  // ==========================================
  win.webContents.once('did-finish-load', async () => {
    try {
      const REPO_OWNER = 'JiriKrblich'; 
      const REPO_NAME = 'Affinity-Script-Manager';
      const currentVersion = app.getVersion(); 
      
      const response = await fetch(`https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`);
      if (!response.ok) return;
      
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
        // Nejprve pošleme signál do UI, aby se ukázalo tlačítko v menu (pro případ, že uživatel dá 'Later')
        win.webContents.send('update-available', release.html_url, latestVersion);

        // Pak ukážeme popup okno
        const { response: btnIndex } = await dialog.showMessageBox(win, {
          type: 'info',
          title: 'Update Available',
          message: `A new version of Affinity Script Manager (v${latestVersion}) is available!`,
          detail: 'Would you like to download it now?',
          buttons: ['Update', 'Later'],
          defaultId: 0,
          cancelId: 1
        });

        // Pokud uživatel vybral Update
        if (btnIndex === 0) {
          shell.openExternal(release.html_url);
        }
      }
    } catch (error) {
      console.log("Update check failed (offline or API limit):", error.message);
    }
  });

  win.loadFile('index.html');
});

app.on('window-all-closed', async () => {
  if (transport) await transport.close().catch(()=>{});
  if (process.platform !== 'darwin') app.quit();
});