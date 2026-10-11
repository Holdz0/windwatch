let sentinel: WakeLockSentinel | null = null;
let active = false;
let generation = 0;
let pending = false;

async function acquire(): Promise<void> {
  if (!active || pending || sentinel || document.hidden || !navigator.wakeLock) return;
  const requestGeneration = generation;
  pending = true;
  try {
    const lock = await navigator.wakeLock.request('screen');
    if (!active || requestGeneration !== generation) { await lock.release(); return; }
    sentinel = lock;
    lock.addEventListener('release', () => { if (sentinel === lock) sentinel = null; });
  } catch { /* Battery saver and unsupported devices may deny the lock. */ }
  finally {
    pending = false;
    if (active && requestGeneration !== generation) void acquire();
  }
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'visible') void acquire();
}

export function startWakeLock(): void {
  if (active) return;
  active = true;
  generation++;
  document.addEventListener('visibilitychange', handleVisibilityChange);
  void acquire();
}

export function stopWakeLock(): void {
  active = false;
  generation++;
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  const lock = sentinel;
  sentinel = null;
  if (lock) void lock.release().catch(() => {});
}
