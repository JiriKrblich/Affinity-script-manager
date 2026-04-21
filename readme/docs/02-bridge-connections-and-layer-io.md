# Affinity Photo 2 MCP Bridge — Connection & Layer I/O

This document captures everything the CRUSH team learned about pushing pixels to, and pulling pixels from, Affinity Photo 2 over the MCP bridge. It is written for another agent / engineer building a plugin on top of the same bridge, so it is heavy on concrete values, payload shapes, and gotchas that are NOT in the SDK docs.

---

## 1. Transport

| Thing | Value |
|---|---|
| Default SSE URL | `http://localhost:6767/sse` |
| Protocol | MCP over SSE + JSON-RPC 2.0 (POSTs to the `endpoint` returned in the SSE stream) |
| Protocol version | `"2025-11-25"` — Affinity-specific, **not** an official MCP spec date |
| POST content type | `application/json` |
| POST response | `202 Accepted` (the actual response comes back asynchronously on the SSE channel) |

- The server sends a first SSE event with `event: endpoint` and `data: /message?session_id=<uuid>`. Resolve that against the SSE origin to get the POST endpoint.
- All `tools/call` and `initialize` replies arrive over the SSE `message` event, matched by JSON-RPC `id`.
- Mixed-content: if the page is served over HTTPS, the browser blocks the `http://localhost` connection. The bridge only works on `file://`, `http://localhost`, or another http origin.
- There is no authentication. Any origin the browser can reach can drive Affinity. Tell users to stop the server when they're not using it.

### Connect handshake (code shape)

```js
const es = new EventSource(sseUrl);

// 1. Wait for endpoint
const endpoint = await new Promise((resolve, reject) => {
  es.addEventListener('endpoint', (e) => {
    resolve(new URL(e.data, new URL(sseUrl).origin).toString());
  }, { once: true });
  es.addEventListener('error', () => reject(new Error('MCP server unreachable')), { once: true });
});

// 2. Route SSE messages to pending RPC promises
const pending = new Map();
let nextId = 1;
es.addEventListener('message', (evt) => {
  const msg = JSON.parse(evt.data);
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    if (msg.error) p.reject(enrichError(msg.error)); else p.resolve(msg.result);
  }
});

function rpcCall(method, params, timeoutMs = 30000) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, timeoutMs);
    pending.set(id, {
      resolve: v => { clearTimeout(t); resolve(v); },
      reject: e => { clearTimeout(t); reject(e); },
    });
    fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
  });
}

// 3. Initialize with protocol version negotiation
async function handshake() {
  const tried = new Set();
  let result = null, lastErr = null;
  const queue = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
  while (queue.length) {
    const pv = queue.shift();
    if (tried.has(pv)) continue;
    tried.add(pv);
    try {
      result = await rpcCall('initialize', {
        protocolVersion: pv,
        capabilities: {},
        clientInfo: { name: 'your-plugin', version: '0.1' },
      }, 15000);
      break;
    } catch (e) {
      lastErr = e;
      // Server returns error.data.supported: [...] on "Unsupported protocol version".
      const supported = e.rpcData && e.rpcData.supported;
      if (Array.isArray(supported)) {
        for (let i = supported.length - 1; i >= 0; i--) {
          if (!tried.has(supported[i])) queue.unshift(supported[i]);
        }
      }
    }
  }
  if (!result) throw lastErr;

  await rpcNotify('notifications/initialized', {});
  // MANDATORY: The server rejects every execute_script call until the preamble has been read.
  // Without this call, scripts silently return text like "ERROR: The preamble documentation topic has not yet been read."
  await rpcCall('tools/call', {
    name: 'read_sdk_documentation_topic',
    arguments: { filename: 'preamble' },
  }, 10000);
}
```

Notes:
- `rpcNotify` is the same as `rpcCall` without an `id` and without registering a pending entry — server sends no reply.
- **Enrich errors with `rpcCode` and `rpcData` properties** so the protocol-version-negotiation can read `error.data.supported`. The JSON-RPC `error` object has shape `{ code, message, data? }`.
- The server sometimes sends generic error text inside an `ok: true` envelope (`content: [{type:'text', text:'ERROR: ...'}]`). Treat text-only content as a surface-level error when a tool that should return an `image` returns only text.

---

## 2. Available tools

From `tools/list` on a live Affinity Photo 2 MCP server (confirmed 2026-04-21):

