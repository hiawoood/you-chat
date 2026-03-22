import { useState, useCallback } from "react";
import { useVastTTS } from "../hooks/useVastTTS";

// Simple SVG icons (avoiding lucide-react dependency)
const VolumeXIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);

const PlayIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);

const SquareIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
);

const LoaderIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
    <line x1="12" y1="2" x2="12" y2="6" />
    <line x1="12" y1="18" x2="12" y2="22" />
    <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
    <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
    <line x1="2" y1="12" x2="6" y2="12" />
    <line x1="18" y1="12" x2="22" y2="12" />
    <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
    <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
  </svg>
);

const CpuIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="4" y="4" width="16" height="16" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M15 2v2" />
    <path d="M15 20v2" />
    <path d="M2 15h2" />
    <path d="M2 9h2" />
    <path d="M20 15h2" />
    <path d="M20 9h2" />
    <path d="M9 2v2" />
    <path d="M9 20v2" />
  </svg>
);

const ZapIcon = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
  </svg>
);

interface TTSPlayerProps {
  text: string;
  className?: string;
  showStatus?: boolean;
  autoPlay?: boolean;
  voice?: string;
  speed?: number;
}

export function TTSPlayer({
  text,
  className = "",
  showStatus = true,
  autoPlay = false,
  voice,
  speed = 1.0,
}: TTSPlayerProps) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [lastResult, setLastResult] = useState<{
    fallback?: boolean;
    gpu?: string;
  } | null>(null);

  const {
    speak,
    playAudio,
    startInstance,
    stopInstance,
    stopPlayback,
    isLoading,
    isStarting,
    isActive,
    isHealthy,
    status,
  } = useVastTTS();

  const handlePlay = useCallback(async () => {
    if (isPlaying) {
      stopPlayback();
      setIsPlaying(false);
      return;
    }

    setIsPlaying(true);

    try {
      const result = await speak(text, { voice, speed });

      if (result.success && result.audio) {
        setLastResult({
          fallback: result.fallback,
          gpu: result.instance?.gpu,
        });

        const mimeType = result.mimeType || "audio/mpeg";
        await playAudio(result.audio, mimeType);
      }
    } catch (err) {
      console.error("TTS playback failed:", err);
    } finally {
      setIsPlaying(false);
    }
  }, [isPlaying, text, voice, speed, speak, playAudio, stopPlayback]);

  const handleStartInstance = useCallback(async () => {
    try {
      await startInstance();
    } catch (err) {
      console.error("Failed to start TTS instance:", err);
    }
  }, [startInstance]);

  const handleStopInstance = useCallback(async () => {
    try {
      await stopInstance();
    } catch (err) {
      console.error("Failed to stop TTS instance:", err);
    }
  }, [stopInstance]);

  // Render status badge
  const renderStatus = () => {
    if (!showStatus) return null;

    if (isStarting) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-yellow-600 bg-yellow-50 rounded-full">
          <LoaderIcon />
          Starting GPU...
        </span>
      );
    }

    if (isLoading) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-blue-600 bg-blue-50 rounded-full">
          <LoaderIcon />
          Generating...
        </span>
      );
    }

    if (isActive && isHealthy) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-600 bg-green-50 rounded-full">
          <ZapIcon />
          {status?.instance?.gpuName || "GPU Ready"}
          {status?.instance?.hourlyRate && (
            <span className="text-green-500">${status.instance.hourlyRate}/hr</span>
          )}
        </span>
      );
    }

    if (isActive && !isHealthy) {
      return (
        <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-orange-600 bg-orange-50 rounded-full">
          <CpuIcon />
          Initializing...
        </span>
      );
    }

    return (
      <span className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-gray-500 bg-gray-100 rounded-full">
        <VolumeXIcon />
        TTS Standby
      </span>
    );
  };

  return (
    <div className={`inline-flex items-center gap-2 ${className}`}>
      {/* Play/Stop Button */}
      <button
        onClick={handlePlay}
        disabled={isLoading || isStarting}
        className={`
          inline-flex items-center justify-center w-8 h-8 rounded-full
          transition-colors duration-200
          ${isPlaying
            ? "bg-red-100 text-red-600 hover:bg-red-200"
            : "bg-blue-100 text-blue-600 hover:bg-blue-200"
          }
          disabled:opacity-50 disabled:cursor-not-allowed
        `}
        title={isPlaying ? "Stop" : "Play"}
      >
        {isLoading || isStarting ? (
          <LoaderIcon />
        ) : isPlaying ? (
          <SquareIcon />
        ) : (
          <PlayIcon />
        )}
      </button>

      {/* Instance Control */}
      {!isActive && !isStarting && (
        <button
          onClick={handleStartInstance}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-green-600 bg-green-50 hover:bg-green-100 rounded-full transition-colors"
          title="Start GPU instance"
        >
          <ZapIcon />
          Start GPU
        </button>
      )}

      {isActive && (
        <button
          onClick={handleStopInstance}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 rounded-full transition-colors"
          title="Stop GPU instance"
        >
          <SquareIcon />
          Stop
        </button>
      )}

      {/* Status Badge */}
      {renderStatus()}

      {/* Last Used Indicator */}
      {lastResult?.fallback && (
        <span className="text-xs text-gray-400">
          (fallback)
        </span>
      )}
    </div>
  );
}

export default TTSPlayer;
