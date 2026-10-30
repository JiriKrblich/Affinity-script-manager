const test = require("node:test");
const assert = require("node:assert/strict");
const { markScriptAvailability } = require("../community-availability");

const script = (id, file, source = "repo") => ({
  id,
  name: id,
  download_url: `https://example.com/${file}`,
  _source: source,
});

test("marks missing files and malformed registry entries without hiding valid scripts", async () => {
  const checked = [];
  const entries = await markScriptAvailability([
    script("ready", "ready.js"),
    script("pending", "pending.js"),
    script("duplicate", "first.js"),
    script("duplicate", "second.js"),
    script("", "no-id.js"),
    script("bad-url", "bad.txt"),
  ], async (url) => {
    checked.push(url);
    return !url.endsWith("pending.js");
  });
  assert.deepEqual(entries.map((entry) => entry._unavailableReason), [
    null, "missing", "duplicate", "duplicate", "invalid", "invalid",
  ]);
  assert.equal(checked.length, 2);
});

test("a file becomes available on the next check and network errors do not disable it", async () => {
  const pending = [script("later", "later.js")];
  assert.equal((await markScriptAvailability(pending, async () => false))[0]._unavailableReason, "missing");
  assert.equal((await markScriptAvailability(pending, async () => true))[0]._unavailableReason, null);
  assert.equal((await markScriptAvailability(pending, async () => { throw new Error("offline"); }))[0]._unavailableReason, null);
});
