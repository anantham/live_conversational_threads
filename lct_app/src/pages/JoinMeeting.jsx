import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Video, ArrowLeft } from "lucide-react";
import { apiFetch } from "../services/apiClient";

/**
 * Paste a Google Meet link -> a self-hosted Attendee bot joins the call and the
 * live conversation graph builds in real time on /meeting/:conversationId.
 */
export default function JoinMeeting() {
  const navigate = useNavigate();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const join = async (e) => {
    e.preventDefault();
    const meetingUrl = url.trim();
    if (!meetingUrl) return;
    setBusy(true);
    setError("");
    try {
      const resp = await apiFetch("/api/attendee/meetings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meeting_url: meetingUrl }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        setError(data.detail || `Request failed (${resp.status})`);
        return;
      }
      navigate(`/meeting/${data.conversation_id}`);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex h-[100dvh] w-screen flex-col items-center justify-center bg-[linear-gradient(180deg,#fdfdfb_0%,#f4f2ee_100%)] px-6">
      <button
        onClick={() => navigate("/")}
        className="absolute left-6 top-6 rounded-full p-2 text-slate-500 hover:bg-slate-100"
        title="Home"
      >
        <ArrowLeft size={18} />
      </button>

      <div className="w-full max-w-md">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-800 text-white">
            <Video size={22} />
          </span>
          <h1 className="text-2xl font-semibold tracking-tight text-slate-800">Join a meeting</h1>
          <p className="text-sm text-slate-500">
            Paste a Google Meet link. A bot joins the call and builds the live conversation
            graph in real time.
          </p>
        </div>

        <form onSubmit={join} className="flex flex-col gap-3">
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://meet.google.com/abc-defg-hij"
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-sm shadow-sm outline-none focus:border-slate-500"
            autoFocus
          />
          <button
            type="submit"
            disabled={busy || !url.trim()}
            className="rounded-xl bg-gray-800 px-4 py-3 text-sm font-medium text-white transition hover:bg-gray-700 disabled:opacity-50"
          >
            {busy ? "Sending bot…" : "Join meeting"}
          </button>
        </form>

        {error && (
          <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        )}
        <p className="mt-4 text-center text-[11px] text-slate-400">
          The bot appears as a participant. Admit it if your meeting has a waiting room.
        </p>
      </div>
    </div>
  );
}
