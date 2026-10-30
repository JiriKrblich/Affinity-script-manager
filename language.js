const APP_LANGUAGES = ["en", "cs", "ja", "zh-CN", "ko", "de", "fr", "es"];

function initialAppLanguage(preferred) {
  const normalized = String(preferred || "en").replaceAll("_", "-");
  const base = normalized.split("-")[0].toLowerCase();
  if (base === "zh")
    return /(?:^|-)(?:CN|SG|Hans)(?:-|$)/i.test(normalized) ? "zh-CN" : "en";
  return APP_LANGUAGES.includes(base) ? base : "en";
}

module.exports = { APP_LANGUAGES, initialAppLanguage };
