# Script Manager for Affinity
![Cover photo with screenshot of Script Manager](readme/AffinityScriptManager_1.3.0_Overview.webp)

## Features

* **My Scripts:** Your local `.js` library, safely stored in your system's native user data folder and shown with name, description, size, and last-modified time. Two tabs:
  * **Local** — your scripts, each with an install dot (grey = not installed, green = active in Affinity). Click the dot (or the row) to push it into Affinity. Search, favorite, rename, edit, export, share, or delete from the row.
  * **Just in Affinity** — scripts that live in Affinity but aren't in your local library (blue dot), with **Download to My Scripts** and **Download to folder**.
* **Bridge diagnostics ("More info"):** Live connection status, round-trip latency, and an event stream log for the local MCP bridge — tucked behind a **More info** button so it stays out of your way.
* **Watch Mode:** Always-on file watcher. When you save a script that is already installed in Affinity, the app automatically re-pushes it — no manual step needed.
* **Community Scripts:** Browse scripts from any GitHub-hosted registry. Image previews, a **Featured** carousel, filter by category, sort, and mark favorites. The install button reflects real state: **Install**, **Installed**, or **Update** when a newer version is available. Save-only mode downloads without installing.
* **Run without install:** Open a community script's details (or the Code Editor) and run it in Affinity right away to see the console output *and* a rendered preview — before adding it to your library.
* **Share to the community:** Publish a local or Affinity script to the community repository straight from the app. It prepares a ready-to-submit GitHub issue and copies it to your clipboard — no tokens, your GitHub credentials never touch the app.
* **Shared favorites:** Favorites are unified across My Scripts and Community — star a script in one place and it's marked in the other.
* **Built-in Code Editor:** Write new scripts from scratch or edit existing ones with a full Ace editor (JavaScript syntax highlighting, dark theme, `Cmd/Ctrl+S` to save, **Run** to try the current buffer). New scripts get a pre-filled metadata header template.
* **In-App Documentation & SDK Search:** Fetch the Affinity SDK documentation from the MCP server and read it in a clean Markdown reader, and search SDK hints without leaving the app.
* **Updates panel & badges:** When community repos ship newer versions of scripts you have locally, they're grouped in an **Updates available** panel (with per-script and *Update all* actions) and flagged with a badge.
* **Auto-Update Checker:** The app checks GitHub Releases on launch and shows an update button in the sidebar when a new version is available.
* **Drag & Drop:** Drag one or more `.js` files anywhere onto the window. A full-window overlay appears, and after dropping you choose **Just save to My Scripts** or **Save & install**.
* **Metadata Header Parsing:** Import a `.js` file and the app reads its header comment to pre-fill the script's name and description.
* **Export to Disk:** Save any script from your local library to an arbitrary location via the native save dialog.

---


## How to Use

**Adding a script from disk:** Click **Add Script** in the sidebar, or drag one or more `.js` files anywhere onto the window. On drop, choose **Just save to My Scripts** or **Save & install**.

**Installing a script into Affinity:** In **My Scripts → Local**, click the grey dot on the left of any row (or click anywhere on the row). The dot turns green when the script is live in Affinity.

**Downloading from Affinity:** Open **My Scripts → Just in Affinity** to see scripts that live in Affinity but not in your library, and click the download icon to pull one into **My Scripts** (or save it to a folder).

**Editing a script:** Click the pencil icon in the Actions column, or open the **Code Editor** and pick a script. Save with `Cmd+S` / `Ctrl+S`. If the script is already installed in Affinity, Watch Mode re-pushes the update automatically. Hit **Run** to try the current buffer in Affinity without installing.

**Writing a new script:** Go to **Code Editor** and click **New Script**. A blank buffer opens with a pre-filled metadata header. Give it a name, write your code, then save.

**Community scripts:** Open the **Community** tab. Browse, filter, or search (`⌘K`). Click **Install** to save to your library and push to Affinity at once, or the save icon to download only. Click a card to open its details, where you can **Run without install** to preview what a script does before adding it.

**Sharing your script:** Click the **Share** (GitHub) action on any local or Affinity script, or **Submit Script** in the Community tab. The app copies a ready-to-submit contribution to your clipboard and opens a GitHub issue — paste it in and submit.

**Bridge status:** In **My Scripts**, click **More info** for the Affinity MCP connection details, latency, and event log.

**Reading the docs / searching the SDK:** Click **Documentation** in the sidebar to read SDK topics as Markdown, and use the search bar to query SDK hints directly.

---

## How to Format Your Scripts (Metadata Header)

To make your scripts compatible with the Affinity Script Manager, include a metadata block at the very beginning of your `.js` file. When a user imports your script, the app automatically parses this header and fills in the title and description.

### The Format

