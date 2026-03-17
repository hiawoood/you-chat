import { useRef, useState, useCallback } from "react";

interface TTSPlayerProps {
  isPlaying: boolean;
  isLoading: boolean;
  isModelLoading: boolean;
  progress: number;
  currentTime: number;
  totalDuration: number;
  activeText: string | null;
  onPlay: () => void;
  onPause: () => void;
  onStop: () => void;
  onSeek: (time: number) => void;
}

function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function TTSPlayer({
  isPlaying,
  isLoading,
  isModelLoading,
  progress,
  currentTime,
  totalDuration,
  activeText,
  onPlay,
  onPause,
  onStop,
  onSeek,
}: TTSPlayerProps) {
  const progressBarRef = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  const handleProgressClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!progressBarRef.current || totalDuration <= 0) return;

    const rect = progressBarRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percentage = Math.max(0, Math.min(1, clickX / rect.width));
    const newTime = percentage * totalDuration;

    onSeek(newTime);
  }, [totalDuration, onSeek]);

  const handleMouseDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    setIsDragging(true);
    handleProgressClick(e);
  }, [handleProgressClick]);

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (!isDragging) return;
    handleProgressClick(e);
  }, [isDragging, handleProgressClick]);

  const handleMouseUp = useCallback(() => {
    setIsDragging(false);
  }, []);

  const progressPercentage = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  // Generate preview text (first 60 chars)
  const previewText = activeText
    ? activeText.slice(0, 60) + (activeText.length > 60 ? "..." : "")
    : "";

  return (
    <div className="fixed bottom-20 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-lg">
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-xl shadow-lg px-4 py-3">
        {/* Header with text preview */}
        <div className="mb-2 flex items-center gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">
              {previewText || "Reading message..."}
            </p>
          </div>
          <button
            onClick={onStop}
            className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors"
            title="Close (Esc)"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Model loading indicator */}
        {isModelLoading && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400 mb-1">
              <span>Loading TTS model...</span>
              <span>{progress}%</span>
            </div>
            <div className="h-1.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>
        )}

        {/* Loading indicator for audio generation */}
        {isLoading && !isModelLoading && (
          <div className="mb-3 flex items-center gap-2 text-xs text-blue-500 dark:text-blue-400">
            <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span>Generating audio...</span>
          </div>
        )}

        {/* Controls */}
        <div className="flex items-center gap-3">
          {/* Play/Pause button */}
          <button
            onClick={isPlaying ? onPause : onPlay}
            disabled={isLoading || isModelLoading}
            className="flex-shrink-0 w-10 h-10 flex items-center justify-center bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 dark:disabled:bg-gray-700 text-white rounded-full transition-colors"
          >
            {isPlaying ? (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg className="w-5 h-5 ml-0.5" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          {/* Progress bar */}
          <div className="flex-1 min-w-0">
            <div
              ref={progressBarRef}
              className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full cursor-pointer relative group"
              onClick={handleProgressClick}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={handleMouseUp}
            >
              {/* Progress fill */}
              <div
                className="absolute inset-y-0 left-0 bg-blue-500 rounded-full transition-all duration-100"
                style={{ width: `${progressPercentage}%` }}
              />

              {/* Hover/Drag handle */}
              <div
                className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-white border-2 border-blue-500 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
                style={{ left: `calc(${progressPercentage}% - 8px)` }}
              />
            </div>
          </div>

          {/* Time display */}
          <div className="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400 tabular-nums">
            {formatTime(currentTime)} / {formatTime(totalDuration)}
          </div>
        </div>

        {/* Wave animation when playing */}
        {isPlaying && (
          <div className="mt-2 flex items-center justify-center gap-0.5 h-4">
            {[...Array(5)].map((_, i) => (
              <div
                key={i}
                className="w-1 bg-blue-500 rounded-full animate-pulse"
                style={{
                  height: "100%",
                  animationDelay: `${i * 0.1}s`,
                  animationDuration: "0.6s",
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
