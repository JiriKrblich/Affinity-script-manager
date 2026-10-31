const test = require("node:test");
const assert = require("node:assert/strict");
const { initialAppLanguage } = require("../language");

test("selects supported first-run languages and falls back to English", () => {
  assert.equal(initialAppLanguage("cs-CZ"), "cs");
  assert.equal(initialAppLanguage("ja-JP"), "ja");
  assert.equal(initialAppLanguage("ko-KR"), "ko");
  assert.equal(initialAppLanguage("zh-Hans-CN"), "zh-CN");
  assert.equal(initialAppLanguage("zh-CN"), "zh-CN");
  assert.equal(initialAppLanguage("zh-SG"), "zh-CN");
  assert.equal(initialAppLanguage("zh-TW"), "en");
  assert.equal(initialAppLanguage("de-DE"), "de");
  assert.equal(initialAppLanguage("fr-CA"), "fr");
  assert.equal(initialAppLanguage("es-MX"), "es");
  assert.equal(initialAppLanguage("it-IT"), "en");
  assert.equal(initialAppLanguage(undefined), "en");
});
