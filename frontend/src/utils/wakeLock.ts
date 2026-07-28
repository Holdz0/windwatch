// Screen Wake Lock helper.
//
// Keeps the device screen from sleeping/locking while in a call — mobile
// browsers otherwise dim and lock the screen after the usual idle timeout even
// though audio/video is actively streaming.
//
// The lock is automatically released by the browser whenever the tab becomes
// hidden (spec behaviour), so it must be re-acquired on visibilitychange once
// the tab is visible again — otherwise leaving and returning to the tab (or the
// OS briefly showing another app) permanently drops the lock for the rest of
// the call.

let sentinel: WakeLockSentinel | null = null;
let active = false;

async function acquire(): Promise<void> {
  if (!active || sentinel || !('wakeLock' in navigator)) return;
  try {
    sentinel = await (navigator as any).wakeLock.request('screen');
    sentinel!.addEventListener('release', () => {
      // Cleared by the browser (tab hidden, battery saver, etc.) — drop our
      // reference so a later visibilitychange knows to re-acquire.
      sentinel = null;
    });
  } catch {
    // Not supported / denied — the call still works, the screen just may sleep
    sentinel = null;
  }
}

function handleVisibilityChange(): void {
  if (active && document.visibilityState === 'visible') {
    acquire();
  }
}

// Starts holding the screen awake. Safe to call multiple times.
export function startWakeLock(): void {
  if (active) return;
  active = true;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  acquire();
}

// Stops holding the screen awake and releases any active lock. Call on leaving
// the room so a background tab doesn't keep the screen on forever.
export function stopWakeLock(): void {
  active = false;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  if (sentinel) {
    sentinel.release().catch(() => {});
    sentinel = null;
  }
}
