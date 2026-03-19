// Vast.ai TTS Service - Manages GPU instances for Chatterbox TTS Server
// Uses shukco/chatterbox-turbo-api:latest Docker image
// API Docs: https://docs.vast.ai/api

const VAST_API_KEY = process.env.VAST_API_KEY || "";
const HF_TOKEN = process.env.HF_TOKEN || "";
const VAST_API_URL = "https://console.vast.ai/api/v0";
const DOCKER_IMAGE = "shukco/chatterbox-turbo-api:latest";

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
const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutes

/**
 * Search for best GPU instances available on Vast.ai
 * Uses filters from the verified working README
 * Tries both on-demand and interruptible (spot) instances
 */
export async function searchBestGPU(): Promise<any[]> {
  // Try interruptible (spot) instances first - cheaper and less competition
  console.log("[VastTTS] Searching for interruptible (spot) instances...");
  
  let response = await fetch(`${VAST_API_URL}/bundles/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      limit: 10,
      type: "interruptible", // Spot instances - cheaper, less competition
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_ram: { lte: 10240 },
      inet_down: { gt: 500 },
      inet_down_cost: { lt: 0.005 },
      direct_port_count: { gte: 2 },
      reliability: { gt: 0.97 },
      dlperf: { gt: 5 },
      cuda_max_good: { gte: 12.4 },
      order: [["dph_total", "asc"]],
    }),
  });

  if (response.ok) {
    const data = await response.json();
    const offers = data.offers || [];
    if (offers.length > 0) {
      console.log(`[VastTTS] Found ${offers.length} interruptible offers`);
      return offers;
    }
  }

  // Fallback to on-demand if no interruptible available
  console.log("[VastTTS] No interruptible offers, trying on-demand...");
  
  response = await fetch(`${VAST_API_URL}/bundles/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      limit: 10,
      type: "ondemand",
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      num_gpus: { eq: 1 },
      gpu_ram: { lte: 10240 },
      inet_down: { gt: 500 },
      inet_down_cost: { lt: 0.005 },
      direct_port_count: { gte: 2 },
      reliability: { gt: 0.97 },
      dlperf: { gt: 5 },
      cuda_max_good: { gte: 12.4 },
      order: [["dph_total", "asc"]],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("[VastTTS] Search failed:", response.status, errorText);
    throw new Error(`Failed to search instances: ${response.statusText}`);
  }

  const data = await response.json();
  const offers = data.offers || [];
  
  console.log(`[VastTTS] Found ${offers.length} on-demand offers`);
  return offers;
}

/**
 * Create a new Vast.ai instance with Chatterbox TTS Server
 * Uses shukco/chatterbox-turbo-api:latest Docker image
 */
export async function createInstance(offerId: string): Promise<VastInstance> {
  if (!HF_TOKEN) {
    throw new Error("HF_TOKEN environment variable is required for Hugging Face model download");
  }

  const response = await fetch(`${VAST_API_URL}/asks/${offerId}/`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: "me",
      image: DOCKER_IMAGE,
      label: "chatterbox-turbo-api-rest",
      disk: 50,
      runtype: "ssh_direct",
      target_state: "running",
      cancel_unavail: true,
      env: {
        HF_TOKEN: HF_TOKEN,
        "-p 8000:8000": "1",
        "-h chatterbox-turbo": "1",
      },
      onstart: "/opt/chatterbox/deploy/vast/start_api.sh",
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    // Check for specific error types
    if (response.status === 404) {
      throw new Error(`Offer ${offerId} no longer available (404) - likely taken by another user`);
    }
    if (errorText.includes("no_such_ask")) {
      throw new Error(`Offer ${offerId} not found - marketplace too competitive`);
    }
    throw new Error(`Failed to create instance: ${errorText}`);
  }

  const data = await response.json();
  const instanceId = data.new_contract?.toString();

  if (!instanceId) {
    throw new Error("No instance ID returned from Vast.ai");
  }

  console.log(`[VastTTS] Instance created: ${instanceId}`);

  // Poll for instance to be running and get IP/port
  const instanceInfo = await pollInstanceReady(instanceId);

  activeInstance = {
    id: instanceId,
    ip: instanceInfo.public_ipaddr || null,
    port: instanceInfo.apiPort || 8000,
    status: "running",
    createdAt: new Date(),
    lastActivity: new Date(),
    gpuName: instanceInfo.gpu_name,
    hourlyRate: instanceInfo.dph_total,
  };

  // Start inactivity timer (60 minutes)
  resetInactivityTimer();

  return activeInstance;
}

/**
 * Poll instance until it's running and has ports mapped
 */
