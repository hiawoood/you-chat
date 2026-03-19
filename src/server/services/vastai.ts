// Vast.ai TTS Service - Manages GPU instances for Chatterbox TTS Server
// Uses shukco/chatterbox-turbo-api:latest Docker image
// API Docs: https://docs.vast.ai/api

import type { TtsVoiceReference } from "../db";

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
  voiceReferenceId?: string | null;
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

interface ActiveReferenceState {
  instanceId: string | null;
  mode: "builtin" | "custom" | "unknown";
  voiceId: string | null;
}

let activeReferenceState: ActiveReferenceState = {
  instanceId: null,
  mode: "unknown",
  voiceId: null,
};

function resetReferenceState(instanceId: string | null = null, mode: ActiveReferenceState["mode"] = "unknown") {
  activeReferenceState = {
    instanceId,
    mode,
    voiceId: null,
  };
}

function syncReferenceStateToInstance(instance: VastInstance | null) {
  if (!instance) {
    resetReferenceState();
    return;
  }

  if (activeReferenceState.instanceId !== instance.id) {
    resetReferenceState(instance.id, "unknown");
  }
}

function getInstanceBaseUrl(instance: VastInstance) {
  if (!instance.ip || !instance.port) {
    throw new Error("No active TTS instance");
  }
  return `http://${instance.ip}:${instance.port}`;
}

