const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // --- Lokální skripty ---
  listLocalScripts: () => ipcRenderer.invoke('list-local-scripts'),
  getScriptFolders: () => ipcRenderer.invoke('get-script-folders'),
  openScriptFolder: (folder) => ipcRenderer.invoke('open-script-folder', folder),
  chooseScriptFolder: () => ipcRenderer.invoke('choose-script-folder'),
  planScriptFolderChange: (target) => ipcRenderer.invoke('plan-script-folder-change', target),
  applyScriptFolderChange: (target, move, choices) => ipcRenderer.invoke('apply-script-folder-change', target, move, choices),
  addWatchedFolder: (folder) => ipcRenderer.invoke('add-watched-folder', folder),
  removeWatchedFolder: (folder) => ipcRenderer.invoke('remove-watched-folder', folder),
  listWatchedScripts: () => ipcRenderer.invoke('list-watched-scripts'),
  pushWatchedScript: (folder, filename) => ipcRenderer.invoke('push-watched-script', folder, filename),
  deleteLocalScript: (filename) => ipcRenderer.invoke('delete-local-script', filename),
  renameLocalScript: (filename, newName) => ipcRenderer.invoke('rename-local-script', filename, newName),
  readLocalScript: (filename) => ipcRenderer.invoke('read-local-script', filename),
  saveLocalScript: (filename, code) => ipcRenderer.invoke('save-local-script', filename, code),
  selectFile: () => ipcRenderer.invoke('select-file'),
  exportToDisk: (filename) => ipcRenderer.invoke('export-to-disk', filename),
  pushToMcp: (filename) => ipcRenderer.invoke('push-to-mcp', filename),

  // --- MCP Cloud ---
  listMcpScripts: () => ipcRenderer.invoke('list-mcp-scripts'),
  executeScript: (code) => ipcRenderer.invoke('execute-script', code),
  runCommunityScript: (downloadUrl) => ipcRenderer.invoke('run-community-script', downloadUrl),
  renderActivePreview: () => ipcRenderer.invoke('render-active-preview'),
  saveScript: (title, description, code) => ipcRenderer.invoke('save-script', title, description, code),
  downloadFromMcp: (mcpTitle, localName) => ipcRenderer.invoke('download-from-mcp', mcpTitle, localName),
  exportMcpToDisk: (mcpTitle) => ipcRenderer.invoke('export-mcp-to-disk', mcpTitle),
  readMcpMetadata: (mcpTitle) => ipcRenderer.invoke('read-mcp-metadata', mcpTitle),
  buildShareIssue: (filename) => ipcRenderer.invoke('build-share-issue', filename),
  buildShareIssueMcp: (mcpTitle) => ipcRenderer.invoke('build-share-issue-mcp', mcpTitle),
  getFavorites: () => ipcRenderer.invoke('get-favorites'),
  toggleFavorite: (stem) => ipcRenderer.invoke('toggle-favorite', stem),

  // --- Komunitní Marketplace ---
  listCommunityScripts: () => ipcRenderer.invoke('list-community-scripts'),
  listScriptHistory: (script) => ipcRenderer.invoke('list-script-history', script),
  saveScriptRevision: (script, sha, action, filename) => ipcRenderer.invoke('save-script-revision', script, sha, action, filename),
  downloadCommunityScript: (url, filename, metadata) => ipcRenderer.invoke('download-community-script', url, filename, metadata),
  saveCommunityScript:     (url, filename, metadata) => ipcRenderer.invoke('save-community-script',     url, filename, metadata),
  openExternalRepo: () => ipcRenderer.send('open-external-repo'),

  // --- Dokumentace a Hledání ---
  fetchDocs: () => ipcRenderer.invoke('fetch-docs'),
  readDocTopic: (filename) => ipcRenderer.invoke('read-doc-topic', filename),
  searchDocs: (query) => ipcRenderer.invoke('search-docs', query),
  getApiMonitor: () => ipcRenderer.invoke('get-api-monitor'),
  syncApiMonitor: () => ipcRenderer.invoke('sync-api-monitor'),
  scanApiCompatibility: () => ipcRenderer.invoke('scan-api-compatibility'),

  // --- Nastavení a repozitáře ---
  getRepos: () => ipcRenderer.invoke('get-repos'),
  addRepo: (url) => ipcRenderer.invoke('add-repo', url),
  removeRepo: (url) => ipcRenderer.invoke('remove-repo', url),
  getSidebarCollapsed: () => ipcRenderer.invoke('get-sidebar-collapsed'),
  setSidebarCollapsed: (collapsed) => ipcRenderer.invoke('set-sidebar-collapsed', collapsed),
  getEditorSettings: () => ipcRenderer.invoke('get-editor-settings'),
  setEditorSettings: (settings) => ipcRenderer.invoke('set-editor-settings', settings),
  onReposChanged: (callback) => ipcRenderer.on('repos-changed', callback), // NOVÉ

  // --- Systémové (Aktualizace) ---
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, url, version) => callback(url, version)),
  // --- Watch mode ---
  onLocalScriptsChanged: (callback) => ipcRenderer.on('local-scripts-changed', () => callback()),

  openUrl: (url) => ipcRenderer.send('open-url', url)
});

contextBridge.exposeInMainWorld('appVersion', ipcRenderer.sendSync('app-version-sync'));
