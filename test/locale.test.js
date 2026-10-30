const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const messages = JSON.parse(fs.readFileSync(path.join(root, "locales", "en.json"), "utf8"));
const renderer = fs.readFileSync(path.join(root, "renderer.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");

test("English dictionary covers referenced translation keys", () => {
  const keys = new Set([
    ...[...renderer.matchAll(/\bt\("([a-zA-Z0-9.]+)"/g)].map((match) => match[1]),
    ...[...html.matchAll(/data-i18n="([a-zA-Z0-9.]+)"/g)].map((match) => match[1]),
  ]);
  for (const key of keys) {
    assert.equal(typeof messages[key], "string", `Missing dictionary entry: ${key}`);
    assert.ok(messages[key].length > 0, `Empty dictionary entry: ${key}`);
  }
  assert.ok(keys.size > 40);
});

test("topic count message has its interpolation placeholder", () => {
  assert.match(messages["docs.topicCount"], /\{count\}/);
});

test("all shipped languages cover the English catalog and preserve placeholders", () => {
  for (const language of ["cs", "ja", "zh-CN", "ko", "de", "fr", "es"]) {
    const translated = JSON.parse(fs.readFileSync(path.join(root, "locales", `${language}.json`), "utf8"));
    assert.deepEqual(Object.keys(translated).sort(), Object.keys(messages).sort(), `${language} keys differ`);
    for (const [key, english] of Object.entries(messages)) {
      const variables = (value) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)]
        .map((match) => match[1]).sort();
      assert.deepEqual(variables(translated[key]), variables(english), `${language}: ${key} placeholders differ`);
      assert.ok(translated[key].trim(), `${language}: ${key} is empty`);
    }
  }
});
