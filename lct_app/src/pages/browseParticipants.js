const METADATA_LABELS = new Set([
  "chunk_index",
  "contact_id",
  "date_imported",
  "display_name",
  "doc_id",
  "file_id",
  "modified_date",
  "name",
  "owner",
  "source",
  "speaker",
  "title",
  "utterance_count",
]);

const PLACEHOLDER_SPEAKER = /^(?:speaker|spk)[-_ ]?\d+$/i;
const MARKDOWN_WRAPPER = /^(?:\*\*|__|#+\s*|@\s*$)/;

export function participantLabel(participant) {
  if (!participant || typeof participant !== "object") return "";
  return String(
    participant.display_name || participant.name || participant.contact_id || "",
  )
    .replace(/\s+/g, " ")
    .trim();
}

export function isUsefulParticipantLabel(label) {
  const value = String(label || "").trim();
  if (value.length < 2 || value.length > 80) return false;
  if (MARKDOWN_WRAPPER.test(value)) return false;
  if (PLACEHOLDER_SPEAKER.test(value)) return false;
  if (METADATA_LABELS.has(value.toLowerCase())) return false;
  return /[\p{L}\p{N}]/u.test(value);
}

export function participantKey(participant) {
  const label = participantLabel(participant);
  if (!isUsefulParticipantLabel(label)) return null;
  const contactId = String(participant?.contact_id || "").trim();
  return contactId ? `id:${contactId}` : `name:${label.toLocaleLowerCase()}`;
}

export function buildContactOptions(conversations) {
  const byKey = new Map();
  for (const conversation of conversations || []) {
    for (const participant of conversation?.participants || []) {
      const key = participantKey(participant);
      if (!key) continue;
      const label = participantLabel(participant);
      const existing = byKey.get(key);
      if (!existing || (existing.label === existing.label.toLowerCase() && label !== label.toLowerCase())) {
        byKey.set(key, { key, label });
      }
    }
  }
  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}
