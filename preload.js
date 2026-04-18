const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // --- Lokální skripty ---
  listLocalScripts: () => ipcRenderer.invoke('list-local-scripts'),
  deleteLocalScript: (filename) => ipcRenderer.invoke('delete-local-script', filename),
  selectFile: () => ipcRenderer.invoke('select-file'),
  exportToDisk: (filename) => ipcRenderer.invoke('export-to-disk', filename),
  pushToMcp: (filename) => ipcRenderer.invoke('push-to-mcp', filename),

  // --- MCP Cloud ---
  listMcpScripts: () => ipcRenderer.invoke('list-mcp-scripts'),
  saveScript: (title, description, code) => ipcRenderer.invoke('save-script', title, description, code),
  downloadFromMcp: (mcpTitle, localName) => ipcRenderer.invoke('download-from-mcp', mcpTitle, localName),

  // --- Komunitní Marketplace ---
  listCommunityScripts: () => ipcRenderer.invoke('list-community-scripts'),
  downloadCommunityScript: (url, filename) => ipcRenderer.invoke('download-community-script', url, filename),
  openExternalRepo: () => ipcRenderer.send('open-external-repo'),

  // --- Dokumentace a Hledání ---
  fetchDocs: () => ipcRenderer.invoke('fetch-docs'),
  searchDocs: (query) => ipcRenderer.invoke('search-docs', query)
});