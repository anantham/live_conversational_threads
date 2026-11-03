const label = (value) => typeof value === "string" ? value.trim() : "";

/** Current, artifact-local display names keyed by immutable speaker IDs. */
export function buildSpeakerDisplayNames(utterancesOrBundle, nodes = []) {
  const bundle = Array.isArray(utterancesOrBundle) ? null : utterancesOrBundle;
  const utterances = bundle ? bundle.utterances : utterancesOrBundle;
  const graphNodes = bundle ? bundle.graph_data : nodes;
  const names = new Map();
  const add = (row) => {
    const id = label(row?.speaker_id);
    if (!id) return;
    const name = label(row?.speaker_name) || label(row?.speaker_display);
    if (name && name !== id) names.set(id, name);
  };
  (Array.isArray(graphNodes) ? graphNodes.flat() : []).forEach(add);
  (Array.isArray(utterances) ? utterances : []).forEach(add);
  return names;
}

export function speakerDisplayName(names, speakerId) {
  const id = label(speakerId);
  return names?.get(id) || id || "Unknown speaker";
}

/** Only speaker prefixes at the start of a source line may be substituted. */
export function transcriptSpeakerLabels(transcript, names) {
  if (typeof transcript !== "string" || !names?.size) return [];
  const replacements = [];
  let lineStart = 0;
  for (const line of transcript.split("\n")) {
    // Current export: [SPEAKER_00] words. Older source: [time] SPEAKER_00: words.
    const forms = [
      /^(\[[^\]\r\n]*\]\s+)([^:\r\n]+)(?=:\s)/,
      /^(\[)([^\]\r\n]+)(?=\](?:\s|$))/,
      /^()(\S[^:\r\n]*)(?=:\s)/,
    ];
    for (const form of forms) {
      const match = form.exec(line);
      if (!match) continue;
      const raw = match[2];
      const id = raw.trim();
      const replacement = names.get(id);
      if (replacement && replacement !== id) {
        const start = lineStart + match[1].length + raw.indexOf(id);
        replacements.push({ start, end: start + id.length, speakerId: id, text: replacement });
        break;
      }
    }
    lineStart += line.length + 1;
  }
  return replacements;
}
