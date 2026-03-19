// TTS API Routes - Manages Vast.ai instances for text-to-speech
import { Hono, type Context } from "hono";
import type { AppEnv } from "../context";
import {
  getActiveInstance,
  healthCheck,
  startCheapestInstance,
  stopInstance as stopActiveInstance,
  generateSpeech,
  searchBestGPU,
  applyVoiceReferenceSelection,
  markVoiceReferenceAsStale,
  getLifecycleState,
} from "../services/vastai";
import {
  createTtsVoiceReference,
  deleteTtsVoiceReference,
  getSelectedTtsVoiceReference,
  getSelectedTtsVoiceReferenceId,
  getTtsProgress,
  getTtsVoiceReference,
  listTtsVoiceReferences,
  setSelectedTtsVoiceReference,
  setTtsProgress,
  updateTtsVoiceReference,
  type TtsVoiceReference,
} from "../db";
import { deleteTtsVoiceFile, getStoredTtsVoiceFile, saveTtsVoiceFile } from "../lib/tts-storage";

const tts = new Hono<AppEnv>();

const MAX_VOICE_UPLOAD_BYTES = 15 * 1024 * 1024;
const ALLOWED_AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".ogg", ".flac", ".webm"]);

function formatVoiceReference(c: Context<AppEnv>, voice: TtsVoiceReference, selectedVoiceId: string | null) {
  return {
    id: voice.id,
    label: voice.label,
    originalFilename: voice.original_filename,
    mimeType: voice.mime_type,
    sizeBytes: voice.size_bytes,
    createdAt: voice.created_at,
    updatedAt: voice.updated_at,
    selected: voice.id === selectedVoiceId,
    previewUrl: `${new URL(c.req.url).origin}/api/tts/voices/${voice.id}/audio`,
  };
}

function getVoiceSelectionResponse(c: Context<AppEnv>, userId: string) {
  const selectedVoiceId = getSelectedTtsVoiceReferenceId(userId);
  const voices = listTtsVoiceReferences(userId).map((voice) => formatVoiceReference(c, voice, selectedVoiceId));
  return { voices, selectedVoiceId };
}

function isAllowedAudioFile(file: File) {
  if (file.type.startsWith("audio/")) {
    return true;
  }

  const extension = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
  return ALLOWED_AUDIO_EXTENSIONS.has(extension);
}

/**
 * POST /api/tts/speak
 * Generate speech from text
 * Body: { text: string, voice?: string, speed?: number, language?: string }
 */
