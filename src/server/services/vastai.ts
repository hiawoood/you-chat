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

export interface TtsLifecycleState {
  phase: "idle" | "checking" | "searching" | "creating" | "polling" | "running" | "stopping" | "error";
  message: string;
  updatedAt: number;
  provisioning: boolean;
  instanceId: string | null;
  offerId: string | null;
  searchRound: number | null;
  pollAttempt: number | null;
  lastError: string | null;
}

// In-memory instance state (would be persisted to DB in production)
let activeInstance: VastInstance | null = null;
let instanceStartupPromise: Promise<VastInstance> | null = null;
let instanceStartupGeneration = 0;
let inactivityTimer: Timer | null = null;
const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutes
let lifecycleState: TtsLifecycleState = {
  phase: "idle",
  message: "No GPU instance is active.",
  updatedAt: Date.now(),
  provisioning: false,
  instanceId: null,
  offerId: null,
  searchRound: null,
  pollAttempt: null,
  lastError: null,
};

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

function updateLifecycleState(patch: Partial<TtsLifecycleState>) {
  lifecycleState = {
    ...lifecycleState,
    ...patch,
    updatedAt: Date.now(),
  };
}

function setLifecycleRunning(message: string, instance?: VastInstance | null) {
  updateLifecycleState({
    phase: "running",
    message,
    provisioning: false,
    instanceId: instance?.id || activeInstance?.id || null,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
  });
}

function setLifecycleIdle(message: string = "No GPU instance is active.") {
  updateLifecycleState({
    phase: "idle",
    message,
    provisioning: false,
    instanceId: null,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
  });
}

function setLifecycleError(message: string) {
  updateLifecycleState({
    phase: "error",
    message,
    provisioning: false,
    lastError: message,
  });
}

function isManagedTtsApiInstance(instance: any): boolean {
  return Boolean(instance && (instance.label?.includes("chatterbox") || instance.image?.includes("chatterbox")));
}

function isTerminalInstanceStatus(status: string | undefined): boolean {
  return status === "destroyed" || status === "stopped" || status === "exited";
}

function getMappedApiPort(instance: any): number {
  const ports = instance?.ports || {};
  const portMapping = ports["8000/tcp"];
  return portMapping ? parseInt(portMapping[0]?.HostPort || "8000", 10) : 8000;
}

function toVastInstance(instance: any): VastInstance {
  return {
    id: instance.id.toString(),
    ip: instance.public_ipaddr || null,
    port: getMappedApiPort(instance),
    status: instance.actual_status === "running" && instance.public_ipaddr ? "running" : "pending",
    createdAt: new Date((instance.start_date || instance.created_at || Date.now() / 1000) * 1000),
    lastActivity: new Date(),
    gpuName: instance.gpu_name,
    hourlyRate: instance.dph_total,
  };
}

function isRunningReachableInstance(instance: any): boolean {
  return instance.actual_status === "running" && Boolean(instance.public_ipaddr);
}

