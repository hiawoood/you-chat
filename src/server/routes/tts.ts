// TTS API Routes - Manages Vast.ai instances for text-to-speech
import { Hono } from "hono";
import type { AppEnv } from "../context";
import {
  getActiveInstance,
  healthCheck,
  startCheapestInstance,
  stopInstance as stopActiveInstance,
  generateSpeech,
  searchBestGPU,
} from "../services/vastai";

const tts = new Hono<AppEnv>();

// Simple voice list - Chatterbox Turbo has built-in voices
async function getVoices(): Promise<string[]> {
  return ["default"];
}

/**
 * POST /api/tts/speak
 * Generate speech from text
 * Body: { text: string, voice?: string, speed?: number, language?: string }
 */
tts.post("/speak", async (c) => {
  try {
    const body = await c.req.json();
    const { text, voice, speed, language } = body;

    if (!text || typeof text !== "string") {
      return c.json({ error: "Text is required" }, 400);
    }

    // Check if we have an active instance
    let instance = getActiveInstance();
    
    // Auto-start if no instance
    if (!instance || instance.status !== "running") {
      console.log("[TTS] No active instance, starting one...");
      try {
        instance = await startCheapestInstance();
      } catch (error) {
        console.error("[TTS] Failed to start instance:", error);
        return c.json(
          { 
            error: "Failed to start TTS instance",
            message: error instanceof Error ? error.message : "Unknown error"
          }, 
          503
        );
      }
    }

    // Generate speech
    try {
      const result = await generateSpeech({
        text,
        voice,
        speed,
        language,
      });

      return c.json({
        success: true,
        audio: result.audio,
        duration: result.duration,
        sampleRate: result.sampleRate,
        instance: {
          id: instance.id,
          gpu: instance.gpuName,
          hourlyRate: instance.hourlyRate,
        },
      });
    } catch (error) {
      console.error("[TTS] Speech generation failed:", error);
      
      // Check if instance is still healthy
      const isHealthy = await healthCheck();
      
      return c.json(
        {
          error: "Speech generation failed",
          instanceHealthy: isHealthy,
          message: error instanceof Error ? error.message : "Unknown error",
        },
        503
      );
    }
  } catch (error) {
    console.error("[TTS] Unexpected error:", error);
    return c.json(
      { 
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error"
      }, 
      500
    );
  }
});

/**
 * POST /api/tts/start
 * Start a new Vast.ai instance (or adopt existing one)
 */
tts.post("/start", async (c) => {
  try {
    // Start/reuse instance - startCheapestInstance handles adoption of existing healthy instances
    const instance = await startCheapestInstance();

    return c.json({
      success: true,
      instance: {
        id: instance.id,
        ip: instance.ip,
        port: instance.port,
        status: instance.status,
        gpuName: instance.gpuName,
        hourlyRate: instance.hourlyRate,
        createdAt: instance.createdAt,
      },
      message: instance.lastActivity > new Date(Date.now() - 60000) 
        ? "Using existing healthy instance" 
        : "New instance started",
    });
  } catch (error) {
    console.error("[TTS] Failed to start instance:", error);
    return c.json(
      {
        error: "Failed to start TTS instance",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * POST /api/tts/stop
 * Stop the active Vast.ai instance
 */
tts.post("/stop", async (c) => {
  try {
    const instance = getActiveInstance();
    
    if (!instance) {
      return c.json({
        success: true,
        message: "No active instance to stop",
      });
    }

    await stopActiveInstance();

    return c.json({
      success: true,
      message: "Instance stopped successfully",
    });
  } catch (error) {
    console.error("[TTS] Failed to stop instance:", error);
    return c.json(
      {
        error: "Failed to stop instance",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /api/tts/status
 * Check TTS service status
 */
tts.get("/status", async (c) => {
  try {
    const instance = getActiveInstance();
    
    if (!instance) {
      return c.json({
        active: false,
        status: "stopped",
      });
    }

    const isHealthy = await healthCheck();

    return c.json({
      active: instance.status === "running" && isHealthy,
      status: instance.status,
      instance: {
        id: instance.id,
        ip: instance.ip,
        port: instance.port,
        gpuName: instance.gpuName,
        hourlyRate: instance.hourlyRate,
        createdAt: instance.createdAt,
        lastActivity: instance.lastActivity,
      },
      healthy: isHealthy,
    });
  } catch (error) {
    console.error("[TTS] Status check failed:", error);
    return c.json(
      {
        active: false,
        status: "error",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

/**
 * GET /api/tts/voices
 * Get available voices
 */
tts.get("/voices", async (c) => {
  try {
    const voices = await getVoices();
    return c.json({ voices });
  } catch (error) {
    console.error("[TTS] Failed to get voices:", error);
    return c.json({ voices: ["default"] });
  }
});

/**
 * GET /api/tts/pricing
 * Get current GPU pricing options
 */
tts.get("/pricing", async (c) => {
  try {
    const offers = await searchBestGPU();
    
    const pricing = offers.slice(0, 5).map((offer) => ({
      id: offer.id,
      gpu: offer.gpu_name,
      vram: `${Math.round(offer.gpu_ram / 1024)}GB`,
      hourlyRate: offer.dph_total,
      cuda: offer.cuda_max,
      location: offer.geolocation?.trim(),
    }));

    return c.json({ pricing });
  } catch (error) {
    console.error("[TTS] Failed to get pricing:", error);
    return c.json(
      {
        error: "Failed to fetch pricing",
        message: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default tts;