tts.post("/speak", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    const body = await c.req.json();
    const { text, voice, voiceReferenceId, speed, language } = body;

    if (!text || typeof text !== "string") {
      return c.json({ error: "Text is required" }, 400);
    }

    let selectedVoice: TtsVoiceReference | null;
    if (voiceReferenceId === null) {
      selectedVoice = null;
    } else if (typeof voiceReferenceId === "string" && voiceReferenceId.trim()) {
      selectedVoice = getTtsVoiceReference(user.id, voiceReferenceId.trim());
      if (!selectedVoice) {
        return c.json({ error: "Selected voice reference was not found" }, 404);
      }
    } else {
      selectedVoice = getSelectedTtsVoiceReference(user.id);
    }

    try {
      const result = await generateSpeech({
        text,
        voice,
        voiceReferenceId: selectedVoice?.id ?? null,
        speed,
        language,
      }, selectedVoice);

      const instance = getActiveInstance();

      return c.json({
        success: true,
        audio: result.audio,
        duration: result.duration,
        sampleRate: result.sampleRate,
        instance: {
          id: instance?.id,
          gpu: instance?.gpuName,
          hourlyRate: instance?.hourlyRate,
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

    await stopActiveInstance(instance.id);

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
    const lifecycle = getLifecycleState();
    
    if (!instance) {
      return c.json({
        active: false,
        status: lifecycle.phase === "error" ? "error" : lifecycle.provisioning ? lifecycle.phase : "stopped",
        lifecycle,
      });
    }

    const isHealthy = await healthCheck();

    return c.json({
      active: instance.status === "running" && isHealthy,
      status: instance.status,
      lifecycle,
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
 * Get saved user voice references and current selection
 */
tts.get("/voices", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  try {
    return c.json(getVoiceSelectionResponse(c, user.id));
  } catch (error) {
    console.error("[TTS] Failed to list voice references:", error);
    return c.json({ error: "Failed to load voice references" }, 500);
  }
});

/**
 * POST /api/tts/voices
 * Upload a new voice reference file
 */
tts.post("/voices", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  let storagePath: string | null = null;

  try {
    const form = await c.req.parseBody();
    const label = typeof form.label === "string" ? form.label.trim() : "";
    const file = form.file;

    if (!label) {
      return c.json({ error: "Voice label is required" }, 400);
    }

    if (!(file instanceof File)) {
      return c.json({ error: "Audio file is required" }, 400);
    }

    if (!isAllowedAudioFile(file)) {
      return c.json({ error: "Upload a supported audio file" }, 400);
    }

    if (file.size <= 0 || file.size > MAX_VOICE_UPLOAD_BYTES) {
      return c.json({ error: `Audio file must be between 1 byte and ${MAX_VOICE_UPLOAD_BYTES} bytes` }, 400);
    }

    const storedFile = await saveTtsVoiceFile(user.id, crypto.randomUUID().replace(/-/g, ""), file);
    storagePath = storedFile.storagePath;

    const voice = createTtsVoiceReference(
      user.id,
      label,
      storedFile.originalFilename,
      storedFile.storagePath,
      storedFile.mimeType,
      storedFile.sizeBytes
    );

    const selectedVoiceId = getSelectedTtsVoiceReferenceId(user.id);
    return c.json({
      success: true,
      voice: formatVoiceReference(c, voice, selectedVoiceId),
      ...getVoiceSelectionResponse(c, user.id),
    });
  } catch (error) {
    if (storagePath) {
      await deleteTtsVoiceFile(storagePath);
    }
    console.error("[TTS] Failed to upload voice reference:", error);
    return c.json({ error: "Failed to upload voice reference" }, 500);
  }
});

/**
 * GET /api/tts/voices/:voiceId/audio
 * Stream a stored voice reference for preview
 */
tts.get("/voices/:voiceId/audio", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const voiceId = c.req.param("voiceId");
  const voice = getTtsVoiceReference(user.id, voiceId);
  if (!voice) {
    return c.json({ error: "Voice reference not found" }, 404);
  }

  const file = getStoredTtsVoiceFile(voice.storage_path);
  if (!(await file.exists())) {
    return c.json({ error: "Voice reference file not found" }, 404);
  }

  return new Response(file, {
    headers: {
      "Content-Type": voice.mime_type,
      "Content-Disposition": `inline; filename="${voice.original_filename.replace(/"/g, "")}"`,
      "Cache-Control": "private, max-age=60",
    },
  });
});

/**
 * PATCH /api/tts/voices/:voiceId
 * Rename a stored voice reference
 */
tts.patch("/voices/:voiceId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const voiceId = c.req.param("voiceId");
  const voice = getTtsVoiceReference(user.id, voiceId);
  if (!voice) {
    return c.json({ error: "Voice reference not found" }, 404);
  }

  const body = await c.req.json<{ label?: string }>();
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) {
    return c.json({ error: "Voice label is required" }, 400);
  }

  const updatedVoice = updateTtsVoiceReference(user.id, voiceId, { label });
  const selectedVoiceId = getSelectedTtsVoiceReferenceId(user.id);

  return c.json({
    success: true,
    voice: updatedVoice ? formatVoiceReference(c, updatedVoice, selectedVoiceId) : null,
    ...getVoiceSelectionResponse(c, user.id),
  });
});

/**
 * DELETE /api/tts/voices/:voiceId
 * Delete a stored voice reference
 */
tts.delete("/voices/:voiceId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const voiceId = c.req.param("voiceId");
  const voice = getTtsVoiceReference(user.id, voiceId);
  if (!voice) {
    return c.json({ error: "Voice reference not found" }, 404);
  }

  deleteTtsVoiceReference(user.id, voiceId);
  await deleteTtsVoiceFile(voice.storage_path);
  markVoiceReferenceAsStale(voice.id);

  return c.json({
    success: true,
    ...getVoiceSelectionResponse(c, user.id),
  });
});

/**
 * POST /api/tts/voices/:voiceId/select
 * Select a stored voice reference for future playback
 */
tts.post("/voices/:voiceId/select", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const voiceId = c.req.param("voiceId");
  const voice = getTtsVoiceReference(user.id, voiceId);
  if (!voice) {
    return c.json({ error: "Voice reference not found" }, 404);
  }

  setSelectedTtsVoiceReference(user.id, voice.id);

  let applied = false;
  let warning: string | null = null;
  try {
    const result = await applyVoiceReferenceSelection(voice);
    applied = result.applied;
    if (!result.applied) {
      warning = "Voice will be applied when the next playback request starts.";
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : "Voice will be applied on next playback";
  }

  return c.json({
    success: true,
    applied,
    warning,
    ...getVoiceSelectionResponse(c, user.id),
  });
});

/**
 * POST /api/tts/voices/select-none
 * Clear the selected voice reference
 */
tts.post("/voices/select-none", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  setSelectedTtsVoiceReference(user.id, null);

  let applied = false;
  let requiresBuiltinReset = false;
  let warning: string | null = null;
  try {
    const result = await applyVoiceReferenceSelection(null);
    applied = result.applied;
    requiresBuiltinReset = result.requiresBuiltinReset;
    if (!result.applied) {
      warning = "Builtin voice will be used when the next playback request starts.";
    }
  } catch (error) {
    warning = error instanceof Error ? error.message : "Failed to restore builtin voice";
  }

  return c.json({
    success: true,
    applied,
    requiresBuiltinReset,
    warning,
    ...getVoiceSelectionResponse(c, user.id),
  });
});

/**
 * GET /api/tts/progress/:messageId
 * Get the last played chunk index for a message
 */
tts.get("/progress/:messageId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const messageId = c.req.param("messageId");
  if (!messageId) return c.json({ error: "messageId required" }, 400);

  try {
    const chunkIndex = getTtsProgress(messageId);
    return c.json({ chunkIndex });
  } catch (error: any) {
    console.error(`[TTS] Error getting progress for ${messageId}:`, error);
    return c.json({ error: "Failed to get TTS progress", message: error.message }, 500);
  }
});

/**
 * PATCH /api/tts/progress/:messageId
 * Update the last played chunk index for a message
 * Body: { chunkIndex: number }
 */
tts.patch("/progress/:messageId", async (c) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "Unauthorized" }, 401);

  const messageId = c.req.param("messageId");
  if (!messageId) return c.json({ error: "messageId required" }, 400);

  const body = await c.req.json<{ chunkIndex: number }>();
  if (body.chunkIndex === undefined || typeof body.chunkIndex !== "number") {
    return c.json({ error: "chunkIndex is required and must be a number" }, 400);
  }

  try {
    setTtsProgress(messageId, body.chunkIndex);
    return c.json({ success: true, message: "Progress updated successfully" });
  } catch (error: any) {
    console.error(`[TTS] Error setting progress for ${messageId}:`, error);
    return c.json({ error: "Failed to update TTS progress", message: error.message }, 500);
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
