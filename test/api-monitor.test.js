const test = require("node:test");
const assert = require("node:assert/strict");
const { compareSnapshots, affectedCalls } = require("../api-monitor");

test("detects reordered arguments without treating the method as removed", () => {
  const previous = { modules: { "nodes.js": "class PolyCurveNodeDefinition { static create(curve, brushFill, lineStyle, lineFill) {} }" } };
  const current = { modules: { "nodes.js": "class PolyCurveNodeDefinition { static create(curve, brushFill, lineFill, lineStyle) {} }" } };
  const changes = compareSnapshots(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "changed");
  assert.equal(changes[0].before, "PolyCurveNodeDefinition.create(curve, brushFill, lineStyle, lineFill)");
  assert.equal(changes[0].after, "PolyCurveNodeDefinition.create(curve, brushFill, lineFill, lineStyle)");
  assert.deepEqual(affectedCalls("PolyCurveNodeDefinition.create(a, b, c, d)", changes), ["PolyCurveNodeDefinition.create"]);
  assert.deepEqual(affectedCalls("Other.create(a, b, c, d)", changes), []);
});
