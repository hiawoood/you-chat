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
  fallback?: boolean;
  error?: string;
  instance?: {
    id: string;
    gpu?: string;
    hourlyRate?: number;
  };
}

// Kokoro TTS fallback (local/offline)
const KOKORO_API_URL = import.meta.env.VITE_KOKORO_URL || "http://localhost:8880";

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
   * Generate speech using Vast.ai (with Kokoro fallback)
   */
  const speak = useCallback(async (
    text: string,
    options: TTSOptions = {}
  ): Promise<SpeakResult> => {
    setIsLoading(true);
    setError(null);

    try {
      // Try Vast.ai first
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

      // If Vast.ai fails but suggests fallback
      if (response.fallback) {
        console.log("[TTS] Vast.ai unavailable, falling back to Kokoro...");
        return await speakWithKokoro(text, options);
      }

      throw new Error(response.error || "Speech generation failed");
    } catch (err) {
      console.log("[TTS] Vast.ai failed, trying Kokoro fallback...");
      
      // Fallback to Kokoro
      try {
        return await speakWithKokoro(text, options);
      } catch (kokoroErr) {
        const message = kokoroErr instanceof Error ? kokoroErr.message : "All TTS services failed";
        setError(message);
        return {
          success: false,
          fallback: true,
          error: message,
        };
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Generate speech using local Kokoro TTS
   */
  const speakWithKokoro = async (
    text: string,
    options: TTSOptions = {}
  ): Promise<SpeakResult> => {
    try {
      const response = await fetch(`${KOKORO_API_URL}/v1/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "kokoro",
          input: text,
          voice: options.voice || "af_bella",
          speed: options.speed || 1.0,
          response_format: "mp3",
        }),
      });

      if (!response.ok) {
        throw new Error(`Kokoro TTS failed: ${response.statusText}`);
      }

      // Convert blob to base64
      const blob = await response.blob();
      const reader = new FileReader();
      
      const base64Audio = await new Promise<string | undefined>((resolve, reject) => {
        reader.onloadend = () => {
          const base64 = reader.result as string;
          // Remove data URL prefix
          resolve(base64?.split(",")[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      if (!base64Audio) {
        throw new Error("Failed to convert audio to base64");
      }

      return {
        success: true,
        audio: base64Audio,
        fallback: true,
      };
    } catch (err) {
      throw err;
    }
  };

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
      // Fallback to Kokoro voices
      return [
        "af_bella", "af_heart", "af_alloy", "af_aoede", "af_jessica",
        "af_kore", "af_nicole", "af_nova", "af_river", "af_sarah",
        "af_sky", "am_adam", "am_echo", "am_eric", "am_fenrir",
        "am_liam", "am_michael", "am_onyx", "am_puck", "am_santa",
      ];
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

    // Direct fallback access
    speakWithKokoro,
  };
}

export default useVastTTS;
