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
  excludedMachineIds: string[];
}

export interface TtsStatusSnapshot {
  active: boolean;
  status: string;
  healthy: boolean;
  lifecycle: TtsLifecycleState;
  accountBalance: number | null;
  instance?: {
    id: string;
    ip: string | null;
    port: number;
    gpuName?: string;
    hourlyRate?: number;
    machineId?: string;
    createdAt: string;
    lastActivity: string;
  };
}

type DestroyReason = "manual-stop" | "manual-recreate" | "idle-timeout" | "duplicate-cleanup" | "stale-startup";

// In-memory instance state (would be persisted to DB in production)
let activeInstance: VastInstance | null = null;
let instanceStartupPromise: Promise<VastInstance> | null = null;
let instanceStartupGeneration = 0;
let inactivityTimer: Timer | null = null;
let ttsServiceRequestQueue: Promise<void> = Promise.resolve();
let activeTtsServiceRequest: "health" | "tts" | "reference" | null = null;
let lastKnownServiceHealth = false;
let recentMachineIds: string[] = [];
let accountBalanceCache: { value: number | null; updatedAt: number } = { value: null, updatedAt: 0 };
const statusSubscribers = new Set<(snapshot: TtsStatusSnapshot) => void>();
const INACTIVITY_TIMEOUT = 60 * 60 * 1000; // 60 minutes
const ACCOUNT_BALANCE_CACHE_MS = 60 * 1000;
const RECENT_MACHINE_HISTORY_LIMIT = 3;
const INSTANCE_READY_MAX_ATTEMPTS = 42; // ~7 minutes
const INSTANCE_READY_POLL_MS = 10000;
const HEALTH_WARMUP_MAX_ATTEMPTS = 18; // ~3 minutes
const HEALTH_WARMUP_POLL_MS = 10000;
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
  excludedMachineIds: [],
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

function statusInstanceFromActive(instance: VastInstance | null) {
  if (!instance) return undefined;

  return {
    id: instance.id,
    ip: instance.ip,
    port: instance.port,
    gpuName: instance.gpuName,
    hourlyRate: instance.hourlyRate,
    machineId: instance.machineId,
    createdAt: instance.createdAt.toISOString(),
    lastActivity: instance.lastActivity.toISOString(),
  };
}

export function getStatusSnapshot(): TtsStatusSnapshot {
  return {
    active: Boolean(activeInstance && activeInstance.status === "running" && activeInstance.ip),
    status: lifecycleState.phase === "idle" ? "stopped" : lifecycleState.phase,
    healthy: lastKnownServiceHealth,
    lifecycle: lifecycleState,
    accountBalance: accountBalanceCache.value,
    instance: statusInstanceFromActive(activeInstance),
  };
}

export async function getStatusSnapshotWithBalance(forceRefresh = false): Promise<TtsStatusSnapshot> {
  await refreshAccountBalance(forceRefresh);
  return getStatusSnapshot();
}

function emitStatusUpdate() {
  const snapshot = getStatusSnapshot();
  for (const subscriber of statusSubscribers) {
    try {
      subscriber(snapshot);
    } catch {
      // Ignore subscriber failures.
    }
  }
}

export function subscribeStatusUpdates(subscriber: (snapshot: TtsStatusSnapshot) => void) {
  statusSubscribers.add(subscriber);
  return () => {
    statusSubscribers.delete(subscriber);
  };
}

function resetReferenceState(instanceId: string | null = null, mode: ActiveReferenceState["mode"] = "unknown") {
  activeReferenceState = {
    instanceId,
    mode,
    voiceId: null,
  };
}