| Tool | Purpose |
|---|---|
| `execute_script` | Run JS inside Affinity's scripting runtime. **Requires preamble to have been read first.** |
| `render_selection` | Ask Affinity to rasterize the current selection of the named document |
| `render_spread` | Rasterize a whole spread |
| `read_sdk_documentation_topic` | Read an SDK doc (mandatory for `preamble`) |
| `list_sdk_documentation` | List available doc topics |
| `search_sdk_hints` | Keyword search across hints |
| `add_sdk_hint` | Submit a new hint |
| `list_library_scripts` | Enumerate saved scripts |
| `read_library_script` | Read a saved script by name |
| `save_script_to_library` | Save a script under the user's library |
| `report_sdk_issue` | File a bug report |

---

## 3. Affinity scripting runtime (what `execute_script` runs)

- The runtime is a restricted JS engine inside Affinity Photo 2.
- It has **no `atob`, no `btoa`**. Base64 must be implemented inline on both sides.
- It has no DOM, no `fetch`, no `setTimeout`/`setInterval`, no timers at all.
- Scripts communicate back by writing to `console.log(...)`. The MCP server wraps all console output as `content: [{ type: 'text', text: '<concatenated output>\n' }]` on the `tools/call` reply.
- Modules are loaded with `require('/name')`. Confirmed modules:
  - `/document` — `Document` (static `Document.current`)
  - `/rasterobject` — `RasterFormat`, `PixelBuffer`, `Bitmap`
  - `/nodes` — `RasterNodeDefinition`
  - `/geometry` — `Rectangle`

### Parsing script output

Because `console.log` output is free-text, emit a sentinel so the browser side can parse deterministically:

```js
// In the Affinity script
console.log('CRUSH_DATA:' + JSON.stringify(payload));
```

```js
// In the browser
function parseScriptPayload(result) {
  const text = (result.content || []).map(c => c.text || '').join('\n');
  const idx = text.indexOf('CRUSH_DATA:');
  if (idx < 0) throw new Error('No payload marker: ' + text.slice(0, 200));
  const tail = text.slice(idx + 'CRUSH_DATA:'.length).trim();
  // Only parse up to the first newline after the marker.
  const firstLine = tail.split(/\r?\n/, 1)[0];
  return JSON.parse(firstLine);
}
```

The previous heuristic — "last line that starts with `{` and ends with `}`" — breaks when Affinity prefixes errors like `"ERROR: The preamble documentation topic has not yet been read."` before anything else. A sentinel avoids this entirely.

---

## 4. Document API

`Document.current` is the currently-focused document (or `null`).

Useful, confirmed properties:

| Property | Type | Notes |
|---|---|---|
| `sessionUuid` | string | **Required** as `document_session_uuid` argument for `render_selection` / `render_spread`. An empty string is rejected with "No document with that Uuid exists." |
| `persistentUuid` | string | Stable across sessions |
| `widthPixels` | number | Canvas width in pixels |
| `heightPixels` | number | Canvas height in pixels |
| `sizePixels` | object | `{width, height}` |
| `selection` | object | Has `.nodes` (array-like of selected nodes). Use `Array.from(doc.selection.nodes)[0]` for the first selected node. |
| `layers` | iterable | All layers in the document |
| `rootNode` | Node | The top of the node tree |
| `isOpen`, `isDirty`, `isReadOnly`, `needsSaving` | boolean | State flags |
| `addNode(nodeDef)` | method | Inserts a node at the current selection |

To fetch the document UUID from the browser:

```js
const res = await rpcCall('tools/call', {
  name: 'execute_script',
  arguments: {
    script:
      "const {Document}=require('/document');" +
      "const doc=Document.current;" +
      "console.log('CRUSH_DATA:'+JSON.stringify({ok:!!doc, uuid: doc ? String(doc.sessionUuid) : null}));",
  },
}, 10000);
```

---

## 5. Layer / Node API

Every Affinity node inherits this chain (outer-most to inner-most): `Object → HandleObject → Selectable → Node → (PhysicalNode →) (RasterNode | ImageNode | TextNode | VectorNode)`.

### Type discrimination

```js
const type = sel.isRasterNode || sel.isImageNode ? 'raster'
           : sel.isTextNode  ? 'text'
           : sel.isVectorNode ? 'vector'
           : 'unsupported';
```

