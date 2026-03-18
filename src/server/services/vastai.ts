// Vast.ai TTS Service - Manages GPU instances for Chatterbox TTS Server
// API Docs: https://vast.ai/api

const VAST_API_KEY = process.env.VAST_API_KEY || "42235cb79decbbd7539d61b2fcfc13af450ec13b0ce303f04e86413e5de06631";
const VAST_API_URL = "https://console.vast.ai/api/v0";

export interface VastInstance {
  id: string;
  ip: string | null;
  port: number;
  status: "pending" | "running" | "stopped" | "error";
  createdAt: Date;
  lastActivity: Date;
  machineId?: string;
  gpuName?: string;
  hourlyRate?: number;
}

export interface TTSSpeechRequest {
  text: string;
  voice?: string;
  speed?: number;
  language?: string;
}

export interface TTSSpeechResponse {
  audio: string; // base64 encoded audio
  duration: number;
  sampleRate: number;
}

// In-memory instance state (would be persisted to DB in production)
let activeInstance: VastInstance | null = null;
let inactivityTimer: Timer | null = null;
const INACTIVITY_TIMEOUT = 10 * 60 * 1000; // 10 minutes

/**
 * Search for cheapest GPU instances available on Vast.ai
 */
export async function searchCheapestGPU(
  minCuda: number = 8.6,
  minMemoryGB: number = 8
): Promise<any[]> {
  // Build query string manually - Vast.ai expects specific format
  const queryParams = new URLSearchParams({
    order: "dph_total",
    order_direction: "asc",
    type: "on-demand",
    gpu_ram: (minMemoryGB * 1024).toString(),
    cuda_vers: minCuda.toString(),
    verified: "true",
    rentable: "true",
  });

  const response = await fetch(`${VAST_API_URL}/bundles/?${queryParams}`, {
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[VastTTS] Search failed:", response.status, errorText);
    throw new Error(`Failed to search instances: ${response.statusText}`);
  }

  const data = await response.json();
  const offers = data.offers || [];
  
  // Filter for compatible GPUs
  const compatibleGPUs = ["RTX 3060", "RTX 4060", "RTX 4060 Ti", "A4000", "RTX 3070", "RTX 3080", "RTX 3090", "A5000"];
  const filtered = offers.filter((offer: any) => {
    const gpuName = (offer.gpu_name || "").toUpperCase();
    return compatibleGPUs.some(gpu => gpuName.includes(gpu.toUpperCase()));
  });
  
  console.log(`[VastTTS] Found ${filtered.length} compatible offers out of ${offers.length} total`);
  return filtered;
}

/**
 * Create a new Vast.ai instance with Chatterbox TTS Server
 * Uses PUT /asks/{id}/ to accept an ask contract
 */
export async function createInstance(
  offerId: string,
  image: string = "devnen/chatterbox-tts-server:latest"
): Promise<VastInstance> {
  // Accept the ask contract to create instance
  const response = await fetch(`${VAST_API_URL}/asks/${offerId}/`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: "me",
      image: image,
      env: {},
      onstart: "",
      disk: 10, // GB
      image_login: null,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create instance: ${error}`);
  }

  const data = await response.json();
  const instanceId = data.new_contract?.toString() || data.instance_id?.toString();

  // Wait a moment for the instance to initialize
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // Get instance details
  const instanceInfo = await getInstanceInfo(instanceId);

  activeInstance = {
    id: instanceId,
    ip: instanceInfo.public_ipaddr || null,
    port: 8000, // Default Chatterbox port
    status: instanceInfo.actual_status === "running" ? "running" : "pending",
    createdAt: new Date(),
    lastActivity: new Date(),
    machineId: instanceInfo.machine_id?.toString(),
  };

  // Start inactivity timer
  resetInactivityTimer();

  return activeInstance;
}

/**
 * Get instance information from Vast.ai
 */
export async function getInstanceInfo(instanceId: string): Promise<any> {
  const response = await fetch(`${VAST_API_URL}/instances/${instanceId}/`, {
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get instance info: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

/**
 * Get all user instances
 */
export async function listInstances(): Promise<any[]> {
  const response = await fetch(`${VAST_API_URL}/instances/`, {
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to list instances: ${response.statusText}`);
  }

  const data = await response.json();
  return data.instances || [];
}

/**
 * Destroy a Vast.ai instance
 */
export async function destroyInstance(instanceId: string): Promise<void> {
  const response = await fetch(`${VAST_API_URL}/instances/${instanceId}/`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
    },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to destroy instance: ${error}`);
  }

  if (activeInstance?.id === instanceId) {
    activeInstance = null;
    clearInactivityTimer();
  }
}

/**
 * Start an existing instance
 */
export async function startInstance(instanceId: string): Promise<void> {
  const response = await fetch(`${VAST_API_URL}/instances/${instanceId}/`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state: "running",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to start instance: ${error}`);
  }
}

/**
 * Stop an instance (but keep it allocated)
 */