function updateLifecycleState(patch: Partial<TtsLifecycleState>) {
  const nextState: TtsLifecycleState = {
    ...lifecycleState,
    ...patch,
    updatedAt: Date.now(),
  };

  const changed =
    nextState.phase !== lifecycleState.phase ||
    nextState.message !== lifecycleState.message ||
    nextState.provisioning !== lifecycleState.provisioning ||
    nextState.instanceId !== lifecycleState.instanceId ||
    nextState.offerId !== lifecycleState.offerId ||
    nextState.searchRound !== lifecycleState.searchRound ||
    nextState.pollAttempt !== lifecycleState.pollAttempt ||
    nextState.lastError !== lifecycleState.lastError ||
    JSON.stringify(nextState.excludedMachineIds) !== JSON.stringify(lifecycleState.excludedMachineIds);

  if (!changed) {
    return;
  }

  lifecycleState = nextState;
  emitStatusUpdate();
}

function setLifecycleRunning(message: string, instance?: VastInstance | null) {
  lastKnownServiceHealth = true;
  updateLifecycleState({
    phase: "running",
    message,
    provisioning: false,
    instanceId: instance?.id || activeInstance?.id || null,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
    excludedMachineIds: [],
  });
}

function setLifecycleIdle(message: string = "No GPU instance is active.") {
  lastKnownServiceHealth = false;
  updateLifecycleState({
    phase: "idle",
    message,
    provisioning: false,
    instanceId: null,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
    excludedMachineIds: [],
  });
}

function setLifecycleError(message: string) {
  lastKnownServiceHealth = false;
  updateLifecycleState({
    phase: "error",
    message,
    provisioning: false,
    lastError: message,
  });
}

function rememberMachineId(machineId?: string) {
  if (!machineId) return;
  recentMachineIds = [machineId, ...recentMachineIds.filter((id) => id !== machineId)].slice(0, RECENT_MACHINE_HISTORY_LIMIT);
}

