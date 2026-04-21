# Affinity Photo 2 — MCP Server & Scripting SDK Field Notes

Consolidated findings from reverse-engineering the Affinity Photo 2 (v2.7+) MCP server and its JS scripting SDK (JSLib). Target audience: an agent or dev picking up work on Affinity-side scripts — either through the built-in Scripts panel, through the MCP server, or through a local tooling pipeline.

---

## 1. Two integration surfaces

Affinity ships one scripting runtime but two ways to reach it:

| Surface | Use when | Notes |
|---|---|---|
| **Scripts panel** (user-facing GUI) | Scripts the end-user installs + runs from Affinity's Scripts panel | Each script has a `name:`, `description:`, `version:`, `author:` JSDoc header. Distributed as a single `.js` file. |
| **MCP server** (programmatic) | You want to drive Affinity from another process — e.g. tests, hot-reload dev loop, a web app | HTTP + SSE on `localhost:6767`. Exposes 11 tools including `execute_script`, `render_selection`. |

Both run the same JSLib runtime. A script that works standalone in the Scripts panel **will** work inside `execute_script` (provided you don't rely on DOM/Dialog APIs that don't reach the MCP caller — see §5).

---

## 2. The MCP server

### Endpoints
- **SSE stream:** `GET http://localhost:6767/sse` — `Access-Control-Allow-Origin: *` (browser-callable with no workaround).
- **JSON-RPC POST endpoint:** received as the first SSE event (`event: endpoint`, `data: /message?sessionId=<uuid>`). Resolve against the origin to get the full POST URL.

Also listens on IPv6 (`http://[::1]:6767/sse`) but IPv4 loopback is safer for cross-platform tools.

### Protocol version — **strict single version**
Only `'2025-11-25'` is accepted. Any other value (including the `DEFAULT_NEGOTIATED_PROTOCOL_VERSION` from the official MCP SDK) returns:
```json
{"error":{"code":-32602,"message":"Unsupported protocol version","data":{"supported":["2025-11-25"],"requested":"<x>"}}}
```
Pin your client to `'2025-11-25'`. Re-probe if Affinity updates.

### Handshake sequence
1. Open SSE stream → capture `endpoint` event's `data` field
2. `POST initialize` — params `{protocolVersion:'2025-11-25', capabilities:{}, clientInfo:{name,version}}`. Response arrives on the SSE stream as an `event: message` with matching `id`.
3. `POST notifications/initialized` — no id, no response expected
4. **`POST tools/call` with `read_sdk_documentation_topic({filename:'preamble'})`** — THIS IS MANDATORY before `execute_script` will work. The preamble doc must be "read" per MCP session. Skipping it causes `execute_script` calls to fail or hang.

### serverInfo
`initialize`'s response contains `serverInfo: {name:'Affinity', version:'1.0.0'}`. The `version` is not Affinity's app version — it's the MCP module's internal version.

### Request/response correlation
Each POST's numeric `id` is echoed back on the SSE stream. Maintain a `Map<id, {resolve, reject}>` and dispatch on incoming messages. Notifications have no `id`.

---

## 3. MCP tool inventory

Available via `tools/list` (not always needed if you know the names):

| Tool | Purpose |
|---|---|
| `execute_script` | Run arbitrary JS in the Affinity JS runtime. Returns `console.log` output as text. |
| `render_selection` | Render current selection → base64 JPEG. `arguments: {document_session_uuid:''}`. Max ~1024 px. |
| `render_spread` | Render the full current spread → base64 JPEG. |
| `list_sdk_documentation` / `read_sdk_documentation_topic` | Access the shipped JSLib docs (and the mandatory `preamble`). |
| `list_library_scripts` / `save_script_to_library` / `read_library_script` | Manage scripts in the user's Scripts panel. |
| `search_sdk_hints` / `add_sdk_hint` | A cross-session hint pool maintained by the server. |
| `report_sdk_issue` | File a bug with Canva/Affinity. |

### `execute_script` input / output
- **Input:** `arguments: { script: "<full JS source as string>" }`
- **Output:** `{ content: [{type:'text', text:'<concat of console.log output>'}], isError? }`
- The script runs to completion **synchronously from the caller's view**; the call blocks until the script finishes. Long scripts need a generous client timeout (≥ 5 minutes for multi-megapixel pixel work).

### `render_selection` output
```json
{ "content": [
    { "type": "image", "data": "<base64>", "mimeType": "image/jpeg" }
] }
```