### Bounding boxes

These are **properties**, not functions (there are also `getXxxBox()` variants that return the same values). All of them are in **pixel units**.

| Property | Coordinate space | Includes transforms? |
|---|---|---|
| `baseBox` | Document / spread pixels | Yes — this is where the user sees the layer |
| `lineBox` | Document / spread pixels | Yes — same as baseBox for most nodes |
| `constrainingBaseBox` | Document / spread pixels | Yes |
| `spreadVisibleBox` | Spread-local | Yes, but relative to spread origin (can have negative y if layer extends above) |
| `exactSpreadBaseBox` | Spread-local | Yes |
| `localVisibleBox` | Node-local | No |

**Use `baseBox` when you need "where does this layer sit inside the document canvas".** It's the one that matches what the user drags around in Affinity.

Shape of all boxes: `{ x, y, width, height }` (all numbers, may be fractional).

### Visibility

Properties (read-only for the most part): `globalOpacity`, `fillOpacity`, `isVisibleInExport`, `isVisibleInDomain`, `testVisibility(...)`. There is a `visibilityInterface` sub-object that exposes setters. We did not need to toggle visibility in CRUSH — extracting raw pixels via `RasterNode.rasterInterface` bypasses compositing so nothing needs hiding.

### RasterNode-specific API

`/document` gives you `Document`; raster extraction lives on the node itself:

```js
const pbuf = sel.rasterInterface.createCompatibleBuffer(true);
// pbuf.width, pbuf.height, pbuf.format.value, pbuf.buffer (ArrayBuffer)
```

- `pbuf.width, pbuf.height` match `sel.rasterWidth / rasterHeight`. The **native layer raster**, which can be larger or smaller than `baseBox.width/height` if the layer has a transform.
- `pbuf.buffer` is a raw `ArrayBuffer` whose layout depends on `pbuf.format.value`.

### Text / Vector

These nodes have no `rasterInterface`. You cannot extract pixels directly — you must ask the server to rasterize via `render_selection`, then crop to `baseBox`.

---

## 6. RasterFormat enum

Confirmed values (2026-04-21):

| Enum | `.value` | Bytes/pixel | Notes |
|---|---:|---:|---|
| `RGBA8` | 0 | 4 | Standard 8-bit document; `pbuf.buffer` is directly usable as `Uint8Array` |
| `RGBA16` | 1 | 8 | 16-bit; read as `Uint16Array`, contract to 8-bit with `>> 8` |
| `IA8` | 2 | 2 | Grayscale + alpha, 8-bit |
| `IA16` | 3 | 4 | Grayscale + alpha, 16-bit |
| `CMYKA8` | 4 | 5 | CMYK + alpha, 8-bit |
| `LABA16` | 5 | 8 | Lab + alpha, 16-bit |
| `M8` | 6 | 1 | Grayscale only, 8-bit |
| `M16` | 7 | 2 | Grayscale only, 16-bit |
| `EMPTY` | 8 | 0 | Empty layer |
| `RGBAUF` | 9 | 16? | 32-bit float RGBA (HDR documents) |
| `MF` | 10 | 4? | 32-bit float grayscale |

If the user creates a 32-bit HDR document, `pbuf.format.value` will be `9` (`RGBAUF`) and the raw buffer cannot be read as a plain `Uint8Array`. For CRUSH's purposes we fall back to `render_selection` for any non-RGBA8/16 format.

---

## 7. Push — browser Canvas → new pixel layer in Affinity

### Browser side

1. `canvas.getContext('2d').getImageData(0, 0, W, H)` gives you a RGBA `Uint8ClampedArray`.
2. Base64-encode the bytes. The large-apply trick works for up to ~8MB; above that, switch to `FileReader.readAsDataURL` or encode in rAF chunks:
   ```js
   function bytesToBase64(bytes) {
     const CHUNK = 0x8000;
     let bin = '';
     for (let i = 0; i < bytes.length; i += CHUNK) {
       bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
     }
     return btoa(bin);
   }
   ```

### Affinity side (inside `execute_script`)

1. Decode base64 manually (no `atob`).
2. Create a `PixelBuffer` in the document's native format (probe an existing raster node first — adding a `RGBA8` node to a 16-bit doc triggers a format mismatch).
3. Copy the decoded bytes into the buffer, widening 8→16 with `v * 257` if needed.
4. Create a `Bitmap`, copy the buffer in, wrap in a `RasterNodeDefinition`, add via `doc.addNode(nodeDef)`.