async function refreshAccountBalance(force = false): Promise<number | null> {
  if (!force && Date.now() - accountBalanceCache.updatedAt < ACCOUNT_BALANCE_CACHE_MS) {
    return accountBalanceCache.value;
  }

  try {
    const response = await fetch(`${VAST_API_URL}/users/current/`, {
      headers: {
        Authorization: `Bearer ${VAST_API_KEY}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch account balance: ${response.statusText}`);
    }

    const data = await response.json();
    accountBalanceCache = {
      value: typeof data?.balance === "number" ? data.balance : null,
      updatedAt: Date.now(),
    };
    emitStatusUpdate();
    return accountBalanceCache.value;
  } catch {
    return accountBalanceCache.value;
  }
}

function getMachineId(value: any): string | undefined {
  const machineId = value?.machine_id ?? value?.machineId ?? value?.host_id ?? value?.hostId ?? value?.machine;
  if (machineId === undefined || machineId === null) return undefined;
  return String(machineId);
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
    machineId: getMachineId(instance),
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

async function runExclusiveTtsServiceRequest<T>(
  kind: "health" | "tts" | "reference",
  task: () => Promise<T>,
): Promise<T> {
  const previous = ttsServiceRequestQueue;
  let release!: () => void;
  ttsServiceRequestQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  activeTtsServiceRequest = kind;

  try {
    return await task();
  } finally {
    activeTtsServiceRequest = null;
    release();
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

  await runExclusiveTtsServiceRequest("reference", async () => {
    const response = await fetch(`${getInstanceBaseUrl(instance)}/reference`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to apply voice reference: ${errorText}`);
    }
  });

  activeReferenceState = {
    instanceId: instance.id,
    mode: "custom",
    voiceId: voiceReference.id,
  };
  lastKnownServiceHealth = true;
}

async function clearVoiceReferenceOnInstance(instance: VastInstance) {
  await runExclusiveTtsServiceRequest("reference", async () => {
    const response = await fetch(`${getInstanceBaseUrl(instance)}/reference`, {
      method: "DELETE",
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to clear voice reference: ${errorText}`);
    }
  });

  activeReferenceState = {
    instanceId: instance.id,
    mode: "builtin",
    voiceId: null,
  };
  lastKnownServiceHealth = true;
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
    setLifecycleRunning("GPU instance ready.", instance);
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
  setLifecycleRunning("GPU instance ready.", instance);
  return instance;
}

/**
 * Search for best GPU instances available on Vast.ai
 * Uses filters from the verified working README
 * Tries both on-demand and interruptible (spot) instances
 */
export async function searchBestGPU(excludedMachineIds: Set<string> = new Set()): Promise<any[]> {
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
      gpu_ram: { gte: 10240 },
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
      const filteredOffers = offers.filter((offer: any) => !excludedMachineIds.has(getMachineId(offer) || ""));
      console.log(`[VastTTS] Found ${filteredOffers.length} interruptible offers after machine filtering`);
      return filteredOffers;
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
      gpu_ram: { gte: 10240 },
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
  const filteredOffers = offers.filter((offer: any) => !excludedMachineIds.has(getMachineId(offer) || ""));
  
  console.log(`[VastTTS] Found ${filteredOffers.length} on-demand offers after machine filtering`);
  return filteredOffers;
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
    message: "Requesting a GPU instance...",
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
    machineId: undefined,
  };
  resetReferenceState(activeInstance.id, "unknown");
  emitStatusUpdate();

  updateLifecycleState({
    phase: "polling",
    message: "Provisioning GPU instance...",
    provisioning: true,
    instanceId,
    offerId,
    pollAttempt: 0,
    lastError: null,
  });

  if (generation !== instanceStartupGeneration) {
    await destroyInstance(instanceId, { reason: "stale-startup" }).catch(() => {});
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
    machineId: getMachineId(instanceInfo),
    gpuName: instanceInfo.gpu_name,
    hourlyRate: instanceInfo.dph_total,
  };

  resetReferenceState(activeInstance.id, "builtin");
  updateLifecycleState({
    phase: "polling",
    message: "Warming up TTS service...",
    provisioning: true,
    instanceId: activeInstance.id,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
  });
  emitStatusUpdate();

  // Start inactivity timer (60 minutes)
  resetInactivityTimer();

  return waitForHealthyService(activeInstance);
}

/**
 * Poll instance until it's running and has ports mapped
 */
async function pollInstanceReady(instanceId: string, generation: number, maxAttempts = INSTANCE_READY_MAX_ATTEMPTS): Promise<any> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    assertCurrentGeneration(generation);
    console.log(`[VastTTS] Polling instance ${instanceId}, attempt ${attempt + 1}/${maxAttempts}`);
    updateLifecycleState({
      phase: "polling",
      message: "Provisioning GPU instance...",
      provisioning: true,
      instanceId,
      pollAttempt: Math.floor((attempt + 1) / 6),
    });
    
    const response = await fetch(`${VAST_API_URL}/instances/${instanceId}/`, {
      headers: {
        Authorization: `Bearer ${VAST_API_KEY}`,
      },
    });

    if (!response.ok) {
      await new Promise((r) => setTimeout(r, INSTANCE_READY_POLL_MS));
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
    await new Promise((r) => setTimeout(r, INSTANCE_READY_POLL_MS));
  }

  throw new Error(`Instance ${instanceId} did not become reachable within 7 minutes.`);
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

export async function getInstanceDetails(instanceId: string): Promise<any | null> {
  const response = await fetch(`${VAST_API_URL}/instances/${instanceId}/`, {
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
    },
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch instance ${instanceId}: ${error}`);
  }

  return await response.json();
}

export async function requestInstanceLogs(instanceId: string, tail: number = 400): Promise<string> {
  const response = await fetch(`${VAST_API_URL}/instances/request_logs/${instanceId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${VAST_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tail: String(tail) }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to request instance logs: ${error}`);
  }

  const data = await response.json();
  const logUrl =
    data?.url ||
    data?.log_url ||
    data?.logs_url ||
    data?.result_url ||
    data?.result?.url ||
    data?.result?.log_url;

  if (!logUrl || typeof logUrl !== "string") {
    throw new Error("Vast.ai did not return a log URL.");
  }

  const logResponse = await fetch(logUrl);
  if (!logResponse.ok) {
    throw new Error(`Failed to download instance logs: ${logResponse.statusText}`);
  }

  return await logResponse.text();
}

async function selectManagedInstance(preferredInstanceId?: string | null): Promise<VastInstance | null> {
  const instances = await fetchManagedInstances();
  if (instances.length === 0) {
    activeInstance = null;
    emitStatusUpdate();
    return null;
  }

  const preferredId = preferredInstanceId || activeInstance?.id || lifecycleState.instanceId;
  const sortedInstances = [...instances].sort((a: any, b: any) => {
    if (preferredId) {
      if (a.id.toString() === preferredId) return -1;
      if (b.id.toString() === preferredId) return 1;
    }
    if (isRunningReachableInstance(a) && !isRunningReachableInstance(b)) return -1;
    if (!isRunningReachableInstance(a) && isRunningReachableInstance(b)) return 1;
    return (a.start_date || 0) - (b.start_date || 0);
  });

  const kept = sortedInstances[0];
  if (!kept) {
    activeInstance = null;
    emitStatusUpdate();
    return null;
  }

  const nextActiveInstance = toVastInstance(kept);
  activeInstance = nextActiveInstance;
  resetReferenceState(nextActiveInstance.id, activeReferenceState.mode);
  emitStatusUpdate();

  for (const duplicate of sortedInstances.slice(1)) {
    if (preferredId && duplicate.id.toString() === preferredId) {
      continue;
    }
    try {
      rememberMachineId(getMachineId(duplicate));
      console.log(`[VastTTS] Destroying duplicate managed instance ${duplicate.id} [reason=duplicate-cleanup]`);
      await destroyInstance(duplicate.id.toString(), { preserveLifecycle: true, reason: "duplicate-cleanup" });
    } catch (error) {
      console.error(`[VastTTS] Failed to destroy duplicate instance ${duplicate.id}:`, error);
    }
  }

  return nextActiveInstance;
}

async function adoptTrackedInstanceIfPresent(): Promise<VastInstance | null> {
  const trackedInstanceId = activeInstance?.id || lifecycleState.instanceId;
  if (!trackedInstanceId) return null;

  const details = await getInstanceDetails(trackedInstanceId);
  if (!details || isTerminalInstanceStatus(details.actual_status)) {
    return null;
  }

  const trackedInstance = toVastInstance(details);
  activeInstance = trackedInstance;
  resetReferenceState(trackedInstance.id, activeReferenceState.mode);
  emitStatusUpdate();
  return trackedInstance;
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
    const candidate = await selectManagedInstance(activeInstance?.id || lifecycleState.instanceId);
    if (!candidate) {
      console.log("[VastTTS] No existing managed instances found");
      return null;
    }

    if (candidate.status === "running" && candidate.ip) {
      updateLifecycleState({
        phase: "running",
        message: "GPU instance ready.",
        provisioning: false,
        instanceId: candidate.id,
        offerId: null,
        searchRound: null,
        pollAttempt: null,
        lastError: null,
      });
      console.log(`[VastTTS] Adopted reachable instance ${candidate.id}`);
      return candidate;
    }

    updateLifecycleState({
      phase: "polling",
      message: "Provisioning GPU instance...",
      provisioning: true,
      instanceId: candidate.id,
      offerId: null,
      searchRound: null,
      pollAttempt: null,
      lastError: null,
    });
    console.log(`[VastTTS] Adopted provisioning instance ${candidate.id}`);
    return candidate;
  } catch (error) {
    console.error("[VastTTS] Error listing instances:", error);
    updateLifecycleState({
      phase: lifecycleState.phase,
      message: lifecycleState.message,
      provisioning: lifecycleState.provisioning,
      instanceId: lifecycleState.instanceId,
      offerId: null,
      searchRound: null,
      pollAttempt: null,
      lastError: error instanceof Error ? error.message : "Failed to inspect existing Vast.ai instances.",
    });
    throw error;
  }
}

async function fetchManagedInstances(): Promise<any[]> {
  const instances = await listUserInstances();
  return instances.filter((inst: any) => isManagedTtsApiInstance(inst) && !isTerminalInstanceStatus(inst.actual_status));
}

/**
 * Check if the TTS service is healthy
 */
export async function healthCheck(options?: { useCachedWhileBusy?: boolean }): Promise<boolean> {
  if (!activeInstance?.ip || !activeInstance?.port) {
    return false;
  }

  const currentInstance = activeInstance;
  if (!currentInstance?.ip || !currentInstance?.port) {
    return false;
  }

  const useCachedWhileBusy = options?.useCachedWhileBusy ?? true;
  if (useCachedWhileBusy && activeTtsServiceRequest && activeTtsServiceRequest !== "health") {
    return lastKnownServiceHealth;
  }

  try {
    return await runExclusiveTtsServiceRequest("health", async () => {
      const response = await fetch(
        `http://${currentInstance.ip}:${currentInstance.port}/healthz`,
        {
          signal: AbortSignal.timeout(15000),
        }
      );

      if (response.ok) {
        const data = await response.json();
        lastKnownServiceHealth = data.status === "ok";
        return lastKnownServiceHealth;
      }

      lastKnownServiceHealth = false;
      return false;
    });
  } catch {
    lastKnownServiceHealth = false;
    return false;
  }
}

