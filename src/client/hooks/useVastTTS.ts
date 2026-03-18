import { useState, useCallback, useRef, useEffect } from "react";
import { api } from "../lib/api";

export interface TTSOptions {
  voice?: string;
  speed?: number;
  language?: string;
}

export interface TTSInstance {
  id: string;
  ip: string | null;
  port: number;
  gpuName?: string;
  hourlyRate?: number;
  status: string;
  createdAt: string;
  lastActivity: string;
}

export interface TTSStatus {
  active: boolean;
  status: string;
  instance?: TTSInstance;
  healthy?: boolean;
}

export interface SpeakResult {
  success: boolean;
  audio?: string; // base64
  duration?: number;
  sampleRate?: number;
  error?: string;
  instance?: {
    id: string;
    gpu?: string;
    hourlyRate?: number;
  };
}

export function useVastTTS() {
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<TTSStatus | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Check status on mount
  useEffect(() => {
    checkStatus();
    
    // Poll status every 30 seconds
    const interval = setInterval(checkStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  /**
   * Check TTS service status
   */
  const checkStatus = useCallback(async () => {
    try {
      const response = await api.get("/tts/status");
      setStatus(response);
      return response;
    } catch (err) {
      console.error("Failed to check TTS status:", err);
      setStatus({ active: false, status: "error" });
      return null;
    }
  }, []);

  /**
   * Start Vast.ai TTS instance
   */
  const startInstance = useCallback(async () => {
    setIsStarting(true);
    setError(null);

    try {
      const response = await api.post("/tts/start", {});
      
      if (response.success) {
        setStatus({
          active: true,
          status: "running",
          instance: response.instance,
          healthy: true,
        });
        return response.instance;
      } else {
        throw new Error(response.error || "Failed to start instance");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start TTS instance";
      setError(message);
      throw err;
    } finally {
      setIsStarting(false);
    }
  }, []);

  /**
   * Stop Vast.ai TTS instance
   */
  const stopInstance = useCallback(async () => {
    try {
      await api.post("/tts/stop", {});
      setStatus({ active: false, status: "stopped" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to stop instance";
      setError(message);
      throw err;
    }
  }, []);

  /**
   * Generate speech using Vast.ai
   */
  const speak = useCallback(async (
    text: string,
    options: TTSOptions = {}
  ): Promise<SpeakResult> => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await api.post("/tts/speak", {
        text,
        voice: options.voice,
        speed: options.speed,
        language: options.language,
      });

      if (response.success && response.audio) {
        return {
          success: true,
          audio: response.audio,
          duration: response.duration,
          sampleRate: response.sampleRate,
          instance: response.instance,
        };
      }

      throw new Error(response.error || "Speech generation failed");
    } catch (err) {
      const message = err instanceof Error ? err.message : "TTS failed";
      setError(message);
      return {
        success: false,
        error: message,
      };
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Play audio from base64 string
   */
  const playAudio = useCallback((base64Audio: string, mimeType: string = "audio/wav"): Promise<void> => {
    return new Promise((resolve, reject) => {
      // Stop any existing audio
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }

      const audio = new Audio(`data:${mimeType};base64,${base64Audio}`);
      audioRef.current = audio;

      audio.onended = () => {
        audioRef.current = null;
        resolve();
      };

      audio.onerror = (err) => {
        audioRef.current = null;
        reject(err);
      };

      audio.play().catch(reject);
    });
  }, []);

  /**
   * Stop current playback
   */
  const stopPlayback = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
  }, []);

  /**
   * Get available voices
   */
  const getVoices = useCallback(async (): Promise<string[]> => {
    try {
      const response = await api.get("/tts/voices");
      return response.voices || ["default"];
    } catch {
      return ["default"];
    }
  }, []);

  /**
   * Get GPU pricing options
   */
  const getPricing = useCallback(async () => {
    try {
      const response = await api.get("/tts/pricing");
      return response.pricing || [];
    } catch {
      return [];
    }
  }, []);

  return {
    // State
    isLoading,
    isStarting,
    error,
    status,
    isActive: status?.active ?? false,
    isHealthy: status?.healthy ?? false,

    // Actions
    speak,
    playAudio,
    startInstance,
    stopInstance,
    stopPlayback,
    checkStatus,
    getVoices,
    getPricing,
  };
}

export default useVastTTS;
