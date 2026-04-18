const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { SSEClientTransport } = require("@modelcontextprotocol/sdk/client/sse.js");
const { CallToolResultSchema } = require("@modelcontextprotocol/sdk/types.js");

const SERVER_URL = "http://localhost:6767/sse";

// --- Pomocné funkce ---
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
  // Inicializace bezpečné systémové složky pro lokální skripty
  localScriptsDir = path.join(app.getPath('userData'), 'MyScripts');
  await fs.mkdir(localScriptsDir, { recursive: true });

  // Připojení k MCP serveru
  client = new Client({ name: "script-mgr-ui", version: "1.0.0" });
  transport = new SSEClientTransport(new URL(SERVER_URL));
  await client.connect(transport).catch(console.error);

  // Vytvoření hlavního okna
  const win = new BrowserWindow({
    width: 1100, height: 800, title: "Script Manager",
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });

  // ==========================================
  // --- LOKÁLNÍ SKRIPTY (Soubory na disku) ---
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

  // Pouze pro čtení obsahu při nahrávání (modal upload)
  ipcMain.handle('select-file', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'JavaScript', extensions: ['js'] }] });
    if (canceled || filePaths.length === 0) return { success: false };
    const code = await fs.readFile(filePaths[0], "utf8");
    const name = path.parse(filePaths[0]).name;
    return { success: true, data: { name, code } };
  });

  // Exportování vybraného lokálního skriptu někam jinam (např. na Plochu)
  ipcMain.handle('export-to-disk', async (event, filename) => {
    try {
      const code = await fs.readFile(path.join(localScriptsDir, filename), "utf8");
      const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: filename });
      if (canceled || !filePath) return { success: false, error: 'Cancelled' };
      await fs.writeFile(filePath, code, "utf8");
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // PUSH DO MCP: Zkopíruje lokální skript na cloudový server
  ipcMain.handle('push-to-mcp', async (event, filename) => {
    try {
      const filePath = path.join(localScriptsDir, filename);
      const code = await fs.readFile(filePath, "utf8");
      const title = path.parse(filename).name; // Název bez .js
      const description = "Pushed from Local Library";
      
      await callTool(client, "save_script_to_library", { title, description, code });
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // ==========================================
  // --- MCP KOMUNIKACE (Cloud) ---
  // ==========================================

  ipcMain.handle('list-mcp-scripts', async () => {
    try {
      const result = await callTool(client, "list_library_scripts", {});
      return { success: true, data: getTextContent(result) || result };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // Nahrání nového skriptu (uloží ho do Cloudu i Lokálně)
  ipcMain.handle('save-script', async (event, title, description, code) => {
    try {
      await callTool(client, "save_script_to_library", { title, description, code });
      const safeFilename = title.toLowerCase().replace(/[^a-z0-9_-]/g, '-') + '.js';
      await fs.writeFile(path.join(localScriptsDir, safeFilename), code, "utf8");
      return { success: true };
    } catch (error) { return { success: false, error: error.message }; }
  });

  // Stažení z Cloudu do Lokální knihovny
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
  // --- DOKUMENTACE A HLEDÁNÍ ---
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

  // Načtení hlavního UI
  win.loadFile('index.html');
});

// Bezpečné ukončení
app.on('window-all-closed', async () => {
  if (transport) await transport.close().catch(()=>{});
  if (process.platform !== 'darwin') app.quit();
});