---

## 4. `execute_script` runtime environment

The JS engine is **NOT a browser** and NOT Node. Treat it like an embedded V8/JSCore with the Affinity SDK grafted on.

### What's available
- ECMAScript modern syntax (ES2020+): `const`, arrow fns, classes, destructuring, async/await, template literals, optional chaining, etc.
- Typed arrays: `Uint8Array`, `Uint16Array`, `Uint8ClampedArray`, `Float32Array`, `ArrayBuffer`
- JSON: `JSON.parse`, `JSON.stringify`
- `Math`, `Date`, `String`, `Array`, `Map`, `Set`, `Error`, ...
- `console.log` / `console.error` — **the only output channel visible via MCP**
- `require('/application')`, `require('/document')`, `require('/nodes')`, etc. — the JSLib module surface (see §5)

### What's NOT available
- **`atob` / `btoa`** — **no base64 codec**. You MUST inline your own (see §8)
- `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` — no network
- `document`, `window`, DOM — there is no DOM
- `setTimeout` / `setInterval` — no timers (scripts are synchronous-from-caller)
- `Buffer` / Node APIs
- `TextEncoder` / `TextDecoder` — verify before using, untested as of writing

### Gotchas unique to the MCP path
- **`app.alert(…)` does not reach the caller via MCP.** It only works when a script is run from the Scripts panel (which shows the dialog). Under `execute_script` it's silently swallowed. Use `console.log(JSON.stringify({...}))` instead and parse the last JSON line on the caller side.
- Same for `Dialog.create(…).runModal()` — untested via MCP, probably blocks or errors. Reserve Dialog APIs for Scripts-panel-style user scripts.

---

## 5. JSLib SDK

### Location
`C:\Program Files\Affinity\Affinity\Resources\JSLib\` — full source, readable. Always grep here before guessing APIs.

Subfolders of interest:
- `tests/addNodeTests.js`, `tests/documenttests.js`, ... — worked examples of every operation
- `examples/` — short worked patterns (`addGuides.js`, `setDocumentFormat.js`, etc.)

### Module boundaries (all via `require(...)`)
```js
const { app } = require('/application');
const { Document, DocumentPromises, DocumentPreset } = require('/document');
const { Selection } = require('/selections');
const { DocumentCommand, AddChildNodesCommandBuilder, NodeChildType } = require('/commands');
const { RasterFormat, PixelBuffer, Bitmap } = require('/rasterobject');
const { RasterNodeDefinition, ImageNodeDefinition, SpreadNode } = require('/nodes');
const { Colour, RGBA8 } = require('/colours');
const { Dialog, DialogResult } = require('/dialog');       // Scripts-panel-only, not MCP
const { UnitType } = require('/units');
const { Rectangle } = require('/geometry');
const accessors = require('/pixelaccessor');
```

### Key classes & patterns

#### `Document.current`
- `doc.layers` — lazy Collection of all layer-like nodes across spreads. **Not an Array** — see §6.
- `doc.spreads` — lazy Collection of spreads (pages). `doc.spreads.first` → first spread.
- `doc.selection.nodes` — lazy Collection of selected nodes (→ `Array.from` before using).
- `doc.undo()`, `doc.redo()`
- `doc.executeCommand(cmd, preview?)` — low-level command execution.
- `doc.addNode(nodeDefinition, targetNode?, childList?)` — wrapper around the builder (see below).

#### Pixel I/O — two flavours

1. **Per-pixel (slow, simple)** — `require('/pixelaccessor')`:
   ```js
   const rw = accessors.PixelReaderWriterRGBA8.create(bitmap);
   rw.readPixel(x, y);      // {r,g,b,a}
   rw.writePixel(x, y, c);  // {r,g,b,a}
   ```
   Works, but each call crosses the JS↔C++ boundary. Unacceptably slow above ~50k pixels.

2. **Bulk via `PixelBuffer.buffer` (fast — USE THIS)** — see working example in `plugin/CRUSH Dither.js`:
   ```js
   const pbuf = node.rasterInterface.createCompatibleBuffer(true);
   const arr  = new Uint8Array(pbuf.buffer);   // direct ArrayBuffer view into native memory
   // mutate arr in-place...
   // then build a Bitmap and replace the node's bitmap:
   const bmp  = node.rasterInterface.createCompatibleBitmap(false);
   pbuf.copyTo(bmp, new Rectangle(0, 0, W, H), 0, 0);
   doc.executeCommand(DocumentCommand.createReplaceBitmap(Selection.create(doc, node), bmp));
   ```
   Orders of magnitude faster. Sub-second on 2 MP images.

#### Creating a **new pixel layer**

```js
const pbuf = PixelBuffer.create(W, H, fmt);     // fmt = RasterFormat.RGBAxx
const dst  = new Uint8Array(pbuf.buffer);        // or Uint16Array for 16-bit
// …fill dst…