async function waitForHealthyService(instance: VastInstance, maxAttempts = HEALTH_WARMUP_MAX_ATTEMPTS): Promise<VastInstance> {
  const previousInstance = activeInstance;
  activeInstance = instance;
  emitStatusUpdate();

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const healthy = await healthCheck({ useCachedWhileBusy: false });
      if (healthy) {
        activeInstance = {
          ...instance,
          status: "running",
          lastActivity: new Date(),
        };
        setLifecycleRunning("GPU instance ready.", activeInstance);
        resetInactivityTimer();
        emitStatusUpdate();
        return activeInstance;
      }

      updateLifecycleState({
        phase: "polling",
        message: "Warming up TTS service...",
        provisioning: true,
        instanceId: instance.id,
        pollAttempt: Math.floor((attempt + 1) / 6),
      });
      await new Promise((resolve) => setTimeout(resolve, HEALTH_WARMUP_POLL_MS));
    }
  } finally {
    if (activeInstance?.id !== instance.id) {
      activeInstance = previousInstance;
      emitStatusUpdate();
    }
  }

  throw new Error(`Instance ${instance.id} is still warming up. You can wait longer or recreate it manually.`);
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
    machineId: getMachineId(readyInfo) || instance.machineId,
    gpuName: readyInfo.gpu_name,
    hourlyRate: readyInfo.dph_total,
  };
  resetReferenceState(activeInstance.id, activeReferenceState.mode);
  emitStatusUpdate();
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

  const audioBuffer = await runExclusiveTtsServiceRequest("tts", async () => {
    let response: Response | null = null;
    let lastError: string | null = null;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        response = await fetch(
          `${getInstanceBaseUrl(instance)}/tts`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              text: request.text,
            }),
            signal: AbortSignal.timeout(180000),
          }
        );

        if (response.ok) {
          lastKnownServiceHealth = true;
          return await response.arrayBuffer();
        }

        lastError = await response.text();
        if (attempt < 2) {
          updateLifecycleState({
            phase: "polling",
            message: "Warming up TTS service...",
            provisioning: true,
            instanceId: instance.id,
            offerId: null,
            searchRound: null,
            pollAttempt: null,
            lastError,
          });
          await new Promise((resolve) => setTimeout(resolve, 2500));
          continue;
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : "Unknown TTS request error";
        if (attempt < 2) {
          updateLifecycleState({
            phase: "polling",
            message: "Warming up TTS service...",
            provisioning: true,
            instanceId: instance.id,
            offerId: null,
            searchRound: null,
            pollAttempt: null,
            lastError,
          });
          await new Promise((resolve) => setTimeout(resolve, 2500));
          continue;
        }
      }
    }

    lastKnownServiceHealth = false;
    throw new Error(`TTS generation failed: ${lastError || "Unknown error"}`);
  });

  // Get raw audio data and convert to base64
  const audioBase64 = Buffer.from(audioBuffer).toString('base64');
  
  // Estimate duration (rough calculation for 24kHz mono)
  // WAV header is 44 bytes, rest is PCM data
  const audioDataSize = audioBuffer.byteLength - 44;
  const duration = audioDataSize / (24000 * 2); // 24kHz, 16-bit = 2 bytes per sample

  setLifecycleRunning("GPU instance ready.", instance);

  return {
    audio: audioBase64,
    duration: Math.max(0, duration),
    sampleRate: 24000,
  };
}