function assertCurrentGeneration(generation: number) {
  if (generation !== instanceStartupGeneration) {
    throw new Error("Stale instance provisioning request");
  }
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

async function clearVoiceReferenceOnInstance(instance: VastInstance) {
  const response = await fetch(`${getInstanceBaseUrl(instance)}/reference`, {
    method: "DELETE",
    signal: AbortSignal.timeout(60000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to clear voice reference: ${errorText}`);
  }

  activeReferenceState = {
    instanceId: instance.id,
    mode: "builtin",
    voiceId: null,
  };
}

async function ensureVoiceReferenceForInstance(voiceReference: TtsVoiceReference | null): Promise<VastInstance> {
  let instance = await startCheapestInstance();
  syncReferenceStateToInstance(instance);

  if (!voiceReference) {
    if (activeReferenceState.mode === "builtin") {
      return instance;
    }

    console.log("[VastTTS] Clearing active voice reference from instance");
    updateLifecycleState({
      phase: "creating",
      message: "Clearing the custom voice reference and restoring builtin voice...",
      provisioning: true,
      instanceId: instance.id,
      offerId: null,
      searchRound: null,
      pollAttempt: null,
      lastError: null,
    });
    await clearVoiceReferenceOnInstance(instance);
    setLifecycleRunning("GPU instance ready with builtin voice.", instance);
    return instance;
  }

  if (activeReferenceState.mode === "custom" && activeReferenceState.voiceId === voiceReference.id) {
    return instance;
  }

  updateLifecycleState({
    phase: "creating",
    message: `Applying voice reference \"${voiceReference.label}\" to the active TTS service...`,
    provisioning: true,
    instanceId: instance.id,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
  });
  await uploadVoiceReferenceToInstance(instance, voiceReference);
  setLifecycleRunning(`GPU instance ready with voice \"${voiceReference.label}\".`, instance);
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
export async function createInstance(offerId: string, generation: number): Promise<VastInstance> {
  if (!HF_TOKEN) {
    throw new Error("HF_TOKEN environment variable is required for Hugging Face model download");
  }

  assertCurrentGeneration(generation);

  updateLifecycleState({
    phase: "creating",
    message: `Creating Vast.ai instance from offer ${offerId}...`,
    provisioning: true,
    instanceId: null,
    offerId,
    pollAttempt: null,
    lastError: null,
  });

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

  activeInstance = {
    id: instanceId,
    ip: null,
    port: 8000,
    status: "pending",
    createdAt: new Date(),
    lastActivity: new Date(),
  };
  resetReferenceState(activeInstance.id, "unknown");

  updateLifecycleState({
    phase: "polling",
    message: `Instance ${instanceId} created. Waiting for the API port to come online...`,
    provisioning: true,
    instanceId,
    offerId,
    pollAttempt: 0,
    lastError: null,
  });

  if (generation !== instanceStartupGeneration) {
    await destroyInstance(instanceId).catch(() => {});
    throw new Error("Stale instance provisioning request");
  }

  // Poll for instance to be running and get IP/port
  const instanceInfo = await pollInstanceReady(instanceId, generation);

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
  setLifecycleRunning(`GPU instance ${activeInstance.id} is ready.`, activeInstance);

  // Start inactivity timer (60 minutes)
  resetInactivityTimer();

  return waitForHealthyService(activeInstance);
}

/**
 * Poll instance until it's running and has ports mapped
 */
async function pollInstanceReady(instanceId: string, generation: number, maxAttempts = 30): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    assertCurrentGeneration(generation);
    console.log(`[VastTTS] Polling instance ${instanceId}, attempt ${attempt + 1}/${maxAttempts}`);
    updateLifecycleState({
      phase: "polling",
      message: `Waiting for instance ${instanceId} to become reachable (${attempt + 1}/${maxAttempts})...`,
      provisioning: true,
      instanceId,
      pollAttempt: attempt + 1,
    });
    
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
 * Find and adopt any existing managed TTS instance, even if it is still provisioning.
 */
export async function findAndAdoptExistingInstance(): Promise<VastInstance | null> {
  console.log("[VastTTS] Checking for existing managed instances...");
  updateLifecycleState({
    phase: "checking",
    message: "Checking Vast.ai for an existing TTS instance...",
    provisioning: true,
    instanceId: null,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
  });

  try {
    const instances = await listUserInstances();
    const preferredId = activeInstance?.id || lifecycleState.instanceId;
    const managedInstances = instances
      .filter((inst: any) => isManagedTtsApiInstance(inst) && !isTerminalInstanceStatus(inst.actual_status))
      .sort((a: any, b: any) => {
        if (preferredId) {
          if (a.id.toString() === preferredId) return -1;
          if (b.id.toString() === preferredId) return 1;
        }
        if (isRunningReachableInstance(a) && !isRunningReachableInstance(b)) return -1;
        if (!isRunningReachableInstance(a) && isRunningReachableInstance(b)) return 1;
        return (a.start_date || 0) - (b.start_date || 0);
      });

    console.log(`[VastTTS] Found ${managedInstances.length} managed TTS instances`);

    const candidate = managedInstances[0];
    if (!candidate) {
      console.log("[VastTTS] No existing managed instances found");
      return null;
    }

    const adoptedInstance = toVastInstance(candidate);
    activeInstance = adoptedInstance;
    resetReferenceState(adoptedInstance.id, "unknown");

    if (isRunningReachableInstance(candidate)) {
      setLifecycleRunning(`Using existing GPU instance ${adoptedInstance.id}.`, adoptedInstance);
      resetInactivityTimer();
      console.log(`[VastTTS] Adopted reachable instance ${adoptedInstance.id}`);
      return adoptedInstance;
    }

    updateLifecycleState({
      phase: "polling",
      message: `Adopted provisioning instance ${adoptedInstance.id}. Waiting for it to become reachable...`,
      provisioning: true,
      instanceId: adoptedInstance.id,
      offerId: null,
      searchRound: null,
      pollAttempt: null,
      lastError: null,
    });
    console.log(`[VastTTS] Adopted provisioning instance ${adoptedInstance.id}`);
    return adoptedInstance;
  } catch (error) {
    console.error("[VastTTS] Error listing instances:", error);
    setLifecycleError(error instanceof Error ? error.message : "Failed to inspect existing Vast.ai instances.");
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

async function waitForHealthyService(instance: VastInstance, maxAttempts = 12): Promise<VastInstance> {
  const previousInstance = activeInstance;
  activeInstance = instance;

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const healthy = await healthCheck();
      if (healthy) {
        activeInstance = {
          ...instance,
          status: "running",
          lastActivity: new Date(),
        };
        setLifecycleRunning(`GPU instance ${instance.id} is healthy and ready.`, activeInstance);
        resetInactivityTimer();
        return activeInstance;
      }

      updateLifecycleState({
        phase: "polling",
        message: `Waiting for the TTS service on instance ${instance.id} to become healthy (${attempt + 1}/${maxAttempts})...`,
        provisioning: true,
        instanceId: instance.id,
        pollAttempt: attempt + 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } finally {
    if (activeInstance?.id !== instance.id) {
      activeInstance = previousInstance;
    }
  }

  throw new Error(`Instance ${instance.id} is reachable but the TTS service is not healthy yet.`);
}

async function continueProvisioningInstance(instance: VastInstance, generation: number): Promise<VastInstance> {
  const readyInfo = await pollInstanceReady(instance.id, generation);
  activeInstance = {
    id: instance.id,
    ip: readyInfo.public_ipaddr || null,
    port: readyInfo.apiPort || 8000,
    status: "running",
    createdAt: instance.createdAt,
    lastActivity: new Date(),
    gpuName: readyInfo.gpu_name,
    hourlyRate: readyInfo.dph_total,
  };
  resetReferenceState(activeInstance.id, activeReferenceState.mode);
  return waitForHealthyService(activeInstance);
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
  updateLifecycleState({
    phase: "stopping",
    message: `Stopping GPU instance ${instanceId}...`,
    provisioning: true,
    instanceId,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
  });

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
  setLifecycleIdle(`GPU instance ${instanceId} stopped.`);
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
    if (activeReferenceState.mode === "builtin") {
      return { applied: true, requiresBuiltinReset: false };
    }

    await clearVoiceReferenceOnInstance(activeInstance);
    setLifecycleRunning("GPU instance ready with builtin voice.", activeInstance);
    return {
      applied: true,
      requiresBuiltinReset: false,
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

export async function recreateInstance(): Promise<VastInstance> {
  instanceStartupGeneration += 1;
  instanceStartupPromise = null;
  clearInactivityTimer();

  updateLifecycleState({
    phase: "stopping",
    message: "Destroying existing Vast.ai TTS instances before requesting a new one...",
    provisioning: true,
    instanceId: activeInstance?.id || lifecycleState.instanceId,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
  });

  const instances = await listUserInstances();
  const managedInstances = instances.filter((inst: any) => isManagedTtsApiInstance(inst) && !isTerminalInstanceStatus(inst.actual_status));

  for (const instance of managedInstances) {
    try {
      await destroyInstance(instance.id.toString());
    } catch (error) {
      console.error(`[VastTTS] Failed to destroy instance ${instance.id} during recreate:`, error);
    }
  }

  activeInstance = null;
  resetReferenceState();
  setLifecycleIdle("Previous GPU instances cleared. Requesting a fresh instance...");

  return startCheapestInstance({ forceNew: true });
}

/**
 * Get active instance info
 */
export function getActiveInstance(): VastInstance | null {
  return activeInstance;
}

export function getLifecycleState(): TtsLifecycleState {
  return lifecycleState;
}

async function startCheapestInstanceInternal(generation: number): Promise<VastInstance> {
  // Second, check Vast.ai API for any running instances we might have lost track of
  const adoptedInstance = await findAndAdoptExistingInstance();
  if (adoptedInstance) {
    if (adoptedInstance.status === "pending" || !adoptedInstance.ip) {
      return continueProvisioningInstance(adoptedInstance, generation);
    }

    return waitForHealthyService(adoptedInstance);
  }

  console.log("[VastTTS] No existing healthy instances found, creating new one...");

  // Try multiple search rounds - offers disappear quickly
  for (let searchRound = 0; searchRound < 3; searchRound++) {
    if (searchRound > 0) {
      console.log(`[VastTTS] Search round ${searchRound + 1}/3...`);
      await new Promise(r => setTimeout(r, 1000)); // Brief pause between searches
    }

    updateLifecycleState({
      phase: "searching",
      message: `Searching Vast.ai offers for a compatible GPU (${searchRound + 1}/3)...`,
      provisioning: true,
      instanceId: null,
      offerId: null,
      searchRound: searchRound + 1,
      pollAttempt: null,
      lastError: null,
    });

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
        const instance = await createInstance(offer.id.toString(), generation);
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
 * Start the cheapest available GPU instance
 * Uses aggressive retry strategy due to competitive marketplace
 * Checks for existing healthy instance first before creating new one
 */
export async function startCheapestInstance(options?: { forceNew?: boolean }): Promise<VastInstance> {
  const forceNew = options?.forceNew ?? false;

  if (!forceNew && instanceStartupPromise) {
    console.log("[VastTTS] Awaiting in-flight instance startup...");
    updateLifecycleState({
      phase: lifecycleState.phase,
      message: lifecycleState.message || "Waiting for the active Vast.ai startup request to finish...",
      provisioning: true,
    });
    return instanceStartupPromise;
  }

  if (!forceNew && activeInstance) {
    if (activeInstance.status === "pending" || !activeInstance.ip) {
      console.log(`[VastTTS] Waiting for tracked provisioning instance ${activeInstance.id}...`);
      updateLifecycleState({
        phase: "polling",
        message: `Waiting for tracked instance ${activeInstance.id} to finish provisioning...`,
        provisioning: true,
        instanceId: activeInstance.id,
        offerId: null,
        searchRound: null,
        pollAttempt: lifecycleState.pollAttempt,
      });
      const generation = ++instanceStartupGeneration;
      instanceStartupPromise = continueProvisioningInstance(activeInstance, generation)
        .catch((error) => {
          const message = error instanceof Error ? error.message : "Failed to provision a Vast.ai GPU instance.";
          if (message !== "Stale instance provisioning request") {
            setLifecycleError(message);
          }
          throw error;
        })
        .finally(() => {
          instanceStartupPromise = null;
        });
      return instanceStartupPromise;
    }

    console.log("[VastTTS] Checking if existing active instance is healthy...");
    const isHealthy = await healthCheck();

    if (isHealthy) {
      console.log(`[VastTTS] Adopting existing healthy instance: ${activeInstance.id}`);
      activeInstance.lastActivity = new Date();
      setLifecycleRunning(`GPU instance ${activeInstance.id} is healthy and ready.`, activeInstance);
      resetInactivityTimer();
      return activeInstance;
    }

    console.log(`[VastTTS] Existing instance ${activeInstance.id} is not healthy yet; waiting instead of creating another.`);
    const generation = ++instanceStartupGeneration;
    instanceStartupPromise = waitForHealthyService(activeInstance)
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Tracked GPU instance is not healthy.";
        if (message !== "Stale instance provisioning request") {
          setLifecycleError(message);
        }
        throw error;
      })
      .finally(() => {
        if (generation === instanceStartupGeneration) {
          instanceStartupPromise = null;
        }
      });
    return instanceStartupPromise;
  }

  const generation = ++instanceStartupGeneration;
  instanceStartupPromise = startCheapestInstanceInternal(generation)
    .catch((error) => {
      const message = error instanceof Error ? error.message : "Failed to provision a Vast.ai GPU instance.";
      if (message !== "Stale instance provisioning request") {
        setLifecycleError(message);
      }
      throw error;
    })
    .finally(() => {
      if (generation === instanceStartupGeneration) {
        instanceStartupPromise = null;
      }
    });

  return instanceStartupPromise;
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
    const managedInstances = instances.filter((inst: any) => isManagedTtsApiInstance(inst) && !isTerminalInstanceStatus(inst.actual_status));

    if (managedInstances.length === 0) {
      console.log("[VastTTS] Cleanup: No managed instances found");
      return;
    }
    
    console.log(`[VastTTS] Cleanup: Found ${managedInstances.length} managed TTS instances`);

    const preferredId = activeInstance?.id || lifecycleState.instanceId;
    const sortedInstances = [...managedInstances].sort((a: any, b: any) => {
      if (preferredId) {
        if (a.id.toString() === preferredId) return -1;
        if (b.id.toString() === preferredId) return 1;
      }
      if (isRunningReachableInstance(a) && !isRunningReachableInstance(b)) return -1;
      if (!isRunningReachableInstance(a) && isRunningReachableInstance(b)) return 1;
      return (a.start_date || 0) - (b.start_date || 0);
    });

    const instanceToKeep = sortedInstances[0];
    if (!instanceToKeep) {
      return;
    }

    activeInstance = toVastInstance(instanceToKeep);
    resetReferenceState(activeInstance.id, "unknown");
    if (activeInstance.status === "running") {
      setLifecycleRunning(`Using existing GPU instance ${activeInstance.id}.`, activeInstance);
    } else {
      updateLifecycleState({
        phase: "polling",
        message: `Tracked GPU instance ${activeInstance.id} is still provisioning...`,
        provisioning: true,
        instanceId: activeInstance.id,
        offerId: null,
        searchRound: null,
        pollAttempt: null,
        lastError: null,
      });
    }
    resetInactivityTimer();

    for (const instance of sortedInstances.slice(1)) {
      const id = instance.id.toString();
      if (id !== activeInstance.id) {
        try {
          console.log(`[VastTTS] Cleanup: Destroying duplicate instance ${id}`);
          await destroyInstance(id);
        } catch (err) {
          console.error(`[VastTTS] Cleanup: Failed to destroy instance ${id}:`, err);
        }
      }
    }
    
    console.log(`[VastTTS] Cleanup: Kept instance ${activeInstance.id}, destroyed ${Math.max(0, sortedInstances.length - 1)} duplicates`);
    
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
  getLifecycleState,
  markVoiceReferenceAsStale,
  recreateInstance,
  startCheapestInstance,
  stopInstance,
  cleanupDuplicateInstances,
};
