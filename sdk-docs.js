function topicNames(result) {
  const raw = (result.content || [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join(",");
  if (!raw.trim() || /^error[:\s]/i.test(raw.trim()))
    throw new Error(`Affinity did not return SDK topics: ${raw.trim() || "empty response"}`);
  return [...new Set(raw.split(",").map((name) => name.trim()).filter((name) =>
    name !== "preamble" && /^[a-zA-Z0-9/_-]+\.(js|json)$/.test(name) &&
    !name.split("/").includes("..")))];
}

function markdownForSnapshot(snapshot) {
  const lines = [
    `# Affinity SDK ${snapshot.version}`,
    "",
    `Captured: ${snapshot.capturedAt}`,
    "",
    "Source: Affinity MCP SDK documentation",
    "",
  ];
  for (const topic of snapshot.topics) {
    const fence = "`".repeat(Math.max(3, ...[...topic.content.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    lines.push(`## ${topic.title}`, "", `${fence}${topic.title.endsWith(".json") ? "json" : "js"}`, topic.content, fence, "");
  }
  return lines.join("\n");
}

function searchSnapshot(snapshot, query, limit = 30) {
  const needle = String(query || "").trim().toLocaleLowerCase();
  if (!needle) return [];
  const results = [];
  for (const topic of snapshot.topics) {
    const lines = topic.content.split(/\r?\n/);
    let topicMatches = 0;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].toLocaleLowerCase().indexOf(needle);
      const titleMatch = i === 0 && topic.title.toLocaleLowerCase().includes(needle);
      if (match < 0 && !titleMatch) continue;
      const snippet = lines[i].trim().slice(0, 220);
      results.push({ title: topic.title, line: i + 1, snippet });
      if (results.length >= limit) return results;
      if (++topicMatches >= 3) break;
    }
  }
  return results;
}

module.exports = { topicNames, markdownForSnapshot, searchSnapshot };
