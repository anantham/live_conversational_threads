import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import ImportCanvas from "../components/ImportCanvas";

const API_URL = import.meta.env.VITE_API_URL || "";

export default function Browse() {
  const [conversations, setConversations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const navigate = useNavigate();
  const handleView = (conversationId) => {
    navigate(`/conversation/${conversationId}`);
    };

  const handleDelete = async (conversationId, conversationName) => {
    setDeleting(conversationId);
    try {
      const response = await fetch(`${API_URL}/conversations/${conversationId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.detail || 'Failed to delete conversation');
      }

      // Remove from local state
      setConversations(prev => prev.filter(c => c.file_id !== conversationId));
      setDeleteConfirm(null);
      console.log(`[INFO] Successfully deleted conversation: ${conversationName}`);
    } catch (err) {
      console.error('Error deleting conversation:', err);
      alert(`Failed to delete: ${err.message}`);
    } finally {
      setDeleting(null);
    }
  };

  useEffect(() => {
    const fetchConversations = async () => {
      try {
        const response = await fetch(`${API_URL}/conversations/`);

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(errorData.detail || `HTTP ${response.status}`);
        }

        const data = await response.json();

        data.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)); //sort based on time

        setConversations(data);
      } catch (err) {
        console.error("Error fetching conversations:", err.message);
        setError("Failed to load saved conversations.");
      } finally {
        setLoading(false);
      }
    };

    fetchConversations();
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-gradient-to-br from-blue-500 to-purple-600 text-white">
      {/* Header */}
      <div className="w-full px-4 py-6 bg-transparent flex items-center justify-between">
        {/* Back Button */}
        <button
          onClick={() => navigate("/")}
          className="px-4 py-2 bg-white text-blue-600 font-semibold rounded-lg shadow hover:bg-blue-100 transition text-sm md:text-base"
        >
          ⬅ Back
        </button>

        {/* Title */}
        <h1 className="text-xl md:text-3xl font-bold text-center flex-grow">
          Saved Conversations
        </h1>

        {/* Import Canvas Button */}
        <div className="hidden md:block">
          <ImportCanvas />
        </div>
      </div>
      {/* <h2 className="text-3xl font-bold mb-6 text-center">Saved Conversations</h2> */}

      {loading ? (
        <p className="text-center text-gray-600">Loading conversations...</p>
      ) : error ? (
        <p className="text-center text-red-600">{error}</p>
      ) : conversations.length === 0 ? (
        <p className="text-center text-gray-500">No saved conversations found.</p>
      ) : (
        <div className="space-y-4 max-h-[80vh] overflow-y-auto">
          {conversations.map((conv) => (
            <div
              key={conv.file_id}
              className="bg-white rounded-xl shadow p-4 hover:shadow-md transition"
            >
              <h3 className="text-xl text-black font-semibold">{conv.file_name}</h3>
              <p className="text-sm text-gray-500">ID: {conv.file_id}</p>
              <p className="text-sm text-gray-500">Number of Nodes: {conv.no_of_nodes}</p>
              <p className="text-sm text-green-600">{conv.message}</p>
              <p className="text-sm text-gray-400">  Created at: {new Date(conv.created_at).toLocaleString()} </p>

              <div className="flex gap-2 mt-4">
                <button
                  className="flex-1 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition"
                  onClick={() => handleView(conv.file_id)}
                >
                  View
                </button>
                <button
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => setDeleteConfirm({ id: conv.file_id, name: conv.file_name })}
                  disabled={deleting === conv.file_id}
                  title="Delete conversation"
                >
                  {deleting === conv.file_id ? '⏳' : '🗑️'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-2xl p-6 max-w-md mx-4">
            <h3 className="text-xl font-bold text-gray-900 mb-4">
              Delete Conversation?
            </h3>
            <p className="text-gray-700 mb-6">
              Are you sure you want to delete <strong>"{deleteConfirm.name}"</strong>?
              <br />
              <span className="text-sm text-red-600">This action cannot be undone.</span>
            </p>
            <div className="flex gap-3">
              <button
                className="flex-1 px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-800 rounded-lg transition"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="flex-1 px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-lg transition"
                onClick={() => handleDelete(deleteConfirm.id, deleteConfirm.name)}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}