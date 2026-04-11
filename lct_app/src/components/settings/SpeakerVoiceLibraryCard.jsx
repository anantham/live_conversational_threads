import { useState, useEffect, useRef } from "react";

const API_BASE = "";

async function fetchSpeakerClips(speakerName = null) {
  const params = speakerName ? `?speaker_name=${encodeURIComponent(speakerName)}` : "";
  const res = await fetch(`${API_BASE}/api/speaker-voice-library${params}`);
  if (!res.ok) throw new Error("Failed to fetch clips");
  return res.json();
}

async function deleteSpeakerClip(clipId) {
  const res = await fetch(`${API_BASE}/api/speaker-voice-library/${clipId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete clip");
  return res.json();
}

function AudioPlayer({ base64, className = "" }) {
  const audioRef = useRef(null);
  const [audioUrl, setAudioUrl] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    if (!base64) return;
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const blob = new Blob([byteArray], { type: "audio/wav" });
    const url = URL.createObjectURL(blob);
    setAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [base64]);

  if (!audioUrl) return <span className="text-gray-400 text-xs">Loading...</span>;

  return (
    <audio
      ref={audioRef}
      src={audioUrl}
      controls
      className={`h-8 w-32 ${className}`}
      onPlay={() => setIsPlaying(true)}
      onEnded={() => setIsPlaying(false)}
    />
  );
}

export default function SpeakerVoiceLibraryCard() {
  const [clips, setClips] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filterSpeaker, setFilterSpeaker] = useState("");
  const [deleting, setDeleting] = useState(null);

  const loadClips = async () => {
    try {
      setLoading(true);
      const data = await fetchSpeakerClips(filterSpeaker || null);
      setClips(data);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadClips();
  }, [filterSpeaker]);

  const handleDelete = async (clipId) => {
    if (!confirm("Delete this audio clip?")) return;
    setDeleting(clipId);
    try {
      await deleteSpeakerClip(clipId);
      setClips((prev) => prev.filter((c) => c.id !== clipId));
    } catch (err) {
      alert("Failed to delete: " + err.message);
    } finally {
      setDeleting(null);
    }
  };

  const uniqueSpeakers = [...new Set(clips.map((c) => c.speaker_name))];

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold text-gray-800">Speaker Voice Library</h3>
          <p className="text-sm text-gray-600">
            Review and manage speaker audio clips for improved diarization. 
            Clips are used as reference audio when transcribing new sessions.
          </p>
        </div>
        <button
          onClick={loadClips}
          className="rounded px-3 py-1 text-sm text-blue-600 hover:bg-blue-50"
        >
          Refresh
        </button>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <label className="text-sm text-gray-600">Filter by speaker:</label>
        <select
          value={filterSpeaker}
          onChange={(e) => setFilterSpeaker(e.target.value)}
          className="rounded border border-gray-300 px-2 py-1 text-sm"
        >
          <option value="">All speakers</option>
          {uniqueSpeakers.map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      {loading && <p className="text-gray-500">Loading...</p>}
      {error && <p className="text-red-600">Error: {error}</p>}

      {!loading && !error && clips.length === 0 && (
        <p className="text-gray-500">No audio clips stored yet. Name speakers in conversations to build your library.</p>
      )}

      <div className="space-y-3">
        {clips.map((clip) => (
          <div
            key={clip.id}
            className="flex items-center justify-between rounded border border-gray-100 bg-gray-50 p-3"
          >
            <div className="flex items-center gap-4">
              <div>
                <p className="font-medium text-gray-800">{clip.speaker_name}</p>
                <p className="text-xs text-gray-500">
                  {clip.duration_seconds?.toFixed(1)}s • {clip.sample_rate_hz}Hz •{" "}
                  {clip.created_at ? new Date(clip.created_at).toLocaleDateString() : "Unknown date"}
                </p>
              </div>
              <AudioPlayer base64={clip.audio_base64} />
            </div>
            <button
              onClick={() => handleDelete(clip.id)}
              disabled={deleting === clip.id}
              className="rounded px-2 py-1 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50"
            >
              {deleting === clip.id ? "Deleting..." : "Delete"}
            </button>
          </div>
        ))}
      </div>

      {clips.length > 0 && (
        <p className="mt-4 text-xs text-gray-500">
          Total: {clips.length} clip(s). Only speakers present in the current conversation 
          will use these references during transcription.
        </p>
      )}
    </div>
  );
}