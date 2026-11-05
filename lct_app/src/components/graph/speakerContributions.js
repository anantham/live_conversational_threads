const UNKNOWN_SPEAKER = "UNKNOWN";
const asArray = (value) => Array.isArray(value) ? value : [];

function passageIds(node) {
  return [
    ...asArray(node?.utterance_ids),
    ...asArray(node?.provenance_utterance_ids),
    ...asArray(node?.source_ref?.utterance_ids),
    ...asArray(node?.provenance_source_ref?.utterance_ids),
    ...(Array.isArray(node?.source_turns)
      ? node.source_turns.map((turn) => turn?.utterance_id)
      : []),
  ].map((id) => String(id ?? "").trim()).filter(Boolean);
}

function measuredSeconds(row) {
  if (!row) return null;
  const declared = Number(row?.duration_seconds);
  if (Number.isFinite(declared) && declared > 0) return declared;
  if (row.timestamp_start == null || row.timestamp_end == null) return null;
  const start = Number(row?.timestamp_start);
  const end = Number(row?.timestamp_end);
  return Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start
    ? end - start
    : null;
}

function roundedPercents(speakers, totalSeconds) {
  const shares = speakers.map((speaker) => {
    const raw = speaker.seconds / totalSeconds * 100;
    return { id: speaker.id, base: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });
  let remaining = 100 - shares.reduce((sum, share) => sum + share.base, 0);
  shares.sort((a, b) => b.remainder - a.remainder || a.id.localeCompare(b.id));
  for (const share of shares) {
    if (remaining <= 0) break;
    share.base += 1;
    remaining -= 1;
  }
  return new Map(shares.map((share) => [share.id, share.base]));
}

/**
 * Resolve each node's source-linked speaking time. A passage linked through
 * several descendants counts once. Incomplete timing is reported explicitly;
 * callers must not draw proportional fills from a partial denominator.
 */
export function buildSpeakerContributions(nodes, utterances) {
  const list = Array.isArray(nodes) ? nodes.filter(Boolean) : [];
  const byId = new Map(list.map((node) => [String(node.id), node]));
  const childrenByParent = new Map();
  const addChild = (parentId, childId) => {
    if (parentId == null || childId == null || String(parentId) === String(childId)) return;
    const key = String(parentId);
    if (!childrenByParent.has(key)) childrenByParent.set(key, new Set());
    childrenByParent.get(key).add(String(childId));
  };
  list.forEach((node) => {
    asArray(node.children_ids).forEach((id) => addChild(node.id, id));
    addChild(node.parent_id ?? null, node.id);
    asArray(node.memberships).forEach((membership) => addChild(membership?.parent_id, node.id));
  });
  const rowById = new Map((Array.isArray(utterances) ? utterances : [])
    .filter((row) => row?.id != null)
    .map((row) => [String(row.id), row]));
  const result = new Map();

  list.forEach((node) => {
    const ids = new Set();
    const visited = new Set();
    const queue = [String(node.id)];
    while (queue.length) {
      const nodeId = queue.pop();
      if (visited.has(nodeId)) continue;
      visited.add(nodeId);
      passageIds(byId.get(nodeId)).forEach((id) => ids.add(id));
      (childrenByParent.get(nodeId) || []).forEach((childId) => queue.push(childId));
    }

    const secondsBySpeaker = new Map();
    let timedPassages = 0;
    for (const id of ids) {
      const row = rowById.get(id);
      const seconds = measuredSeconds(row);
      if (seconds == null) continue;
      timedPassages += 1;
      const speakerId = String(row.speaker_id ?? UNKNOWN_SPEAKER).trim() || UNKNOWN_SPEAKER;
      secondsBySpeaker.set(speakerId, (secondsBySpeaker.get(speakerId) || 0) + seconds);
    }
    const totalSeconds = [...secondsBySpeaker.values()].reduce((sum, seconds) => sum + seconds, 0);
    const complete = ids.size > 0 && timedPassages === ids.size && totalSeconds > 0;
    const ordered = [...secondsBySpeaker].map(([id, seconds]) => ({ id, seconds }))
      .sort((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id));
    const percents = complete ? roundedPercents(ordered, totalSeconds) : null;
    result.set(String(node.id), {
      speakers: ordered.map(({ id, seconds }) => ({
        id,
        seconds,
        fraction: complete ? seconds / totalSeconds : null,
        percent: complete ? percents.get(id) : null,
      })),
      totalSeconds,
      timedPassages,
      totalPassages: ids.size,
      complete,
    });
  });
  return result;
}
