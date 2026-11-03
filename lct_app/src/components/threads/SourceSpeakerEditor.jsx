import { useMemo, useState } from "react";
import PropTypes from "prop-types";
import { mediaOffsetLabel } from "../../services/mediaSeek";
import { validMediaSeconds } from "../../services/youtubeMedia";

const friendlySpeakerName = (speakerId) => {
  const match = /^SPEAKER_(\d+)$/.exec(speakerId || "");
  return match ? `Speaker ${Number(match[1]) + 1}` : speakerId || "Unknown speaker";
};

export default function SourceSpeakerEditor({ bundle, onRenameSpeaker, onSeek }) {
  const speakers = useMemo(() => {
    const seen = new Set();
    return (bundle.utterances || []).filter((utterance) => {
      const id = utterance.speaker_id;
      if (!id || id === "UNKNOWN" || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }, [bundle.utterances]);
  const [speakerId, setSpeakerId] = useState("");
  const selectedId = speakers.some(({ speaker_id: id }) => id === speakerId) ? speakerId : speakers[0]?.speaker_id || "";
  const selectedSpeaker = speakers.find(({ speaker_id: id }) => id === selectedId);
  const [speakerName, setSpeakerName] = useState("");
  const passages = useMemo(() => (bundle.utterances || [])
    .filter((utterance) => utterance.speaker_id === selectedId)
    .sort((a, b) => a.timestamp_start - b.timestamp_start)
    .slice(0, 3), [bundle.utterances, selectedId]);

  if (!speakers.length) return null;
  const exportReviewedBundle = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "reviewed-conversation.threads";
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return <details className="mt-1 shrink-0 text-xs text-slate-500">
    <summary className="min-h-11 cursor-pointer py-2">Name the speakers</summary>
    <div className="mt-2 space-y-3">
      <p>Edits stay in this browser. Download the reviewed file to share them.</p>
      <label className="block space-y-1">
        <span>Speaker</span>
        <select aria-label="Speaker to name" value={selectedId} onChange={(event) => { setSpeakerId(event.target.value); setSpeakerName(""); }} className="min-h-11 w-full rounded border border-slate-300 bg-white p-2">
          {speakers.map(({ speaker_id: id, speaker_name: name }) => <option key={id} value={id}>{name || friendlySpeakerName(id)}</option>)}
        </select>
      </label>
      <form className="space-y-2" onSubmit={(event) => {
        event.preventDefault();
        const trimmedName = speakerName.trim();
        if (!trimmedName) return;
        onRenameSpeaker(selectedId, trimmedName);
        setSpeakerName("");
      }}>
        <label className="block space-y-1">
          <span>Name</span>
          <input aria-label="Speaker name" required maxLength={80} value={speakerName} onChange={(event) => setSpeakerName(event.target.value)} className="min-h-11 w-full rounded border border-slate-300 p-2" />
        </label>
        <button className="min-h-11 rounded border border-slate-300 px-3 py-2" type="submit">Apply name</button>
      </form>
      <div aria-label="Selected speaker passages" className="space-y-1">
        <p className="font-medium text-slate-600">Sample passages</p>
        {!passages.length && <p>No passages for this speaker.</p>}
        {passages.map((utterance) => <div key={utterance.id} className="flex items-start gap-2 rounded border border-slate-200 p-2">
          {onSeek && validMediaSeconds(utterance.timestamp_start) && <button type="button" className="min-h-11 shrink-0 rounded px-2 text-amber-800 underline" onClick={() => onSeek(utterance.timestamp_start)}>Go to sample · {mediaOffsetLabel(utterance.timestamp_start)}</button>}
          <span className="min-w-0 py-3 text-slate-700">{utterance.text}</span>
        </div>)}
      </div>
      <button type="button" className="min-h-11 rounded border border-slate-300 px-3 py-2" onClick={exportReviewedBundle}>Download reviewed .threads</button>
      {selectedSpeaker?.speaker_name && <span className="sr-only">Current name: {selectedSpeaker.speaker_name}</span>}
    </div>
  </details>;
}

SourceSpeakerEditor.propTypes = {
  bundle: PropTypes.object.isRequired,
  onRenameSpeaker: PropTypes.func.isRequired,
  onSeek: PropTypes.func,
};
