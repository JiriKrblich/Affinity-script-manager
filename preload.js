const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Scripts
  listMcpScripts: () => ipcRenderer.invoke('list-mcp-scripts'),
  listLocalScripts: () => ipcRenderer.invoke('list-local-scripts'),
  deleteLocalScript: (filename) => ipcRenderer.invoke('delete-local-script', filename),
  
  // Upload & Download
  selectFile: () => ipcRenderer.invoke('select-file'),
  saveScript: (title, description, code) => ipcRenderer.invoke('save-script', title, description, code), // Saves to BOTH Local & MCP
  downloadFromMcp: (mcpTitle, localName) => ipcRenderer.invoke('download-from-mcp', mcpTitle, localName), // Downloads to Local
  exportToDisk: (filename) => ipcRenderer.invoke('export-to-disk', filename), // Export anywhere
  pushToMcp: (filename) => ipcRenderer.invoke('push-to-mcp', filename),
  
  // Docs & Search
  fetchDocs: () => ipcRenderer.invoke('fetch-docs'),
  searchDocs: (query) => ipcRenderer.invoke('search-docs', query)
});