/**
 * Destroy a Vast.ai instance
 */
export async function destroyInstance(instanceId: string, options?: { preserveLifecycle?: boolean; reason?: DestroyReason }): Promise<void> {
  const reason = options?.reason || "manual-stop";
  if (!options?.preserveLifecycle) {
    updateLifecycleState({
      phase: "stopping",
      message: "Stopping GPU instance...",
      provisioning: true,
      instanceId,
      offerId: null,
      searchRound: null,
      pollAttempt: null,
      lastError: null,
    });
  }

  const currentMachineId = activeInstance?.id === instanceId ? activeInstance.machineId : undefined;

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
    rememberMachineId(currentMachineId);
    activeInstance = null;
    resetReferenceState();
    clearInactivityTimer();
    emitStatusUpdate();
  }

  console.log(`[VastTTS] Instance ${instanceId} destroyed [reason=${reason}]`);
  if (!options?.preserveLifecycle) {
    setLifecycleIdle("No GPU instance is active.");
  }
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
    setLifecycleRunning("GPU instance ready.", activeInstance);
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
  await destroyInstance(instanceId, { reason: "manual-stop" });
}

function getRecentMachineIdsToAvoid(extraMachineIds: string[] = []): Set<string> {
  return new Set([...recentMachineIds, ...extraMachineIds].slice(0, RECENT_MACHINE_HISTORY_LIMIT));
}

