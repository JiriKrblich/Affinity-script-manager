const test = require("node:test");
const assert = require("node:assert/strict");
const { topicNames, markdownForSnapshot, searchSnapshot } = require("../sdk-docs");

test("parses SDK topic list and excludes the preamble", () => {
  const names = topicNames({ content: [{ type: "text", text: "preamble, nodes.js, examples/addPoints.js, nodes.js, ../bad.js, " }] });
  assert.deepEqual(names, ["nodes.js", "examples/addPoints.js"]);
});

test("exports a versioned Markdown file and searches its topic contents", () => {
  const snapshot = {
    version: "3.1.0", capturedAt: "2026-10-30T00:00:00.000Z",
    topics: [{ title: "nodes.js", content: "class Node {\n  addPoint(x, y) {}\n}" }],
  };
  const markdown = markdownForSnapshot(snapshot);
  assert.match(markdown, /# Affinity SDK 3\.1\.0/);
  assert.match(markdown, /## nodes\.js\n\n```js/);
  assert.deepEqual(searchSnapshot(snapshot, "addPoint"), [
    { title: "nodes.js", line: 2, snippet: "addPoint(x, y) {}" },
  ]);
});
