// A registry entry can be published before its script file. Keep the entry
// visible, but do not offer actions that would fetch a known-missing file.
function registryEntryProblem(script, idCounts) {
  if (!script || typeof script.id !== "string" || !script.id.trim()) return "invalid";
  if ((idCounts.get(`${script._source || ""}\0${script.id}`) || 0) > 1) return "duplicate";
  try {
    const url = new URL(script.download_url);
    if (url.protocol !== "https:" || !url.pathname.toLowerCase().endsWith(".js")) return "invalid";
  } catch { return "invalid"; }
  return null;
}

async function markScriptAvailability(scripts, check, concurrency = 16) {
  const idCounts = new Map();
  for (const script of scripts) {
    if (!script || typeof script.id !== "string") continue;
    const key = `${script._source || ""}\0${script.id}`;
    idCounts.set(key, (idCounts.get(key) || 0) + 1);
  }
  const entries = scripts.map((script) => ({
    ...script,
    _unavailableReason: registryEntryProblem(script, idCounts),
  }));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      if (entry._unavailableReason) continue;
      try {
        if (await check(entry.download_url) === false) entry._unavailableReason = "missing";
      } catch {
        // Network failures are transient; the download action remains available.
      }
    }
  }));
  return entries;
}

module.exports = { registryEntryProblem, markScriptAvailability };