export async function recreateInstance(): Promise<VastInstance> {
  instanceStartupGeneration += 1;
  instanceStartupPromise = null;
  clearInactivityTimer();

  const instances = await fetchManagedInstances();
  const machineIdsToRemember = instances
    .map((instance: any) => getMachineId(instance))
    .filter((machineId): machineId is string => Boolean(machineId));
  machineIdsToRemember.forEach((machineId) => rememberMachineId(machineId));

  if (activeInstance?.machineId) {
    rememberMachineId(activeInstance.machineId);
  }

  const excludedMachineIds = getRecentMachineIdsToAvoid();

  updateLifecycleState({
    phase: "stopping",
    message: "Stopping current GPU instance...",
    provisioning: true,
    instanceId: activeInstance?.id || lifecycleState.instanceId,
    offerId: null,
    searchRound: null,
    pollAttempt: null,
    lastError: null,
    excludedMachineIds: [...excludedMachineIds],
  });

  for (const instance of instances) {
    try {
      await destroyInstance(instance.id.toString(), { reason: "manual-recreate" });
    } catch (error) {
      console.error(`[VastTTS] Failed to destroy instance ${instance.id} during recreate:`, error);
    }
  }

  activeInstance = null;
  resetReferenceState();
  emitStatusUpdate();

  return startCheapestInstance({ forceNew: true, excludedMachineIds });
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

async function startCheapestInstanceInternal(
  generation: number,
  excludedMachineIds: Set<string> = new Set(),
  options?: { skipAdoptExisting?: boolean },
): Promise<VastInstance> {
  if (!options?.skipAdoptExisting) {
    const trackedInstance = await adoptTrackedInstanceIfPresent();
    if (trackedInstance) {
      if (trackedInstance.status === "pending" || !trackedInstance.ip) {
        updateLifecycleState({
          phase: "polling",
          message: "Provisioning GPU instance...",
          provisioning: true,
          instanceId: trackedInstance.id,
          offerId: null,
          searchRound: null,
          pollAttempt: null,
          lastError: null,
        });
        return continueProvisioningInstance(trackedInstance, generation);
      }

      return waitForHealthyService(trackedInstance);
    }

    const adoptedInstance = await findAndAdoptExistingInstance();
    if (adoptedInstance) {
      if (adoptedInstance.status === "pending" || !adoptedInstance.ip) {
        return continueProvisioningInstance(adoptedInstance, generation);
      }

      return waitForHealthyService(adoptedInstance);
    }
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
      message: "Searching Vast.ai for a compatible GPU...",
      provisioning: true,
      instanceId: null,
      offerId: null,
      searchRound: null,
      pollAttempt: null,
      lastError: null,
      excludedMachineIds: [...excludedMachineIds],
    });

    const offers = await searchBestGPU(excludedMachineIds);

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
export async function startCheapestInstance(options?: { forceNew?: boolean; excludedMachineIds?: Set<string> }): Promise<VastInstance> {
  const forceNew = options?.forceNew ?? false;
  const excludedMachineIds = options?.excludedMachineIds ?? new Set<string>();

  if (!forceNew && instanceStartupPromise) {
    console.log("[VastTTS] Awaiting in-flight instance startup...");
    updateLifecycleState({
      phase: lifecycleState.phase,
      message: lifecycleState.message || "Waiting for the tracked GPU instance...",
      provisioning: true,
    });
    return instanceStartupPromise;
  }

  if (!forceNew && activeInstance) {
    if (activeInstance.status === "pending" || !activeInstance.ip) {
      console.log(`[VastTTS] Waiting for tracked provisioning instance ${activeInstance.id}...`);
      updateLifecycleState({
        phase: "polling",
        message: "Provisioning GPU instance...",
        provisioning: true,
        instanceId: activeInstance.id,
        offerId: null,
        searchRound: null,
        pollAttempt: null,
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
      setLifecycleRunning("GPU instance ready.", activeInstance);
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
  instanceStartupPromise = startCheapestInstanceInternal(generation, excludedMachineIds, { skipAdoptExisting: forceNew })
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
        await destroyInstance(activeInstance.id, { reason: "idle-timeout" });
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
    const protectedInstanceId = activeInstance?.id || lifecycleState.instanceId;
    const selectedInstance = await selectManagedInstance(protectedInstanceId);

    if (!selectedInstance) {
      console.log("[VastTTS] Cleanup: No managed instances found");
      return;
    }

    if (selectedInstance.status === "running") {
      updateLifecycleState({
        phase: "running",
        message: "GPU instance ready.",
        provisioning: false,
        instanceId: selectedInstance.id,
        offerId: null,
        searchRound: null,
        pollAttempt: null,
        lastError: null,
      });
    } else {
      updateLifecycleState({
        phase: "polling",
        message: "Provisioning GPU instance...",
        provisioning: true,
        instanceId: selectedInstance.id,
        offerId: null,
        searchRound: null,
        pollAttempt: null,
        lastError: null,
      });
    }
    console.log(`[VastTTS] Cleanup: Tracking instance ${selectedInstance.id}`);
    
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
  getStatusSnapshot,
  getStatusSnapshotWithBalance,
  requestInstanceLogs,
  subscribeStatusUpdates,
  markVoiceReferenceAsStale,
  recreateInstance,
  startCheapestInstance,
  stopInstance,
  cleanupDuplicateInstances,
};