```js
'use strict';
const { Document } = require('/document');
const { RasterFormat, PixelBuffer, Bitmap } = require('/rasterobject');
const { RasterNodeDefinition } = require('/nodes');
const { Rectangle } = require('/geometry');

const doc = Document.current;
if (!doc) { console.log('CRUSH_DATA:' + JSON.stringify({ok:false, error:'NO_DOC'})); return; }

const W = ${W}, H = ${H};
const b64 = ${JSON.stringify(b64)};
function b64bytes(s) { /* inline decoder */ ... }
const bin = b64bytes(b64);

// Probe native format from an existing raster node, else fall back to RGBA8/16.
let docFormat = null;
for (const n of Array.from(doc.layers)) {
  if (n.isRasterNode || n.isImageNode) {
    docFormat = n.rasterInterface.createCompatibleBuffer(false).format;
    break;
  }
}

function tryAdd(fmt) {
  const pbuf = PixelBuffer.create(W, H, fmt);
  const dst = fmt.value === RasterFormat.RGBA8.value
    ? new Uint8Array(pbuf.buffer)
    : new Uint16Array(pbuf.buffer);
  if (fmt.value === RasterFormat.RGBA8.value) {
    dst.set(bin);
  } else {
    for (let i = 0; i < bin.length; i++) dst[i] = bin[i] * 257;
  }
  const bmp = Bitmap.create(W, H, fmt);
  pbuf.copyTo(bmp, new Rectangle(0, 0, W, H), 0, 0);
  const nodeDef = RasterNodeDefinition.create(fmt);
  nodeDef.bitmap = bmp;
  doc.addNode(nodeDef);
}

try {
  if (docFormat) tryAdd(docFormat);
  else { try { tryAdd(RasterFormat.RGBA8); } catch (_) { tryAdd(RasterFormat.RGBA16); } }
  const newly = Array.from(doc.selection.nodes);
  if (newly.length) { try { newly[0].name = ${JSON.stringify(layerName)}; } catch (_) {} }
  console.log('CRUSH_DATA:' + JSON.stringify({ ok: true, name: ${JSON.stringify(layerName)} }));
} catch (e) {
  console.log('CRUSH_DATA:' + JSON.stringify({ ok: false, error: 'ADD_FAILED', detail: e.message }));
}
```

Edge cases:
- Lab / CMYK / HDR documents — `tryAdd(RGBA8)` throws. The probe-existing-raster-format strategy avoids this, but if the doc has zero raster layers you must surface `UNSUPPORTED_DOC_FORMAT` to the user.
- `nodeDef.bitmap = bmp` attaches the bitmap; `addNode` commits it. If you skip `addNode`, the layer is orphaned.
- `doc.selection.nodes` after `addNode` contains the freshly-added node — that's the best time to rename it.

---

## 8. Pull — Affinity selection → browser image

Two paths, picked based on the selected node's type and pixel format:

### Fast path: raster layer in RGBA8 or RGBA16

This is the only way to get **layer-only pixels** (no other layers composited in). Do this whenever possible.

```js
'use strict';
const { Document } = require('/document');
const { RasterFormat } = require('/rasterobject');
const doc = Document.current;
const sel = Array.from(doc.selection.nodes)[0];
const pbuf = sel.rasterInterface.createCompatibleBuffer(true);
const W = pbuf.width, H = pbuf.height;
const fmtValue = pbuf.format.value;

let rgba8 = null;
if (fmtValue === RasterFormat.RGBA8.value) {
  rgba8 = new Uint8Array(pbuf.buffer);
} else if (fmtValue === RasterFormat.RGBA16.value) {
  const src16 = new Uint16Array(pbuf.buffer);
  rgba8 = new Uint8Array(W * H * 4);
  for (let i = 0; i < rgba8.length; i++) rgba8[i] = src16[i] >> 8;
}
if (!rgba8) {
  console.log('CRUSH_DATA:' + JSON.stringify({ ok: false, error: 'BAD_FORMAT', formatValue: fmtValue }));
} else {
  // inline base64 encoder (see CRUSH's affinity.js for the full version)
  let b64 = ...;
  console.log('CRUSH_DATA:' + JSON.stringify({ ok: true, W, H, b64 }));
}
```