const bmp = Bitmap.create(W, H, fmt);
pbuf.copyTo(bmp, new Rectangle(0, 0, W, H), 0, 0);

const nodeDef = RasterNodeDefinition.create(fmt);
nodeDef.bitmap = bmp;                            // setter, not a constructor arg
doc.addNode(nodeDef);                            // inserts + selects the new node
// After addNode, doc.selection.nodes[0] IS the new node.
```

**The format `fmt` MUST exactly match the document's native format** — see §6.

#### Renaming a node
Verified working: simple property setter.
```js
const n = Array.from(doc.selection.nodes)[0];
n.name = 'CRUSH · Floyd-Steinberg · 14:32';
```
`setName()` does NOT exist (despite what some SDK examples suggest — the `setName` pattern is for a different class). Use the setter.

---

## 6. Critical gotchas

### 6.1. Format must match the document — **strict**
A `RasterNodeDefinition.create(fmt)` added to a document whose native format differs throws `COMMAND_FAILED` at `doc.executeCommand(...)`. We verified with all standard formats in a spike — only the doc's own format succeeded.

**Detection pattern:**
```js
let docFormat = null;
for (const n of doc.layers) {
    if (n.isRasterNode || n.isImageNode) {
        docFormat = n.rasterInterface.createCompatibleBuffer(false).format;
        break;
    }
}
```
If the doc has no raster layers yet, fall back to trying `RasterFormat.RGBA8` first, then `RasterFormat.RGBA16` — keep whichever doesn't throw.

`DocumentPreset.rasterFormat` exists but that's for **new** documents, not live ones. There's no direct `Document.rasterFormat` getter.

### 6.2. 8-bit ↔ 16-bit channel conversion
Default Affinity documents are often RGBA16, not RGBA8.

- **8 → 16 expansion** (full range, no banding): `v16 = v8 * 257` (equivalent to `(v8<<8) | v8`, mapping `0→0`, `255→65535`).
- **16 → 8 contraction**: `v8 = v16 >> 8`.

Iterating over the typed-array view:
```js
// 8-bit source → 16-bit destination
const dst = new Uint16Array(pbuf.buffer);
for (let i = 0; i < src.length; i++) dst[i] = src[i] * 257;

