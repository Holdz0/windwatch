import { loadMediaPreferences } from './mediaDevices';

let sharedContext: AudioContext | null = null;
const elements = new Set<HTMLMediaElement>();
const outputElements = new Set<HTMLMediaElement>();
const blocked = new Set<HTMLMediaElement>();
let armed = false;
let outputDevice = loadMediaPreferences().speaker;
const outputJobs = new WeakMap<HTMLMediaElement, Promise<void>>();

function routeOutput(element: HTMLMediaElement, deviceId: string): Promise<void> {
  if (!element.setSinkId) return Promise.resolve();
  const job = (outputJobs.get(element) || Promise.resolve()).catch(() => {}).then(() => element.setSinkId(deviceId));
  outputJobs.set(element, job);
  return job;
}

export async function setAudioOutput(deviceId: string): Promise<void> {
  const before = outputDevice;
  const targets = outputElements.size ? [...outputElements] : [new Audio()];
  try { await Promise.all(targets.map(element => routeOutput(element, deviceId))); outputDevice = deviceId; }
  catch (error) { await Promise.allSettled(targets.map(element => routeOutput(element, before))); throw error; }
}

export function getSharedAudioContext(): AudioContext {
  if (!sharedContext || sharedContext.state === 'closed') sharedContext = new AudioContext();
  if (sharedContext.state === 'suspended') void sharedContext.resume().catch(() => {});
  return sharedContext;
}

function reportPlayback(): void {
  window.dispatchEvent(new CustomEvent('windwatch:audio-blocked', { detail: blocked.size > 0 }));
}

export function playRemoteMediaElement(element: HTMLMediaElement): void {
  const source = element.srcObject;
  void (outputJobs.get(element) || Promise.resolve()).catch(() => {}).then(() => element.play()).then(() => {
    if (!elements.has(element) || element.srcObject !== source) return;
    blocked.delete(element);
    reportPlayback();
  }).catch(error => {
    if (elements.has(element) && element.srcObject === source && error?.name === 'NotAllowedError') {
      blocked.add(element);
      reportPlayback();
    }
  });
}

export function registerAudioOutputElement(element: HTMLMediaElement): () => void {
  outputElements.add(element);
  void routeOutput(element, outputDevice).catch(async () => {
    if (!outputElements.has(element)) return;
    outputDevice = '';
    await Promise.allSettled([...outputElements].map(target => routeOutput(target, '')));
    window.dispatchEvent(new Event('windwatch:output-unavailable'));
  });
  return () => { outputElements.delete(element); };
}

export function registerRemoteMediaElement(element: HTMLMediaElement): () => void {
  elements.add(element);
  const releaseOutput = registerAudioOutputElement(element);
  return () => {
    releaseOutput();
    elements.delete(element);
    blocked.delete(element);
    reportPlayback();
  };
}

export function unlockAudioPlayback(): void {
  if (sharedContext?.state === 'suspended') void sharedContext.resume().catch(() => {});
  for (const element of elements) if (element.paused || blocked.has(element)) playRemoteMediaElement(element);
}

export function primeAudioUnlock(): void {
  if (armed) return;
  armed = true;
  outputDevice = loadMediaPreferences().speaker;
  window.addEventListener('pointerdown', unlockAudioPlayback, { capture: true, passive: true });
  window.addEventListener('keydown', unlockAudioPlayback, { capture: true });
}

export function resetAudioUnlock(): void {
  armed = false;
  window.removeEventListener('pointerdown', unlockAudioPlayback, { capture: true });
  window.removeEventListener('keydown', unlockAudioPlayback, { capture: true });
  elements.clear();
  outputElements.clear();
  blocked.clear();
  if (sharedContext) void sharedContext.close().catch(() => {});
  sharedContext = null;
}