Browser side:

```js
const bin = atob(b64);
const bytes = new Uint8ClampedArray(bin.length);
for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
const c = document.createElement('canvas');
c.width = W; c.height = H;
c.getContext('2d').putImageData(new ImageData(bytes, W, H), 0, 0);
const dataUrl = c.toDataURL('image/png');
```

Post-processing recommended:
- **Trim alpha=0 edges.** Layer rasters often extend well past their painted region (e.g. a 3150×3128 raster containing a small visible area in one corner). Scan for `alpha > 0` bounds and crop.
- **Flatten onto white.** CRUSH displays alpha-transparent pixels as a checkerboard, which users read as "broken". Composite the image onto a solid white canvas before handing it to downstream pipelines. Opaque images are unaffected.

### Fallback: `render_selection` + crop

Used when the fast path fails — text, vector, or non-RGBA8/16 raster.

1. Probe the selection to get the `baseBox` in document coordinates plus `doc.widthPixels / heightPixels`.
2. Call `render_selection` with `document_session_uuid`.
3. Server returns a PNG/JPEG. Dimensions may be smaller than the document (server downsamples large docs). Scale the crop rect by `renderW / docW`, `renderH / docH`.

```js
const render = await rpcCall('tools/call', {
  name: 'render_selection',
  arguments: { document_session_uuid: docUuid },
});
const img = (render.content || []).find(c => c.type === 'image');
if (!img || !img.data) throw new Error('render_selection returned no image');
const dataUrl = 'data:' + (img.mimeType || 'image/png') + ';base64,' + img.data;

// Crop to layer bounds intersected with document rect
const [bx, by, bw, bh] = [probe.bounds.x, probe.bounds.y, probe.bounds.width, probe.bounds.height];
const ix = Math.max(0, bx), iy = Math.max(0, by);
const iw = Math.min(probe.docW, bx + bw) - ix;
const ih = Math.min(probe.docH, by + bh) - iy;
// draw the decoded image onto a tiny canvas with those coords scaled to rendered dimensions
```

