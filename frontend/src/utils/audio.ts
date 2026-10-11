let sharedContext: AudioContext | null = null;
const elements = new Set<HTMLMediaElement>();
const blocked = new Set<HTMLMediaElement>();
let armed = false;

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
  void element.play().then(() => {
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

export function registerRemoteMediaElement(element: HTMLMediaElement): () => void {
  elements.add(element);
  return () => {
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
  window.addEventListener('pointerdown', unlockAudioPlayback, { capture: true, passive: true });
  window.addEventListener('keydown', unlockAudioPlayback, { capture: true });
}

export function resetAudioUnlock(): void {
  armed = false;
  window.removeEventListener('pointerdown', unlockAudioPlayback, { capture: true });
  window.removeEventListener('keydown', unlockAudioPlayback, { capture: true });
  elements.clear();
  blocked.clear();
  if (sharedContext) void sharedContext.close().catch(() => {});
  sharedContext = null;
}
