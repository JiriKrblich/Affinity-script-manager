const acorn = require("acorn");

const MODULES = [
  "nodes.js", "dialog.js", "commands.js", "geometry.js", "fills.js",
  "linestyle.js", "colours.js", "selections.js", "document.js",
];

function signatures(source) {
  const result = new Map();
  const ast = acorn.parse(source, { ecmaVersion: "latest", sourceType: "script" });
  for (const statement of ast.body) {
    const classNode = statement.type === "ClassDeclaration" ? statement
      : statement.type === "VariableDeclaration" ? statement.declarations.find((d) => d.init?.type === "ClassExpression")?.init
      : null;
    if (!classNode?.id?.name) continue;
    for (const method of classNode.body.body) {
      if (method.type !== "MethodDefinition" || method.kind === "constructor") continue;
      const name = method.key.name ?? method.key.value;
      if (typeof name !== "string") continue;
      const params = method.value.params.map((param) => source.slice(param.start, param.end).replace(/\s+/g, " ").trim());
      const key = `${classNode.id.name}.${name}`;
      result.set(key, { name: key, className: classNode.id.name, methodName: name, static: method.static, params });
    }
  }
  return result;
}

function compareSnapshots(previous, current) {
  const changes = [];
  for (const module of MODULES) {
    const before = signatures(previous.modules[module] || "");
    const after = signatures(current.modules[module] || "");
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      const oldMethod = before.get(key);
      const newMethod = after.get(key);
      if (oldMethod && newMethod && oldMethod.static === newMethod.static &&
          JSON.stringify(oldMethod.params) === JSON.stringify(newMethod.params)) continue;
      const method = newMethod || oldMethod;
      changes.push({
        module, name: key, className: method.className, methodName: method.methodName,
        kind: !oldMethod ? "added" : !newMethod ? "removed" : "changed",
        before: oldMethod ? `${key}(${oldMethod.params.join(", ")})` : null,
        after: newMethod ? `${key}(${newMethod.params.join(", ")})` : null,
      });
    }
  }
  return changes.sort((a, b) => a.module.localeCompare(b.module) || a.name.localeCompare(b.name));
}

function affectedCalls(code, changes) {
  const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return changes.filter((change) => change.kind !== "added" &&
    new RegExp(`\\b${escapePattern(change.className)}\\s*\\.\\s*${escapePattern(change.methodName)}\\s*\\(`).test(code))
    .map((change) => change.name);
}

module.exports = { MODULES, signatures, compareSnapshots, affectedCalls };