async function uploadVoiceReferenceToInstance(instance: VastInstance, voiceReference: TtsVoiceReference) {
  const file = Bun.file(voiceReference.storage_path);
  if (!(await file.exists())) {
    throw new Error(`Voice reference file not found: ${voiceReference.label}`);
  }

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([await file.arrayBuffer()], { type: voiceReference.mime_type }),
    voiceReference.original_filename
  );
  formData.append("norm_loudness", "true");

  const response = await fetch(`${getInstanceBaseUrl(instance)}/reference`, {
    method: "POST",
    body: formData,
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to apply voice reference: ${errorText}`);
  }

  activeReferenceState = {
    instanceId: instance.id,
    mode: "custom",
    voiceId: voiceReference.id,
  };
}

async function ensureVoiceReferenceForInstance(voiceReference: TtsVoiceReference | null): Promise<VastInstance> {
  let instance = await startCheapestInstance();
  syncReferenceStateToInstance(instance);

  if (!voiceReference) {
    if (activeReferenceState.mode === "builtin") {
      return instance;
    }

    console.log("[VastTTS] Resetting instance to builtin reference mode");
    await destroyInstance(instance.id);
    instance = await startCheapestInstance();
    activeReferenceState = {
      instanceId: instance.id,
      mode: "builtin",
      voiceId: null,
    };
    return instance;
  }

  if (activeReferenceState.mode === "custom" && activeReferenceState.voiceId === voiceReference.id) {
    return instance;
  }

  await uploadVoiceReferenceToInstance(instance, voiceReference);
  return instance;
}

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

  resetReferenceState(activeInstance.id, "builtin");

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
 * List all user instances from Vast.ai
 */
export async function listUserInstances(): Promise<any[]> {
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
 * Find and adopt any existing running TTS instance
 * Called on startup to recover from server restarts
 */
export async function findAndAdoptExistingInstance(): Promise<VastInstance | null> {
  console.log("[VastTTS] Checking for existing running instances...");
  
  try {
    const instances = await listUserInstances();
    
    // Filter for running instances with our label
    const runningInstances = instances.filter((inst: any) => {
      return inst.actual_status === "running" && 
             inst.public_ipaddr &&
             (inst.label?.includes("chatterbox") || inst.image?.includes("chatterbox"));
    });
    
    console.log(`[VastTTS] Found ${runningInstances.length} running TTS instances`);
    
    // Try each running instance to see if it's healthy
    for (const inst of runningInstances) {
      try {
        const ports = inst.ports || {};
        const portMapping = ports["8000/tcp"];
        const apiPort = portMapping ? parseInt(portMapping[0]?.HostPort || "8000", 10) : 8000;
        
        console.log(`[VastTTS] Checking instance ${inst.id} at ${inst.public_ipaddr}:${apiPort}`);
        
        // Temporarily set activeInstance to test health
        const testInstance: VastInstance = {
          id: inst.id.toString(),
          ip: inst.public_ipaddr,
          port: apiPort,
          status: "running",
          createdAt: new Date(inst.start_date * 1000),
          lastActivity: new Date(),
          gpuName: inst.gpu_name,
          hourlyRate: inst.dph_total,
        };
        
        // Temporarily set for health check
        activeInstance = testInstance;
        const isHealthy = await healthCheck();
        
        if (isHealthy) {
          console.log(`[VastTTS] ✓ Adopted existing healthy instance: ${inst.id}`);
          resetReferenceState(testInstance.id, "unknown");
          resetInactivityTimer();
          return testInstance;
        } else {
          console.log(`[VastTTS] Instance ${inst.id} not healthy, trying next...`);
          activeInstance = null;
        }
      } catch (err) {
        console.log(`[VastTTS] Failed to check instance ${inst.id}:`, err);
      }
    }
    
    console.log("[VastTTS] No healthy existing instances found");
    return null;
  } catch (error) {
    console.error("[VastTTS] Error listing instances:", error);
    return null;
  }
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
 * Returns raw WAV audio data (binary)
 */
export async function generateSpeech(
  request: TTSSpeechRequest,
  voiceReference: TtsVoiceReference | null = null
): Promise<TTSSpeechResponse> {
  const instance = await ensureVoiceReferenceForInstance(voiceReference);

  // Update last activity
  instance.lastActivity = new Date();
  resetInactivityTimer();

  const response = await fetch(
    `${getInstanceBaseUrl(instance)}/tts`,
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

  // Get raw audio data and convert to base64
  const audioBuffer = await response.arrayBuffer();
  const audioBase64 = Buffer.from(audioBuffer).toString('base64');
  
  // Estimate duration (rough calculation for 24kHz mono)
  // WAV header is 44 bytes, rest is PCM data
  const audioDataSize = audioBuffer.byteLength - 44;
  const duration = audioDataSize / (24000 * 2); // 24kHz, 16-bit = 2 bytes per sample

  return {
    audio: audioBase64,
    duration: Math.max(0, duration),
    sampleRate: 24000,
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
    resetReferenceState();
    clearInactivityTimer();
  }

  console.log(`[VastTTS] Instance ${instanceId} destroyed`);
}

export async function applyVoiceReferenceSelection(voiceReference: TtsVoiceReference | null): Promise<{ applied: boolean; requiresBuiltinReset: boolean }> {
  if (!activeInstance) {
    if (!voiceReference) {
      resetReferenceState(null, "unknown");
    }
    return { applied: false, requiresBuiltinReset: false };
  }

  const isHealthy = await healthCheck();
  if (!isHealthy) {
    return { applied: false, requiresBuiltinReset: false };
  }

  syncReferenceStateToInstance(activeInstance);

  if (!voiceReference) {
    const requiresBuiltinReset = activeReferenceState.mode !== "builtin";
    activeReferenceState = {
      instanceId: activeInstance.id,
      mode: requiresBuiltinReset ? "unknown" : "builtin",
      voiceId: null,
    };
    return {
      applied: !requiresBuiltinReset,
      requiresBuiltinReset,
    };
  }

  if (activeReferenceState.mode === "custom" && activeReferenceState.voiceId === voiceReference.id) {
    return { applied: true, requiresBuiltinReset: false };
  }

  await uploadVoiceReferenceToInstance(activeInstance, voiceReference);
  return { applied: true, requiresBuiltinReset: false };
}

export function markVoiceReferenceAsStale(voiceId: string | null) {
  if (voiceId && activeReferenceState.voiceId === voiceId) {
    activeReferenceState = {
      instanceId: activeReferenceState.instanceId,
      mode: "unknown",
      voiceId: null,
    };
  }
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
 * Checks for existing healthy instance first before creating new one
 */
export async function startCheapestInstance(): Promise<VastInstance> {
  // First, check if we already have an active instance that's healthy
  if (activeInstance?.ip && activeInstance?.port) {
    console.log("[VastTTS] Checking if existing active instance is healthy...");
    const isHealthy = await healthCheck();
    
    if (isHealthy) {
      console.log(`[VastTTS] Adopting existing healthy instance: ${activeInstance.id}`);
      activeInstance.lastActivity = new Date();
      resetInactivityTimer();
      return activeInstance;
    } else {
      console.log("[VastTTS] Existing instance not healthy, will look for others...");
      activeInstance = null;
    }
  }

  // Second, check Vast.ai API for any running instances we might have lost track of
  const adoptedInstance = await findAndAdoptExistingInstance();
  if (adoptedInstance) {
    return adoptedInstance;
  }

  console.log("[VastTTS] No existing healthy instances found, creating new one...");

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

/**
 * Periodic cleanup job: ensure only one healthy Vast.ai instance exists
 * Runs every minute to:
 * 1. List all Vast.ai instances
 * 2. If multiple healthy instances exist, keep only the adopted one (or adopt one)
 * 3. Destroy extra instances
 */
export async function cleanupDuplicateInstances(): Promise<void> {
  try {
    console.log("[VastTTS] Running cleanup: checking for duplicate instances...");
    
    const instances = await listUserInstances();
    
    // Filter for running instances with our label/image
    const runningInstances = instances.filter((inst: any) => {
      return inst.actual_status === "running" && 
             inst.public_ipaddr &&
             (inst.label?.includes("chatterbox") || inst.image?.includes("chatterbox"));
    });
    
    if (runningInstances.length === 0) {
      console.log("[VastTTS] Cleanup: No running instances found");
      return;
    }
    
    console.log(`[VastTTS] Cleanup: Found ${runningInstances.length} running TTS instances`);
    
    // If only one instance exists, ensure it's adopted
    if (runningInstances.length === 1) {
      const inst = runningInstances[0];
      
      // If we don't have an active instance, adopt this one
      if (!activeInstance) {
        console.log(`[VastTTS] Cleanup: Adopting single instance ${inst.id}`);
        
        const ports = inst.ports || {};
        const portMapping = ports["8000/tcp"];
        const apiPort = portMapping ? parseInt(portMapping[0]?.HostPort || "8000", 10) : 8000;
        
        activeInstance = {
          id: inst.id.toString(),
          ip: inst.public_ipaddr,
          port: apiPort,
          status: "running",
          createdAt: new Date(inst.start_date * 1000),
          lastActivity: new Date(),
          gpuName: inst.gpu_name,
          hourlyRate: inst.dph_total,
        };

        resetReferenceState(activeInstance.id, "unknown");

        resetInactivityTimer();
      }
      return;
    }
    
    // Multiple instances exist - need to clean up
    console.log(`[VastTTS] Cleanup: ${runningInstances.length} instances found, checking health...`);
    
    const healthyInstances: Array<{ id: string; instance: VastInstance }> = [];
    
    // Check health of all instances
    for (const inst of runningInstances) {
      try {
        const ports = inst.ports || {};
        const portMapping = ports["8000/tcp"];
        const apiPort = portMapping ? parseInt(portMapping[0]?.HostPort || "8000", 10) : 8000;
        
        const testInstance: VastInstance = {
          id: inst.id.toString(),
          ip: inst.public_ipaddr,
          port: apiPort,
          status: "running",
          createdAt: new Date(inst.start_date * 1000),
          lastActivity: new Date(),
          gpuName: inst.gpu_name,
          hourlyRate: inst.dph_total,
        };
        
        // Temporarily set to check health
        const prevActive = activeInstance;
        activeInstance = testInstance;
        const isHealthy = await healthCheck();
        
        if (!isHealthy && !prevActive) {
          activeInstance = null;
        } else {
          activeInstance = prevActive;
        }
        
        if (isHealthy) {
          healthyInstances.push({ id: inst.id.toString(), instance: testInstance });
        }
      } catch (err) {
        console.log(`[VastTTS] Cleanup: Instance ${inst.id} health check failed`);
      }
    }
    
    console.log(`[VastTTS] Cleanup: ${healthyInstances.length} healthy instances`);
    
    if (healthyInstances.length <= 1) {
      // If only one healthy, adopt it
      if (healthyInstances.length === 1 && !activeInstance) {
        const onlyHealthyInstance = healthyInstances[0];
        if (!onlyHealthyInstance) {
          return;
        }
        activeInstance = onlyHealthyInstance.instance;
        resetReferenceState(activeInstance.id, "unknown");
        resetInactivityTimer();
        console.log(`[VastTTS] Cleanup: Adopted healthy instance ${activeInstance.id}`);
      }
      return;
    }
    
    // Multiple healthy instances - keep one, destroy others
    // Prefer the currently adopted one if it's healthy
    let instanceToKeep = healthyInstances.find(h => h.id === activeInstance?.id);
    
    // If no adopted instance is healthy, keep the first one
    if (!instanceToKeep) {
      instanceToKeep = healthyInstances[0];
      if (!instanceToKeep) {
        return;
      }
      activeInstance = instanceToKeep.instance;
      resetReferenceState(activeInstance.id, "unknown");
      resetInactivityTimer();
      console.log(`[VastTTS] Cleanup: Adopted instance ${activeInstance.id}`);
    }
    
    // Destroy all other healthy instances
    for (const { id } of healthyInstances) {
      if (id !== instanceToKeep.id) {
        try {
          console.log(`[VastTTS] Cleanup: Destroying duplicate instance ${id}`);
          await destroyInstance(id);
        } catch (err) {
          console.error(`[VastTTS] Cleanup: Failed to destroy instance ${id}:`, err);
        }
      }
    }
    
    console.log(`[VastTTS] Cleanup: Kept instance ${instanceToKeep.id}, destroyed ${healthyInstances.length - 1} duplicates`);
    
  } catch (error) {
    console.error("[VastTTS] Cleanup: Error during cleanup:", error);
  }
}

export default {
  searchBestGPU,
  createInstance,
  destroyInstance,
  healthCheck,
  generateSpeech,
  applyVoiceReferenceSelection,
  getActiveInstance,
  markVoiceReferenceAsStale,
  startCheapestInstance,
  stopInstance,
  cleanupDuplicateInstances,
};
