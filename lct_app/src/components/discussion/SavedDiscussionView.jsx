import PropTypes from "prop-types";
import useTranscriptReview from "../transcript/useTranscriptReview";
import DiscussionView from "./DiscussionView";

export default function SavedDiscussionView({ conversationId, nodes, speakerColorMap }) {
  const { data, operation, elapsed, error, reload, stopWaiting } = useTranscriptReview(conversationId);
  return <div className="flex h-full min-h-0 flex-col pb-16">
    {operation && <div role="status" className="shrink-0 px-4 py-2 text-sm text-slate-600">
      {operation} · {elapsed}s elapsed · Time remaining unknown
      <button type="button" onClick={stopWaiting} className="ml-2 min-h-11 underline">Stop waiting</button>
    </div>}
    {error && <div role="alert" className="shrink-0 px-4 py-2 text-sm text-red-700">{error}
      <button type="button" onClick={() => void reload()} className="ml-2 min-h-11 underline">Retry transcript</button>
    </div>}
    <div className="min-h-0 flex-1"><DiscussionView nodes={nodes} utterances={data?.utterances} speakerColorMap={speakerColorMap}
      evidenceStatus={error ? "error" : data ? "ready" : "loading"} /></div>
  </div>;
}
SavedDiscussionView.propTypes = {
  conversationId: PropTypes.string.isRequired,
  nodes: PropTypes.arrayOf(PropTypes.object).isRequired,
  speakerColorMap: PropTypes.object,
};
