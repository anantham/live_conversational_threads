const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeVideoId(raw) {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.searchParams.has("list")) return null;
    let id = null;
    if (url.hostname === "youtu.be") id = url.pathname.slice(1);
    if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) {
      if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) id = url.searchParams.get("v");
      else if (/^\/(shorts|live|embed)\/[A-Za-z0-9_-]{11}$/.test(url.pathname)) id = url.pathname.split("/").pop();
    }
    return VIDEO_ID.test(id || "") ? id : null;
  } catch { return null; }
}

export function validYouTubeRef(ref) {
  return ref?.provider === "youtube" && VIDEO_ID.test(ref.video_id || "")
    && ref.view_url === `https://www.youtube.com/watch?v=${ref.video_id}`
    && ref.time_unit === "seconds";
}

export function selectYouTubeRef(bundle) {
  // A combined corpus needs per-conversation media bindings. Never accidentally
  // seek every meeting into the first recording.
  if (bundle?.combined) return null;
  const refs = (bundle?.media_refs || []).filter(validYouTubeRef);
  return refs.length === 1 ? refs[0] : null;
}

export function validMediaSeconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 10800;
}

export function nodeVideoPassages(node, nodes = [], utterances = []) {
  if (!node) return [];
  const byId = new Map(nodes.map((n) => [String(n.id), n]));
  const utteranceById = new Map(utterances.map((u) => [String(u.id), u]));
  const ids = new Set();
  const visited = new Set();
  const queue = [node];
  while (queue.length) {
    const current = queue.pop();
    if (!current || visited.has(String(current.id))) continue;
    visited.add(String(current.id));
    const bound = current.provenance_utterance_ids || current.provenance_source_ref?.utterance_ids
      || current.source_ref?.utterance_ids || current.utterance_ids || [];
    bound.forEach((id) => ids.add(String(id)));
    (current.children_ids || []).forEach((id) => queue.push(byId.get(String(id))));
  }
  // Mobile deck may select an actual utterance, not a graph node.
  if (utteranceById.has(String(node.id))) ids.add(String(node.id));
  return [...ids].map((id) => utteranceById.get(id)).filter((u) => u
    && validMediaSeconds(u.timestamp_start) && validMediaSeconds(u.timestamp_end)
    && u.timestamp_end > u.timestamp_start)
    .sort((a, b) => a.timestamp_start - b.timestamp_start);
}

export function renameArtifactSpeaker(bundle, speakerId, name) {
  const label = String(name || "").trim().slice(0, 80);
  if (!speakerId || !label) return bundle;
  const renamed = (value) => value?.speaker_id === speakerId
    ? { ...value, speaker_name: label, speaker_display: label, speaker_source: "human_review" } : value;
  const utterances = (bundle.utterances || []).map(renamed);
  return {
    ...bundle,
    utterances,
    graph_data: (bundle.graph_data || []).map((entry) => Array.isArray(entry) ? entry.map(renamed) : renamed(entry)),
    full_transcript: utterances.map((u) => `${u.speaker_name || u.speaker_id || "UNKNOWN"}: ${u.text}`).join("\n"),
  };
}