Important caveat: `render_selection` renders the full **composited** document, not just the selected layer. Anything below the selection is visible in the crop. If you need true layer isolation and the fast path won't fit, toggle every sibling's visibility off, call `render_selection`, then restore visibility (be prepared to deal with Affinity's undo stack).

---

## 9. Known error codes

These are the short error identifiers we produce in `execute_script` payloads. They map to user-facing messages via a small lookup table.

| Code | Cause | Suggested message |
|---|---|---|
| `NO_DOC` | No document open in Affinity | "Open a document in Affinity first." |
| `NO_SELECTION` | No layer selected | "Select a layer in Affinity before pulling." |
| `UNSUPPORTED` | Selected node type is not raster/image/text/vector | "Select a pixel, image, vector, or text layer." |
| `BAD_FORMAT` | Raster layer uses a pixel format we haven't implemented (e.g. `RGBAUF` for HDR docs) | Fall back to `render_selection` |
| `UNSUPPORTED_DOC_FORMAT` | Document uses a color format the push path doesn't know | "Document format not supported. Convert the document to RGB first." |
| `ADD_FAILED` | `doc.addNode(nodeDef)` threw | "Affinity refused to add the layer" + detail |

And from the server itself:
- `-32602 Unsupported protocol version` with `data.supported: [...]` — negotiate by retrying with one of the supported versions.

---

## 10. Gotchas / traps (learned the hard way)

1. **Preamble is mandatory.** Until `read_sdk_documentation_topic(preamble)` has been called once per session, every `execute_script` call returns a text-form error with no structured payload.
2. **`document_session_uuid: ''` is rejected.** Always fetch `Document.current.sessionUuid` first.
3. **`render_selection` is not "render only the selection".** It renders the whole composited document; the `selection` in the tool name refers to which document/spread is being targeted via the UUID. If you need layer isolation, use the fast path or the visibility-toggle trick.
4. **Layer rasters can be bigger than the document.** `sel.rasterWidth` / `rasterHeight` are native, but `baseBox.width` / `height` are the on-canvas placement (often smaller due to transforms). Crop expectations depend on which one you return.
5. **The server downsamples.** `render_selection` for a 3000×3000 document can return a 512×512 JPEG. Always read `img.naturalWidth / naturalHeight` from the decoded image before scaling, not the doc dimensions.
6. **The Affinity runtime has no `btoa` / `atob`.** Inline both encoder and decoder or keep hitting "ReferenceError: btoa is not defined".
7. **Checkerboard is CRUSH's display, not the rendered image.** Flatten onto white *before* handing off, not inside the display layer, or you'll keep getting "pull imports transparency" bug reports.
8. **Server version string lies.** `serverInfo.version` is the MCP bridge version, not Affinity's. Don't show it in user-facing status.
9. **Don't try to keep one `EventSource` per `tools/call`.** Use a single long-lived SSE connection and route by JSON-RPC `id`. Browser connection limits will otherwise stall the pipeline.
10. **Transfer cost.** A 3150×3128 RGBA8 layer = 39 MB raw → 52 MB as base64 → ~105 MB of UTF-16 string memory during transit. Anything near or above that will freeze the browser for seconds. Consider an on-Affinity-side row-by-row alpha trim before base64-encoding for large layers, or use `render_selection` as an "approximate but fast" path.

---

## 11. Minimal state machine for a plugin

```
DISCONNECTED
  ↓ user clicks Connect
CONNECTING                 → open SSE
  ↓ endpoint event
INITIALIZING               → protocolVersion negotiation
  ↓ success
READING_PREAMBLE           → read_sdk_documentation_topic(preamble)
  ↓ success
CHECKING_DOC               → execute_script(Document.current != null)
  ↓
CONNECTED (hasDoc true/false)
  ↓ user clicks Pull / Push
BUSY                       → run flow above
  ↓ done / error
CONNECTED

On SSE error while CONNECTED:
  → schedule RECONNECTING with exponential backoff (1s, 2s, 5s, 15s, 30s, give up)
```

CRUSH's bridge lives in [`affinity.js`](./affinity.js) and demonstrates all of the above in ~500 lines.

---

## 12. Reference: tested SDK shapes

From live probes during the CRUSH integration (all confirmed 2026-04-21, Affinity Photo 2, MCP server version 1.0.0):

### RasterNode proto chain

- `RasterNode`: `isRasterNode`, `extendEmpty`, `rasterInterface`, `rasterWidth`, `rasterHeight`, `rasterFormat`, `pixelSize`, `createCompatibleBitmap`, `createCompatibleBuffer`, `copyTo`
- `PhysicalNode`: `isPhysicalNode`, `canTransformWhileProtectingChildList`
- `Node`: `isNode`, `document`, `parent`, `firstChild`, `lastChild`, `children`, `spread`, `baseBox`, `lineBox`, `constrainingBaseBox`, `spreadVisibleBox`, `localVisibleBox`, `exactSpreadBaseBox`, `getContentExtentsBox()`, `transform`, `visibilityInterface`, `globalOpacity`, `fillOpacity`, `isVisibleInExport`, `testVisibility`, `exportableInterface`, `layerEffectsInterface`, `blendMode`, `blendOptions`, `antialiasingMode`, `isLocked`, `lock`, `unlock`, `delete`, `duplicate`, `moveToFirstChild`, `moveToLastChild`, `moveToNextSibling`, `moveToParent`, `moveToPreviousSibling`

### Document proto (selected)

`promises`, `sessionUuid`, `persistentUuid`, `widthPixels`, `heightPixels`, `sizePixels`, `dpi`, `viewdpi`, `layers`, `spreads`, `artboards`, `hasArtboards`, `rootNode`, `selection`, `rasterSelection`, `format`, `maskFormat`, `colourProfile`, `currentSpread`, `canUndo`, `canRedo`, `undoDescription`, `redoDescription`, `undo`, `redo`, `selectAll`, `deleteSelection`, `addNode`, `close`, `closeAsync`, `save`, `saveAs`, `saveAsPackage`, `saveAsync`, `saveAsAsync`, `export`, `exportAsync`, `executeCommand`, `executeCommandAsync`, `enumerateFontNames`, `getFontNames`.

### `tools/list` tool names

`add_sdk_hint`, `execute_script`, `list_library_scripts`, `list_sdk_documentation`, `read_library_script`, `read_sdk_documentation_topic`, `render_selection`, `render_spread`, `report_sdk_issue`, `save_script_to_library`, `search_sdk_hints`.

---

*If you extend this doc after shipping your plugin, add a "Discovered since CRUSH v0.5.0" section rather than rewriting — future-you will want the provenance.*
