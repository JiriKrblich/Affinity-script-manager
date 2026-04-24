# Affinity Script Manager
ElectronJS based UI manager for Affinity App scripts

![Cover photo with screenshot of Script Manager](readme/AffinityScriptManager_1.3.0_Overview.webp)

## Features

* **Local Library:** Manage your downloaded and custom `.js` scripts. They are safely stored in your system's native user data folder.
* **MCP Cloud Sync:** Easily pull scripts from your local MCP server to your computer, or push your local scripts up to the server with a single click.
* **In-App Documentation:** No need to clutter your hard drive. Fetch SDK documentation directly from the MCP server into memory and read it in a clean, split-view Markdown reader.
* **SDK Search:** Stuck? Search the SDK hints directly from the app. Results are instantly parsed and beautifully formatted in Markdown.
* **Native UI Feel:** Built with Tailwind CSS, the app features a clean, dark-mode interface that feels right at home on Mac or Windows.

## How to Use
**Uploading a Script:** Click "Upload Script" in the sidebar. You can select a .js file from your disk. The app will automatically read it and save it to both your Local Library and the MCP Cloud.

**Downloading:** Go to the "MCP Cloud" tab and click "Download to Library" on any script. It will instantly be saved to your local MyScripts directory.

**Reading Docs:** Click on "Documentation". The app will fetch all available docs from the server and render them on the fly.

## How to Format Your Scripts (Metadata Header)

To make your scripts seamlessly compatible with the **Affinity Script Manager**, please include a metadata block at the very beginning of your `.js` file. 

When a user imports your script into the app, the manager automatically parses this header and auto-fills the title and description for them!

### The Format
Use a standard JavaScript block comment (`/** ... */`) placed at the **very top** of your script. 

```javascript
/**
 * name: Auto Exporter
 * description: Automatically exports all selected layers as PNG files.
 * version: 1.0.0
 * author: Your Name
 */

// --- Your code starts here ---
function exportLayers() {
    // ...
}
```

### Supported Tags
- name: (Required) The title of your script as it will appear in the user's local library.

- description: (Recommended) A short, 1-2 sentence explanation of what your script does.

- version: (Optional) The current version of the script (e.g., 1.0.0).

- author: (Optional) Your name or GitHub handle.

### Important Rules for the Parser
- The /** must be on the first line of the file (empty lines before it are fine, but no code).

- Use a single line for each tag.

- Keep the tag names in lowercase (name:, not Name:).


## Adding Custom Repositories

The Affinity Script Manager is completely decentralized! You are not limited to the default scripts — you can add any creator's GitHub repository to your app to instantly access their scripts.

### How to add a repository:
1. Open the app and go to the **Community Scripts** tab.
2. Click the **Repositories** button in the top right corner.
3. Paste a standard GitHub link into the input field (e.g., `https://github.com/username/repository-name`).
4. Click **Add Repo**.

The app will automatically fetch the scripts from that repository and mix them into your Community tab!

---

### For Creators: How to make your own repository
Want to share your scripts with the world? It's incredibly easy to make your GitHub repository compatible with the Script Manager:

1. Create a new public repository on GitHub.
2. Upload your `.js` scripts there.
3. Create a file named `registry.json` in the root (main branch) of your repository.
4. Format the `registry.json` like this:

```json
{
  "scripts": [
    {
      "name": "My Awesome Script",
      "description": "Does something amazing with layers.",
      "version": "1.0.0",
      "author": "Your Name",
      "category": "Layers",
      "download_url": "https://raw.githubusercontent.com/username/repo/main/my-script.js"
    }
  ]
}
```

Note: Make sure the download_url points to the Raw version of your .js file!

Once your registry.json is ready, anyone can paste your GitHub link into their app and install your scripts with a single click!

## Roadmap
- [x] Standard format of Scripts – Autofill info about script into UI
- [x] Update manager of App –> App autoupdate
- [ ] Updating existing scripts from the git community repo
- [x] Custom git repos
- [x] Better UI
- [ ] App branding

## Disclaimer
**Keep in mind:** this repo is not connected to the Affinity Developers and Affinity is Canva's brand. 