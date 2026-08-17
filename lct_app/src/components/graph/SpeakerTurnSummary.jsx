import PropTypes from "prop-types";

const FALLBACK_MARKER = "#94a3b8";

/** Render structured moment turns without repeating speaker names in card text. */
export default function SpeakerTurnSummary({ turns, speakerColorMap, maxLength = 500 }) {
  let remaining = maxLength;
  const visible = [];
  for (const turn of turns || []) {
    if (remaining <= 0) break;
    const text = String(turn?.text || "").trim();
    if (!text) continue;
    if (text.length > remaining && remaining < 2) break;
    const clipped = text.length > remaining
      ? `${text.slice(0, Math.max(0, remaining - 1)).trim()}…`
      : text;
    visible.push({ ...turn, text: clipped });
    remaining -= clipped.length;
  }
  if (visible.length === 0) return null;

  return (
    <div style={containerStyle} aria-label="Conversation turns">
      {visible.map((turn, index) => (
        <div
          key={turn.utterance_id || `${turn.speaker_id || "speaker"}-${index}`}
          data-speaker-id={turn.speaker_id || undefined}
          style={turnStyle}
        >
          <span
            aria-hidden="true"
            style={{
              ...markerStyle,
              background: speakerColorMap?.[turn.speaker_id] || FALLBACK_MARKER,
            }}
          />
          <span>{turn.text}</span>
        </div>
      ))}
    </div>
  );
}

SpeakerTurnSummary.propTypes = {
  turns: PropTypes.arrayOf(PropTypes.shape({
    utterance_id: PropTypes.string,
    speaker_id: PropTypes.string,
    text: PropTypes.string.isRequired,
  })),
  speakerColorMap: PropTypes.objectOf(PropTypes.string),
  maxLength: PropTypes.number,
};

const containerStyle = {
  display: "flex",
  flexDirection: "column",
  gap: "7px",
  fontWeight: 400,
  fontSize: "14px",
  color: "#475569",
  lineHeight: 1.55,
};

const turnStyle = {
  display: "grid",
  gridTemplateColumns: "8px minmax(0, 1fr)",
  alignItems: "start",
  gap: "7px",
};

const markerStyle = {
  width: "7px",
  height: "7px",
  borderRadius: "999px",
  marginTop: "7px",
  boxShadow: "0 0 0 1px rgba(15,23,42,0.12)",
};