async function pollInstanceReady(instanceId: string, maxAttempts = 30): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    console.log(`[VastTTS] Polling instance ${instanceId}, attempt ${attempt + 1}/${maxAttempts}`);
    
    const response = await fetch(`${VAST_API_URL}/instances/${instanceId}/`, {
      headers: {
        Authorization: `Bearer ${VAST_API_KEY}`,
      },
    });

    if (!response.ok) {
      await new Promise((r) => setTimeout(r, 10000));
      continue;
    }

    const data = await response.json();
    const instance = data.instances || data;

    // Check if instance is running and has IP
    if (instance.actual_status === "running" && instance.public_ipaddr) {
      // Get the mapped port for 8000
      const ports = instance.ports || {};
      const portMapping = ports["8000/tcp"];
      
      if (portMapping) {
        const apiPort = parseInt(portMapping[0]?.HostPort || "8000", 10);
        console.log(`[VastTTS] Instance ready! IP: ${instance.public_ipaddr}, Port: ${apiPort}`);
        return {
          ...instance,
          apiPort,
        };
      }
    }

    // Wait 10 seconds before next poll
    await new Promise((r) => setTimeout(r, 10000));
  }

  throw new Error(`Instance ${instanceId} did not become ready in time`);
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
  return data.instances || data;
}

/**
 * Check if the TTS service is healthy
 */
export async function healthCheck(): Promise<boolean> {
  if (!activeInstance?.ip || !activeInstance?.port) {
    return false;
  }

  try {
    const response = await fetch(
      `http://${activeInstance.ip}:${activeInstance.port}/healthz`,
      {
        signal: AbortSignal.timeout(15000),
      }
    );
    
    if (response.ok) {
      const data = await response.json();
      return data.status === "ok";
    }
    return false;
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
  if (!activeInstance?.ip || !activeInstance?.port) {
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
      }),
      signal: AbortSignal.timeout(180000), // 3 minute timeout for generation
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

  console.log(`[VastTTS] Instance ${instanceId} destroyed`);
}

/**
 * Start an existing instance (not used with current flow)
 */
export async function startInstance(instanceId: string): Promise<void> {
  // Instances are started automatically with target_state: "running"
  console.log(`[VastTTS] Instance ${instanceId} should already be running`);
}

/**
 * Stop an instance by destroying it
 */
export async function stopInstance(instanceId: string): Promise<void> {
  await destroyInstance(instanceId);
}

/**
 * Get active instance info
 */
export function getActiveInstance(): VastInstance | null {
  return activeInstance;
}

/**
 * Start the cheapest available GPU instance
 * Uses aggressive retry strategy due to competitive marketplace
 */
export async function startCheapestInstance(): Promise<VastInstance> {
  console.log("[VastTTS] Searching for best GPU...");

  // Try multiple search rounds - offers disappear quickly
  for (let searchRound = 0; searchRound < 3; searchRound++) {
    if (searchRound > 0) {
      console.log(`[VastTTS] Search round ${searchRound + 1}/3...`);
      await new Promise(r => setTimeout(r, 1000)); // Brief pause between searches
    }

    const offers = await searchBestGPU();

    if (offers.length === 0) {
      console.log("[VastTTS] No offers found in this round, retrying...");
      continue;
    }

    // Try top offers from this search
    const offersToTry = offers.slice(0, 5);
    
    for (const offer of offersToTry) {
      try {
        console.log(`[VastTTS] Trying offer ${offer.id}: ${offer.gpu_name} at $${offer.dph_total}/hour`);
        const instance = await createInstance(offer.id.toString());
        console.log(`[VastTTS] Successfully created instance with ${offer.gpu_name}!`);
        return instance;
      } catch (error: any) {
        const errorMsg = error.message || "";
        // Check if it's a 404 (offer taken) or other error
        if (errorMsg.includes("404") || errorMsg.includes("no_such_ask") || errorMsg.includes("not found")) {
          console.log(`[VastTTS] Offer ${offer.id} was taken by another user`);
        } else {
          console.error(`[VastTTS] Error with offer ${offer.id}:`, errorMsg.substring(0, 100));
        }
        continue;
      }
    }
  }

  throw new Error("Unable to secure a GPU instance. The Vast.ai marketplace is very competitive. Please try again.");
}

/**
 * Reset the inactivity timer (60 minutes)
 */
function resetInactivityTimer(): void {
  clearInactivityTimer();
  
  inactivityTimer = setTimeout(async () => {
    if (activeInstance) {
      console.log(`[VastTTS] Instance ${activeInstance.id} inactive for 60 minutes, destroying...`);
      try {
        await destroyInstance(activeInstance.id);
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

export default {
  searchBestGPU,
  createInstance,
  destroyInstance,
  healthCheck,
  generateSpeech,
  getActiveInstance,
  startCheapestInstance,
  stopInstance,
};
