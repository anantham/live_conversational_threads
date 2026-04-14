function sanitizeTitlePart(value) {
  return String(value || "")
    .replace(/[/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSpeakerLabel(value) {
  const cleaned = sanitizeTitlePart(value);
  if (!cleaned) return "";
  if (/^speaker[_\s-]*\d+$/i.test(cleaned) || /^speaker[_\s-]*[a-z0-9]+$/i.test(cleaned)) {
    return "";
  }
  return cleaned;
}

function uniqueOrdered(values) {
  const seen = new Set();
  const ordered = [];
  values.forEach((value) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    ordered.push(value);
  });
  return ordered;
}

export function deriveSuggestedConversationTitle(graphData) {
  const nodes = Array.isArray(graphData)
    ? graphData.flatMap((chunk) => (Array.isArray(chunk) ? chunk : []))
    : [];

  if (nodes.length === 0) return "";

  const prioritizedTitles = uniqueOrdered(
    [3, 2, 4, 1].flatMap((semanticLevel) =>
      nodes
        .filter((node) => Number(node?.semantic_level) === semanticLevel)
        .map((node) => sanitizeTitlePart(node?.node_name || node?.summary || ""))
        .filter(Boolean)
    )
  );

  const fallbackTitles = uniqueOrdered(
    nodes
      .map((node) => sanitizeTitlePart(node?.node_name || node?.summary || ""))
      .filter(Boolean)
  );

  const topic = prioritizedTitles[0] || fallbackTitles[0] || "Conversation";
  const speakers = uniqueOrdered(
    nodes
      .map((node) => normalizeSpeakerLabel(node?.speaker_display || node?.speaker_id || ""))
      .filter(Boolean)
  ).slice(0, 2);

  let suggestion = topic;
  if (speakers.length === 1) {
    suggestion = `${speakers[0]} on ${topic}`;
  } else if (speakers.length >= 2) {
    suggestion = `${speakers[0]} and ${speakers[1]} on ${topic}`;
  }

  return sanitizeTitlePart(suggestion).slice(0, 96);
}
