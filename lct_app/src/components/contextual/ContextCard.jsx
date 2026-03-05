import PropTypes from "prop-types";
import { extractContextualRelationEntries } from "./contextualGraphUtils";

export default function ContextCard({
  selectedNodeData,
  showTranscript,
  onBookmark,
  onToggleTranscript,
}) {
  return (
    <div className="p-4 border rounded-lg bg-yellow-100 shadow-md mb-2 z-20 max-h-[200px] overflow-y-auto">
      <div className="mt-4 flex flex-wrap justify-center gap-2">
        <button
          className={`px-4 py-2 rounded-lg shadow-md transition-all ${
            selectedNodeData?.is_bookmark
              ? "bg-yellow-400 hover:bg-yellow-500 text-gray-800"
              : "bg-gray-200 hover:bg-gray-300 text-gray-600"
          }`}
          onClick={onBookmark}
          title={selectedNodeData?.is_bookmark ? "Remove Bookmark" : "Add Bookmark"}
        >
          {selectedNodeData?.is_bookmark ? "★ Bookmarked" : "☆ Bookmark"}
        </button>

        <button
          className="px-4 py-2 rounded-lg shadow-md bg-purple-300 hover:bg-purple-400"
          onClick={onToggleTranscript}
        >
          {showTranscript ? "Hide transcript" : "View transcript"}
        </button>
      </div>

      <h3 className="font-semibold text-black">
        {selectedNodeData?.is_utterance_node ? "Utterance" : "Context for"}:{" "}
        {selectedNodeData?.node_name}
      </h3>

      {selectedNodeData?.full_text ? (
        <div className="text-sm text-black">
          <strong>Speaker:</strong> {selectedNodeData?.speaker_id}
          <br />
          <strong>Text:</strong>
          <p className="mt-2 whitespace-pre-wrap leading-relaxed">{selectedNodeData?.full_text}</p>
        </div>
      ) : (
        <p className="text-sm text-black">
          <strong>Summary:</strong> {selectedNodeData?.summary || "No summary available"}
        </p>
      )}

      {extractContextualRelationEntries(selectedNodeData?.contextual_relation).length > 0 && (
        <>
          <h4 className="font-semibold mt-2 text-black">Context drawn from:</h4>
          <ul className="list-disc pl-4">
            {extractContextualRelationEntries(selectedNodeData?.contextual_relation).map(
              ([key, value]) => (
                <li key={key} className="text-sm text-black">
                  <strong>{key}:</strong> {value}
                </li>
              )
            )}
          </ul>
        </>
      )}

      {Array.isArray(selectedNodeData?.edge_relations) &&
        selectedNodeData.edge_relations.length > 0 && (
          <>
            <h4 className="font-semibold mt-2 text-black">Edge relations:</h4>
            <ul className="list-disc pl-4">
              {selectedNodeData.edge_relations.map((relation, index) => (
                <li
                  key={`${relation.related_node}-${relation.relation_type}-${index}`}
                  className="text-sm text-black"
                >
                  <strong>{relation.relation_type || "contextual"}</strong> from{" "}
                  <strong>{relation.related_node || "unknown"}</strong>:{" "}
                  {relation.relation_text || "No description"}
                </li>
              ))}
            </ul>
          </>
        )}
    </div>
  );
}

ContextCard.propTypes = {
  selectedNodeData: PropTypes.object,
  showTranscript: PropTypes.bool.isRequired,
  onBookmark: PropTypes.func.isRequired,
  onToggleTranscript: PropTypes.func.isRequired,
};
