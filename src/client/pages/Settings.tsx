import { useState, useEffect } from "react";
import { api, Agent } from "../lib/api";

interface SettingsProps {
  onBack: () => void;
}

export default function Settings({ onBack }: SettingsProps) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // New agent form
  const [showAdd, setShowAdd] = useState(false);
  const [newAgentId, setNewAgentId] = useState("");
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAgentId, setEditAgentId] = useState("");
  const [editName, setEditName] = useState("");
  const [editDesc, setEditDesc] = useState("");

  // Delete confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    loadAgents();
  }, []);

  const loadAgents = async () => {
    try {
      const data = await api.getAgents();
      setAgents(data);
    } catch (e) {
      console.error("Failed to load agents:", e);
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async () => {
    if (!newAgentId.trim() || !newName.trim()) return;
    setSaving(true);
    try {
      const agent = await api.addAgent(newAgentId.trim(), newName.trim(), newDesc.trim());
      setAgents((prev) => [...prev, agent]);
      setNewAgentId("");
      setNewName("");
      setNewDesc("");
      setShowAdd(false);
    } catch (e) {
      console.error("Failed to add agent:", e);
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (agent: Agent) => {
    setEditingId(agent._id);
    setEditAgentId(agent.id);
    setEditName(agent.name);
    setEditDesc(agent.description);
  };

  const handleSaveEdit = async () => {
    if (!editingId || !editAgentId.trim() || !editName.trim()) return;
    setSaving(true);
    try {
      const updated = await api.updateAgent(editingId, {
        agent_id: editAgentId.trim(),
        name: editName.trim(),
        description: editDesc.trim(),
      });
      setAgents((prev) => prev.map((a) => (a._id === editingId ? updated : a)));
      setEditingId(null);
    } catch (e) {
      console.error("Failed to update agent:", e);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (dbId: string) => {
    setSaving(true);
    try {
      await api.deleteAgent(dbId);
      setAgents((prev) => prev.filter((a) => a._id !== dbId));
      setConfirmDeleteId(null);
    } catch (e) {
      console.error("Failed to delete agent:", e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] bg-white dark:bg-gray-900">
      {/* Header */}
      <div className="h-12 flex items-center px-4 border-b border-gray-200 dark:border-gray-800 gap-3 flex-shrink-0">
        <button
          onClick={onBack}
          className="p-1.5 hover:bg-gray-100 dark:hover:bg-gray-800 rounded-md text-gray-600 dark:text-gray-300"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h1 className="font-semibold text-gray-900 dark:text-white">Settings</h1>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-2xl mx-auto p-4 sm:p-6">
          <div className="mb-6">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">AI Agents</h2>
                <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
                  Configure the You.com agents available in your chats.
                </p>
              </div>
              {!showAdd && (
                <button
                  onClick={() => setShowAdd(true)}
                  className="px-3 py-1.5 text-sm bg-gray-900 dark:bg-gray-700 text-white rounded-md hover:bg-gray-800 dark:hover:bg-gray-600 flex items-center gap-1.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                  </svg>
                  Add Agent
                </button>
              )}
            </div>

            {/* Add Agent Form */}
            {showAdd && (
              <div className="mb-4 p-4 border border-gray-200 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-800/50">
                <h3 className="text-sm font-medium text-gray-900 dark:text-white mb-3">New Agent</h3>
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Agent ID <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={newAgentId}
                      onChange={(e) => setNewAgentId(e.target.value)}
                      placeholder='e.g. "express" or a UUID'
                      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Display Name <span className="text-red-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. My Agent"
                      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
                      Description
                    </label>
                    <input
                      type="text"
                      value={newDesc}
                      onChange={(e) => setNewDesc(e.target.value)}
                      placeholder="e.g. Fast web search"
                      className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
                    />
                  </div>
                  <div className="flex gap-2 pt-1">
                    <button
                      onClick={handleAdd}
                      disabled={!newAgentId.trim() || !newName.trim() || saving}
                      className="px-3 py-1.5 text-sm bg-gray-900 dark:bg-gray-600 text-white rounded-md hover:bg-gray-800 dark:hover:bg-gray-500 disabled:opacity-50"
                    >
                      {saving ? "Adding..." : "Add"}
                    </button>
                    <button
                      onClick={() => { setShowAdd(false); setNewAgentId(""); setNewName(""); setNewDesc(""); }}
                      className="px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Agent List */}
            {loading ? (
              <div className="flex items-center justify-center py-12">
                <div className="animate-spin rounded-full h-6 w-6 border-2 border-gray-300 dark:border-gray-600 border-t-gray-900 dark:border-t-white" />
              </div>
            ) : agents.length === 0 ? (
              <div className="text-center py-12 text-gray-500 dark:text-gray-400">
                <p className="mb-2">No agents configured yet.</p>
                <p className="text-sm">Add your first agent to get started.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {agents.map((agent) => (
                  <div
                    key={agent._id}
                    className="p-3 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800/50"
                  >
                    {editingId === agent._id ? (
                      /* Edit mode */
                      <div className="space-y-3">
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <div>
                            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Agent ID</label>
                            <input
                              type="text"
                              value={editAgentId}
                              onChange={(e) => setEditAgentId(e.target.value)}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
                            />
                          </div>
                          <div>
                            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Display Name</label>
                            <input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
                            />
                          </div>
                        </div>
                        <div>
                          <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Description</label>
                          <input
                            type="text"
                            value={editDesc}
                            onChange={(e) => setEditDesc(e.target.value)}
                            className="w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-gray-400"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleSaveEdit}
                            disabled={!editAgentId.trim() || !editName.trim() || saving}
                            className="px-3 py-1 text-sm bg-gray-900 dark:bg-gray-600 text-white rounded hover:bg-gray-800 dark:hover:bg-gray-500 disabled:opacity-50"
                          >
                            Save
                          </button>
                          <button
                            onClick={() => setEditingId(null)}
                            className="px-3 py-1 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    ) : (
                      /* Display mode */
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-sm text-gray-900 dark:text-white">{agent.name}</span>
                            {agent.description && (
                              <span className="text-xs text-gray-500 dark:text-gray-400">— {agent.description}</span>
                            )}
                          </div>
                          <p className="text-xs text-gray-400 dark:text-gray-500 font-mono mt-0.5 truncate">{agent.id}</p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => startEdit(agent)}
                            className="p-1.5 text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                            title="Edit"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                            </svg>
                          </button>
                          {confirmDeleteId === agent._id ? (
                            <div className="flex items-center gap-1">
                              <button
                                onClick={() => handleDelete(agent._id)}
                                disabled={saving}
                                className="px-2 py-0.5 text-xs bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-50"
                              >
                                Delete
                              </button>
                              <button
                                onClick={() => setConfirmDeleteId(null)}
                                className="px-2 py-0.5 text-xs text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              onClick={() => setConfirmDeleteId(agent._id)}
                              className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                              title="Delete"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
