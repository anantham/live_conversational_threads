const DEFAULT_MAX_LINES = 80;

function cleanTranscriptText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

function speakerFromMetadata(metadata = {}) {
  const speaker =
    metadata.speaker_name ||
    metadata.speaker ||
    metadata.speaker_id ||
    metadata.speaker_uuid ||
    "";
  return String(speaker || "").trim() || null;
}

function shouldReplaceLastLine(lastLine, nextText, speaker, isFinal) {
  if (!lastLine) return false;
  if (lastLine.isFinal && !isFinal) return false;
  if ((lastLine.speaker || null) !== (speaker || null)) return false;
  return !lastLine.isFinal || lastLine.text === nextText;
}

export function upsertLiveTranscriptLine(previousLines, event, lineIdRef, options = {}) {
  const cleanText = cleanTranscriptText(event?.text);
  if (!cleanText) return previousLines;

  const maxLines = options.maxLines || DEFAULT_MAX_LINES;
  const isFinal = event?.eventType === "transcript_final";
  const metadata = event?.metadata || {};
  const speaker = speakerFromMetadata(metadata);
  const speakerId = metadata.speaker_uuid || metadata.speaker_id || null;
  const timestampStart = event?.timestamps?.start == null
    ? null
    : Number(event.timestamps.start);
  const timestampEnd = event?.timestamps?.end == null
    ? null
    : Number(event.timestamps.end);
  const lastLine = previousLines[previousLines.length - 1] || null;
  const trimLines = (lines) => lines.slice(-maxLines);

  const nextLine = {
    id: lineIdRef.current,
    text: cleanText,
    isFinal,
    speaker,
    speakerId,
    ...(Number.isFinite(timestampStart) ? { timestamp_start: timestampStart } : {}),
    ...(Number.isFinite(timestampEnd) ? { timestamp_end: timestampEnd } : {}),
  };

  if (shouldReplaceLastLine(lastLine, cleanText, speaker, isFinal)) {
    return trimLines([
      ...previousLines.slice(0, -1),
      {
        ...lastLine,
        ...nextLine,
        id: lastLine.id,
      },
    ]);
  }

  lineIdRef.current += 1;
  return trimLines([...previousLines, nextLine]);
}