Use a standard JavaScript block comment (`/** ... */`) at the **very top** of your file:

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

| Tag | Required | Description |
|---|---|---|
| `name` | ✅ | The title of your script as it appears in the library. |
| `description` | Recommended | A short 1–2 sentence explanation of what the script does. |
| `version` | Optional | Current version, e.g. `1.0.0`. Used for update detection. |
| `author` | Optional | Your name or GitHub handle. |

### Parser Rules

- The `/**` must be on the first line of the file (blank lines before it are fine; no code before it).
- One tag per line.
- Tag names must be lowercase (`name:`, not `Name:`).

---

## Adding Custom Repositories

The Affinity Script Manager is completely decentralized. You can add any creator's GitHub repository to access their scripts alongside the default ones.

### How to add a repository

1. Open the **Community** tab.
2. Click the **Repositories** button in the top-right corner.
3. Paste a standard GitHub URL (e.g. `https://github.com/username/repository-name`).
4. Click **Add Repo**.

The app converts the URL to a raw `registry.json` link automatically and fetches the scripts immediately.

---

### For Creators: Publishing Your Own Repository

1. Create a new **public** repository on GitHub.
2. Upload your `.js` scripts.
3. Create a file named `registry.json` in the root of the repository on the main branch.
4. Format it like this:

```json
{
  "scripts": [
    {
      "id": "my-awesome-script",
      "name": "My Awesome Script",
      "description": "Does something amazing with layers.",
      "version": "1.0.0",
      "author": "Your Name",
      "contributors": ["Contributor One", "Contributor Two"],
      "category": "Layers",
      "image": "previews/my-awesome-script.webp",
      "url": "https://your-website.com",
      "email": "you@example.com",
      "download_url": "https://raw.githubusercontent.com/username/repo/main/my-script.js"
    }
  ]
}
```

> Make sure `download_url` points to the **raw** version of your `.js` file.
> The optional `image` can be a full URL or a path relative to `registry.json`; previews are shown in a fixed 16:9 frame.

**Optional fields:**

| Field | Description |
|---|---|
| `contributors` | A list of additional contributor names, shown in the detail view. |
| `category` | Groups the script under a category tab in the Community tab. |
| `image` | Preview image (full URL or path relative to `registry.json`). |
| `url` | A website/link, shown as a clickable button in the script's detail view. |
| `email` | A contact email, shown as a clickable `mailto:` button in the detail view. |

Once your `registry.json` is in place, anyone can paste your GitHub link into the app and install your scripts with a single click.

### Featuring scripts (`featured.json`)

To highlight scripts in the **Featured** carousel at the top of the Community tab, add an optional `featured.json` next to your `registry.json`, listing the `id`s to feature:

```json
{ "featured": ["my-awesome-script", "another-script"] }
```

A bare array (`["my-awesome-script"]`) also works. Scripts without a matching entry simply aren't featured — `featured.json` is entirely optional.

---

## Troubleshooting

### Script does not install into Affinity

If a script does not appear in Affinity after clicking **Install**, check the following:

1. **Make sure MCP is enabled in Affinity.**  
   Affinity Script Manager communicates with Affinity through the local MCP bridge. If MCP is disabled or does not have the required permissions, the app cannot push scripts into Affinity.

2. **Allow MCP to save scripts/workflows to the Scripts panel.**  
   In Affinity settings, check the MCP/AI assistant permissions and make sure the bridge is allowed to save scripts to Affinity.

3. **Open the Scripts panel in Affinity.**  
   Go to **Window → General → Scripts**.

4. **Create at least one category in the Scripts panel.**  
   Affinity needs a category in the Scripts panel before scripts can be installed there.  
   In the Scripts panel, use **Create New Category** and create any category, for example `My Scripts`.

5. **Try installing again.**  
   Return to Affinity Script Manager and click the install dot next to your script again. The script should now appear in Affinity's Scripts panel.

---

## Installation on macOS

1. Go to the [Releases](https://github.com/JiriKrblich/Affinity-Script-Manager/releases/latest) page and download the latest `.dmg` file.
2. Open the downloaded `.dmg`, then drag **Affinity Script Manager** into your **Applications** folder.
3. Try to open the app. macOS will block it with a message like *"Script Manager for Affinity cannot be opened because it is from an unidentified developer."*
4. Open **System Settings → Privacy & Security**.
5. Scroll down to the Security section. You will see a message about the blocked app — click **Open Anyway**.
6. In the confirmation dialog that appears, click **Open** (you may be asked for your password).

The app is now approved and will open normally from this point on.

> **Note:** This prompt only appears because the app is not notarized with an Apple Developer certificate. The source code is fully open — you can inspect it in this repository before running it.


---

## Disclaimer

This project is not affiliated with Affinity or Canva. Affinity is a trademark of Canva.