export async function stopInstance(instanceId: string): Promise<void> {
  const response = await fetch(`${VAST_API_URL}/instances/${instanceId}/`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      state: "stopped",
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to stop instance: ${error}`);
  }
}

/**
 * Get the active instance or null
 */
export function getActiveInstance(): VastInstance | null {
  return activeInstance;
}

/**
 * Check if the active instance is healthy and running
 */
export async function healthCheck(): Promise<boolean> {
  if (!activeInstance) return false;

  try {
    const info = await getInstanceInfo(activeInstance.id);
    const isRunning = info.actual_status === "running";
    
    if (isRunning && info.public_ipaddr) {
      activeInstance.ip = info.public_ipaddr;
      activeInstance.status = "running";
      
      // Also check if TTS server is responding
      const ttsHealthy = await checkTTSServerHealth();
      return ttsHealthy;
    } else {
      activeInstance.status = info.actual_status === "stopped" ? "stopped" : "error";
      return false;
    }
  } catch (error) {
    activeInstance.status = "error";
    return false;
  }
}

/**
 * Check if the Chatterbox TTS Server is healthy
 */
export async function checkTTSServerHealth(): Promise<boolean> {
  if (!activeInstance?.ip) return false;

  try {
    const response = await fetch(`http://${activeInstance.ip}:${activeInstance.port}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Generate speech using the Chatterbox TTS Server
 */
export async function generateSpeech(
  request: TTSSpeechRequest
): Promise<TTSSpeechResponse> {
  if (!activeInstance?.ip) {
    throw new Error("No active TTS instance");
  }

  // Update last activity
  activeInstance.lastActivity = new Date();
  resetInactivityTimer();

  const response = await fetch(
    `http://${activeInstance.ip}:${activeInstance.port}/tts`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: request.text,
        voice: request.voice || "default",
        speed: request.speed || 1.0,
        language: request.language || "en",
      }),
      signal: AbortSignal.timeout(60000), // 60s timeout for generation
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`TTS generation failed: ${error}`);
  }

  const data = await response.json();
  return {
    audio: data.audio,
    duration: data.duration,
    sampleRate: data.sample_rate || 24000,
  };
}

/**
 * Stream speech generation (for large texts)
 */
export async function* streamSpeech(
  request: TTSSpeechRequest
): AsyncGenerator<Uint8Array> {
  if (!activeInstance?.ip) {
    throw new Error("No active TTS instance");
  }

  activeInstance.lastActivity = new Date();
  resetInactivityTimer();

  const response = await fetch(
    `http://${activeInstance.ip}:${activeInstance.port}/tts/stream`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: request.text,
        voice: request.voice || "default",
        speed: request.speed || 1.0,
        language: request.language || "en",
      }),
    }
  );

  if (!response.ok) {
    throw new Error(`TTS stream failed: ${response.statusText}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body");
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield value;
  }
}

/**
 * Auto-shutdown instance after inactivity
 */
function resetInactivityTimer(): void {
  clearInactivityTimer();
  
  inactivityTimer = setTimeout(async () => {
    console.log("[VastTTS] Instance inactive for 10 minutes, shutting down...");
    if (activeInstance) {
      try {
        await destroyInstance(activeInstance.id);
        console.log("[VastTTS] Instance destroyed due to inactivity");
      } catch (error) {
        console.error("[VastTTS] Failed to destroy inactive instance:", error);
      }
    }
  }, INACTIVITY_TIMEOUT);
}

function clearInactivityTimer(): void {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

/**
 * Start a new TTS instance with the cheapest available GPU
 */
export async function startCheapestInstance(): Promise<VastInstance> {
  console.log("[VastTTS] Searching for cheapest GPU...");
  
  const offers = await searchCheapestGPU();
  
  if (offers.length === 0) {
    throw new Error("No suitable GPU instances available");
  }

  // Pick the cheapest offer
  const cheapest = offers[0];
  console.log(`[VastTTS] Selected GPU: ${cheapest.gpu_name} at $${cheapest.dph_total}/hour`);

  // Create instance with Chatterbox TTS Server image
  const instance = await createInstance(
    cheapest.id.toString(),
    "devnen/chatterbox-tts-server:latest"
  );

  // Wait for the instance to be fully running
  let attempts = 0;
  const maxAttempts = 30; // 2.5 minutes
  
  while (attempts < maxAttempts) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    
    try {
      const info = await getInstanceInfo(instance.id);
      
      if (info.actual_status === "running" && info.public_ipaddr) {
        instance.ip = info.public_ipaddr;
        instance.status = "running";
        instance.gpuName = cheapest.gpu_name;
        instance.hourlyRate = cheapest.dph_total;
        
        console.log(`[VastTTS] Instance running at ${instance.ip}:${instance.port}`);
        
        // Wait a bit more for TTS server to start
        await new Promise((resolve) => setTimeout(resolve, 10000));
        
        // Verify TTS server is up
        const healthy = await checkTTSServerHealth();
        if (healthy) {
          console.log("[VastTTS] Chatterbox TTS Server is ready!");
          return instance;
        }
      }
    } catch (error) {
      console.log(`[VastTTS] Waiting for instance... (${attempts + 1}/${maxAttempts})`);
    }
    
    attempts++;
  }

  throw new Error("Instance failed to start within timeout");
}

/**
 * Stop and destroy the active instance
 */
export async function stopActiveInstance(): Promise<void> {
  if (!activeInstance) {
    throw new Error("No active instance to stop");
  }

  await destroyInstance(activeInstance.id);
  console.log("[VastTTS] Instance stopped");
}

/**
 * Get available voices from the Chatterbox TTS Server
 */
export async function getVoices(): Promise<string[]> {
  if (!activeInstance?.ip) {
    return [];
  }

  try {
    const response = await fetch(
      `http://${activeInstance.ip}:${activeInstance.port}/voices`,
      {
        signal: AbortSignal.timeout(5000),
      }
    );

    if (!response.ok) {
      return ["default"];
    }

    const data = await response.json();
    return data.voices || ["default"];
  } catch {
    return ["default"];
  }
}
