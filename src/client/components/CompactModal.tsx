import { useMemo, useState, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { Agent, Message } from "../lib/api";

export const DEFAULT_COMPACT_PROMPT =
  "Rewrite the message below to be more concise and clearer while preserving its meaning and tone. Return only the revised message.";

interface CompactModalProps {
  isOpen: boolean;
  sourceMessage: Message | null;
  sessionAgent: string;
  agents: Agent[];
  isBusy: boolean;
  onClose: () => void;
  onGenerate: (payload: {
    messageId: string;
    prompt: string;
    agentOrModel: string;
    onDelta?: (content: string) => void;
  }) => Promise<string>;
  onCommit: (content: string) => Promise<void>;
  onStop?: () => void;
}

function ComparisonPanel({
  title,
  content,
  loading,
  isEmpty,
  markdownClass,
}: {
  title: string;
  content: string;
  loading: boolean;
  isEmpty: boolean;
  markdownClass: string;
}) {
  return (
    <section className="border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100">
      <div className="px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-xs font-semibold text-gray-700 dark:text-gray-200">{title}</div>
      <div className="p-3 h-[180px] overflow-y-auto bg-gray-50/60 dark:bg-gray-900/40">
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
            <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M12 2a10 10 0 018 4.5A10 10 0 0112 22v-2a8 8 0 000-16v2A6 6 0 0118 12a6 6 0 01-6 6 0 01-6-6 6 6 0 013.12-5.1V7h-2v3h3V8.8A8 8 0 0012 20a8 8 0 008-8z" />
            </svg>
            Streaming...
          </div>
        ) : isEmpty ? (
          <p className="text-xs text-gray-600 dark:text-gray-300">No result yet.</p>
        ) : (
          <div className={`markdown-content text-sm text-gray-900 dark:text-gray-100 ${markdownClass}`}>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
      </div>
    </section>
  );
}

export default function CompactModal({
  isOpen,
  sourceMessage,
  sessionAgent,
  agents,
  isBusy,
  onClose,
  onGenerate,
  onCommit,
  onStop,
}: CompactModalProps) {
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_COMPACT_PROMPT);
  const [selectedAgent, setSelectedAgent] = useState(sessionAgent);
  const [generatedContent, setGeneratedContent] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isOpen) {
      setPromptTemplate(DEFAULT_COMPACT_PROMPT);
      setSelectedAgent(sessionAgent);
      setGeneratedContent("");
      setError("");
      setIsGenerating(false);
    }
  }, [isOpen, sessionAgent]);

  const hasResult = generatedContent.trim().length > 0;
  const isGeneratingAny = isBusy || isGenerating;

  const modelOptions = useMemo(
    () => ({
      models: agents.filter((agent) => agent.type === "model"),
      customAgents: agents.filter((agent) => agent.type === "agent"),
    }),
    [agents],
  );

  const runCompact = async () => {
    if (!sourceMessage || !sourceMessage.id) return;

    setError("");
    setIsGenerating(true);
    setGeneratedContent("");
    try {
      const finalContent = await onGenerate({
        messageId: sourceMessage.id,
        prompt: promptTemplate,
        agentOrModel: selectedAgent,
        onDelta: setGeneratedContent,
      });
      setGeneratedContent(finalContent);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate compact message");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleClose = () => {
    if (isGeneratingAny) {
      onStop?.();
    }
    onClose();
  };

  const handleCommit = async () => {
    await onCommit(generatedContent);
    onClose();
  };

  if (!isOpen || !sourceMessage) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/45 dark:bg-black/65 flex items-start justify-center p-2 sm:p-4 overflow-y-auto">
      <div className="w-full max-w-5xl rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 shadow-xl">
        <div className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 px-4 py-3 flex items-start justify-between gap-2">
          <h2 className="text-sm sm:text-base font-semibold text-gray-900 dark:text-white">Compact Message</h2>
          <button
            onClick={handleClose}
            className="px-2 py-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-300"
            title="Close"
          >
            ✕
          </button>
        </div>

        <div className="p-4 space-y-4 max-h-[calc(100vh-4rem)] overflow-y-auto">
          <div className="grid gap-4 md:grid-cols-2">
            <section>
              <label className="text-xs font-semibold text-gray-600 dark:text-gray-300 block mb-1">Editable compact prompt</label>
              <textarea
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
                rows={4}
                className="w-full p-2 rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-white"
                disabled={isGeneratingAny}
              />
              <label className="text-xs font-semibold text-gray-600 dark:text-gray-300 mt-3 block">Agent / model</label>
              <select
                value={selectedAgent}
                onChange={(e) => setSelectedAgent(e.target.value)}
                disabled={isGeneratingAny}
                className="mt-1 w-full px-2 py-1.5 text-sm border border-gray-300 dark:border-gray-700 rounded-md bg-white dark:bg-gray-800 text-gray-900 dark:text-white"
              >
                {modelOptions.customAgents.length > 0 && (
                  <optgroup label="Custom Agents">
                    {modelOptions.customAgents.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {modelOptions.models.length > 0 && (
                  <optgroup label="Models">
                    {modelOptions.models.map((agent) => (
                      <option key={agent.id} value={agent.id}>
                        {agent.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {agents.length === 0 && <option value={selectedAgent}>{selectedAgent}</option>}
              </select>
            </section>

            <section>
              <label className="text-xs font-semibold text-gray-700 dark:text-gray-200 block mb-1">Original message (read-only)</label>
              <div className="rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 p-2 h-[186px] overflow-y-auto">
                <div className="text-sm markdown-content text-gray-900 dark:text-gray-100">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{sourceMessage.content}</ReactMarkdown>
                </div>
              </div>
            </section>
          </div>

          <section>
            <label className="text-xs font-semibold text-gray-600 dark:text-gray-300 block mb-2">Before / After</label>
            <div className="grid gap-3 md:grid-cols-2">
              <ComparisonPanel
                title="Before"
                content={sourceMessage.content}
                loading={false}
                isEmpty={false}
                markdownClass=""
              />
              <ComparisonPanel
                title="After"
                content={generatedContent}
                loading={isGeneratingAny && !hasResult}
                isEmpty={!hasResult}
                markdownClass=""
              />
            </div>
            {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
          </section>

          <div className="flex flex-wrap items-center gap-2 justify-end">
            <button
              onClick={runCompact}
              disabled={isGeneratingAny}
              className="inline-flex items-center px-3 py-1.5 rounded-md text-sm bg-gray-900 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Generate Compact
            </button>
            <button
              onClick={runCompact}
              disabled={isGeneratingAny}
              className="inline-flex items-center px-3 py-1.5 rounded-md text-sm bg-gray-700 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Regenerate
            </button>
            <button
              onClick={handleCommit}
              disabled={!hasResult || isGeneratingAny}
              className="inline-flex items-center px-3 py-1.5 rounded-md text-sm bg-emerald-600 text-white disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Commit Replace
            </button>
            <button
              onClick={handleClose}
              className="inline-flex items-center px-3 py-1.5 rounded-md text-sm border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