// 16-bit source → 8-bit destination
const src = new Uint16Array(pbuf.buffer);
const dst = new Uint8Array(src.length);
for (let i = 0; i < dst.length; i++) dst[i] = src[i] >> 8;
```

### 6.3. Raster format must match the PixelReaderWriter class
If you use the per-pixel API instead of `pbuf.buffer`, `PixelReaderWriter<Format>.create(bitmap)` will silently return something unusable if the format doesn't match the bitmap's. Always dispatch on `bmp.format`:
```js
const ACCESSOR_BY_FORMAT = {
    [RasterFormat.RGBA8.value]:  { cls: accessors.PixelReaderWriterRGBA8,  max: 255,   channels: 'rgb' },
    [RasterFormat.RGBA16.value]: { cls: accessors.PixelReaderWriterRGBA16, max: 65535, channels: 'rgb' },
    [RasterFormat.IA8.value]:    { cls: accessors.PixelReaderWriterIA8,    max: 255,   channels: 'i'   },
    [RasterFormat.IA16.value]:   { cls: accessors.PixelReaderWriterIA16,   max: 65535, channels: 'i'   },
};
```

### 6.4. Collections are lazy, not Arrays
`doc.layers`, `doc.selection.nodes`, `spread.children`, etc. are lazy JS Collections, not plain Arrays. They don't have `.filter`, `.map`, `.length` etc. unless you coerce them first:
```js
const nodes = Array.from(doc.selection.nodes);
if (nodes.length === 0) { /* … */ }
const rasters = nodes.filter(n => n.isRasterNode || n.isImageNode);
```

### 6.5. Node wrappers are invalidated after a modal
If you open a Dialog, captured node references from before the modal are stale. Re-fetch after `runModal()` returns:
```js
const dlg = buildDialog(defaults);
while (true) {
    const result = dlg.runModal();
    if (!result.equals(DialogResult.Ok)) break;
    // DO NOT reuse node wrappers captured before this point:
    const fresh = Array.from(doc.selection.nodes).filter(…);
    // …work on fresh…
}
```

### 6.6. No `atob` / `btoa` in the runtime
You must inline a base64 codec if you transport binary data through `execute_script` (either in or out). Minimal pure-JS versions:

**Decode:**
```js
function b64bytes(s) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    const lut = new Uint8Array(128);
    for (let i = 0; i < CHARS.length; i++) lut[CHARS.charCodeAt(i)] = i;
    const sl = s.length;
    let pad = 0;
    if (s.charCodeAt(sl - 1) === 61) pad++;
    if (s.charCodeAt(sl - 2) === 61) pad++;
    const outLen = (sl * 3) / 4 - pad;
    const out = new Uint8Array(outLen);
    let o = 0;
    for (let i = 0; i < sl; i += 4) {
        const a = lut[s.charCodeAt(i)];
        const b = lut[s.charCodeAt(i + 1)];
        const c = lut[s.charCodeAt(i + 2)];
        const d = lut[s.charCodeAt(i + 3)];
        if (o < outLen) out[o++] = (a << 2) | (b >> 4);
        if (o < outLen) out[o++] = ((b & 15) << 4) | (c >> 2);
        if (o < outLen) out[o++] = ((c & 3) << 6) | d;
    }
    return out;
}
```

**Encode:**
```js
function bytesToB64(bytes) {
    const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let b64 = '';
    const len = bytes.length;
    let i = 0;
    for (; i + 2 < len; i += 3) {
        const a = bytes[i], b = bytes[i + 1], c = bytes[i + 2];
        b64 += CHARS[a >> 2] + CHARS[((a & 3) << 4) | (b >> 4)] + CHARS[((b & 15) << 2) | (c >> 6)] + CHARS[c & 63];
    }
    if (i < len) {
        const a = bytes[i], b = i + 1 < len ? bytes[i + 1] : 0;
        b64 += CHARS[a >> 2] + CHARS[((a & 3) << 4) | (b >> 4)];
        b64 += (i + 1 < len) ? CHARS[(b & 15) << 2] + '=' : '==';
    }
    return b64;
}
```

---

## 7. Scripts-panel script conventions

A script that appears in Affinity's Scripts panel needs a JSDoc header at the top:
```js
/**
 * name: CRUSH Dither
 * description: Fast dithering & halftone plugin. 12 algorithms, custom 2-colour mode.
 * version: 0.2.0
 * author: CRUSH
 */
```
Installation: push to Affinity's Scripts library via the MCP tool `save_script_to_library` (that's what `installer/install.js` wraps). No third-party "Script Manager" is needed.

### What's fine in Scripts-panel scripts but NOT fine under MCP
- `app.alert(msg)` — fine for user-facing scripts in the Scripts panel
- `Dialog.create(...).runModal()` — fine for Scripts panel
- Both of these do nothing useful when called via `execute_script`

For code that should run via BOTH paths, gate UI on a caller flag (e.g. a global set by the invoker, or feature-detect that `Dialog.create` actually produces visible UI).

---

## 8. Development workflow (this workspace)

All in `C:\Users\konta\Desktop\af_halftone\`:

```
installer/
  exec.js         # run a .js via execute_script, show console.log output
  exec-once.js    # same but for one-shot inline code
  install.js      # push a finished script to the Scripts library
  debug-tools.js  # dump full MCP surface (list every tool)
  debug-docs.js   # list all SDK doc topics
  debug-read.js   # read one SDK doc topic by filename

spike/            # throwaway scripts for API archaeology
  01-hello.js
  03-invert.js
  04-dither.js
  04-dither-fs.js
  04-diagnose.js
  05-addlayer.js  # the spike that established how to add a pixel layer + rename

plugin/
  CRUSH Dither.js # production-grade example: 12 dither algos,
                  # bulk PixelBuffer pipeline, Dialog UI, iterative Apply loop
```

### Tight dev loop
```bash
cd C:/Users/konta/Desktop/af_halftone/installer
node exec.js ../spike/05-addlayer.js              # run; prints console output
node exec.js ../spike/05-addlayer.js --render     # run; then render selection → result.jpg
node exec.js ../plugin/"CRUSH Dither.js"          # quick live test of the plugin
```

`exec.js` handles the preamble unlock for you. Without it you'd hit the "preamble not read" lockout. Reading it is idempotent per MCP session.

### Injecting globals
`exec.js --set NAME=value` prepends `globalThis.NAME = "value";` before running the script. Useful for turning a spike into a parametric dev tool without editing the file each time.

---

## 9. Existing working example

**`plugin/CRUSH Dither.js` (~17 KB, v0.2.0)** — the reference implementation that exercises every pattern in this document:

- Bulk `PixelBuffer.buffer` read/write pipeline (§5)
- Format dispatch table for RGBA8/RGBA16/IA8/IA16 (§6.3)
- `Array.from` coercion on Collections (§6.4)
- Dialog with `runModal()`, iterative Apply loop, node re-fetch (§6.5)
- `DocumentCommand.createReplaceBitmap` for non-destructive layer replacement

Read it end-to-end before writing anything new — it's ~400 LOC and covers 80% of real use cases.

---

## 10. Known unknowns / to verify

Things we have NOT confirmed but you may need:

- **`execute_script` payload size ceiling** — we've sent ~200 KB base64 strings without issue. The 2 MP 8-bit RGBA case (~11 MB base64) is untested. If you hit timeouts or truncation, chunk the upload across multiple `execute_script` calls and assemble with a shared JS variable (globals persist across calls in the same MCP session, unverified but plausible), OR go through `doc.export()` → temp file on disk + reading with `fs` (requires Desktop-Access toggle in Affinity settings).
- **Non-RGBA documents** — CMYK/LAB/grayscale. The format-match rule still applies, but we haven't worked out the channel layout constants or conversion math.
- **Multi-select of mixed node types** — our code assumes a single selected node. Multi-select is untested.
- **`render_selection` with nothing selected** — probably errors, untested.
- **Adjustment / filter / text / group nodes** — we've only written to pixel/raster. Creating shape/vector/text nodes uses `ShapeNodeDefinition`, `FrameTextNodeDefinition`, etc. — same `doc.addNode(def)` pattern, different Definition class per node type.
- **Document coordinate system vs. pixel coordinate system** — our new layers show up at origin (0,0) at 1:1 px. For proper placement inside scaled documents, you may need to play with `DrawingScale` or the node's bounding box after insertion.
- **Undo grouping** — each `doc.executeCommand` becomes one undo step. For multi-step operations, investigate `CompoundCommandBuilder` (seen in `commands.js`) to group them so the user gets a single Ctrl+Z.

---

## 11. Anti-patterns to avoid

- **Don't** use the generic `Document.current.addNode()` via the `doc.addNode` wrapper if you need `setInsertionTarget` semantics — build the `AddChildNodesCommandBuilder` yourself. For default-target inserts (top of the document), the wrapper is fine.
- **Don't** rely on `console.dir`, `console.table`, or `console.info` to survive the MCP roundtrip — only `console.log` (and `console.error`) are reliably captured.
- **Don't** leave `setName` in your code as a fallback. It doesn't exist on Node. Use the `name =` setter.
- **Don't** forget to `Array.from()` before calling `.length` or `.filter` on `doc.layers`/`doc.selection.nodes`. The lazy collection will lie.
- **Don't** assume the doc is RGBA8. Probe format first (§6.1).

---

## 12. Minimum viable handoff checklist for an agent

If you're picking up Affinity script work cold, do this in order:

1. **Verify tooling:** `cd installer && node exec.js ../spike/01-hello.js` — you should see `hello` in the output.
2. **Skim this document.**
3. **Read `plugin/CRUSH Dither.js`** end-to-end (400 LOC).
4. **Read the preamble docs:** `node debug-read.js preamble`.
5. **Browse `C:\Program Files\Affinity\Affinity\Resources\JSLib\tests\`** — it's a gold mine of validated usage patterns.
6. Start writing. When a JSLib call fails with `COMMAND_FAILED` or an unhelpful error, bisect by:
   - Checking format-match (§6.1)
   - Checking `Array.from` coercions (§6.4)
   - Dumping `typeof`, `.constructor.name`, and `Object.getOwnPropertyNames(Object.getPrototypeOf(x))` into `console.log` to see what type you actually have

---

**Last updated:** 2026-04-21
**Workspace:** `C:\Users\konta\Desktop\af_halftone\`
**Related docs:** `../CRUSH/roadmap.md`, `../CRUSH/affinity-mvp-design.md`, `../CRUSH/affinity-mvp-plan.md`
