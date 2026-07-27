// Shared Web Audio helpers.
//
// Browsers cap the number of concurrent AudioContext instances, so the whole app
// shares a single lazily-created context instead of creating (and leaking) a new
// one on every mute toggle or per-participant analyser.

let sharedCtx: AudioContext | null = null;

export function getSharedAudioContext(): AudioContext {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    sharedCtx = new AudioContextClass();
  }
  // Contexts start suspended until a user gesture; resuming is a no-op if already running
  if (sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {});
  }
  return sharedCtx;
}

// Creates a silent audio track without requesting hardware permission.
// The oscillator is attached to the track so stopMediaTrack can shut it down.
export function createSilentAudioTrack(): MediaStreamTrack {
  const ctx = getSharedAudioContext();
  const oscillator = ctx.createOscillator();
  const dst = ctx.createMediaStreamDestination();
  oscillator.connect(dst);
  oscillator.start();
  const track = dst.stream.getAudioTracks()[0];
  track.enabled = false;
  (track as any).__windwatchOsc = oscillator;
  return track;
}

// Creates a black video track without requesting hardware permission
export function createBlackVideoTrack(): MediaStreamTrack {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  const stream = (canvas as any).captureStream
    ? (canvas as any).captureStream(1)
    : (canvas as any).mozCaptureStream(1);
  const track = stream.getVideoTracks()[0];
  track.enabled = false;
  return track;
}

// Stops a media track and shuts down the backing oscillator of synthetic silent tracks
export function stopMediaTrack(track: MediaStreamTrack | undefined | null): void {
  if (!track) return;
  track.stop();
  const osc = (track as any).__windwatchOsc;
  if (osc) {
    try {
      osc.stop();
      osc.disconnect();
    } catch {
      // oscillator already stopped
    }
  }
}

// --- Remote audio playback unlock -----------------------------------------
//
// Remote participant audio plays through an UNMUTED media element, which
// browsers refuse to autoplay without a recent user gesture. A WebRTC stream
// usually arrives a second or two after joining — by which point the transient
// activation from the "Join" click has expired — so play() is rejected and the
// participant is silent, even though their audio is being received (the speaking
// indicator, which reads the stream through Web Audio, keeps lighting up).
//
// The recovery is fully automatic and invisible: while in a room we listen for
// ANY user gesture (a click, key press or tap — all of which happen constantly
// in a call: toggling the mic, opening chat, etc.) and, on the first one, resume
// the AudioContext and (re)start every registered remote element. No prompt, no
// button — the first natural interaction makes everyone audible.

const remoteMediaElements = new Set<HTMLMediaElement>();
let gestureListenersArmed = false;

const GESTURE_EVENTS: (keyof WindowEventMap)[] = ['pointerdown', 'touchend', 'keydown', 'click'];

// Resumes the shared AudioContext and (re)plays every registered remote element.
// Invoked from the armed gesture listeners.
export function unlockAudioPlayback(): void {
  if (sharedCtx && sharedCtx.state === 'suspended') {
    sharedCtx.resume().catch(() => {});
  }
  remoteMediaElements.forEach(el => {
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  });
}

// Arms the global gesture listeners for the current room session. Called once on
// room entry so the very first user interaction unlocks audio, even if it happens
// before any stream has arrived. Idempotent.
export function primeAudioUnlock(): void {
  if (gestureListenersArmed) return;
  gestureListenersArmed = true;
  GESTURE_EVENTS.forEach(ev =>
    window.addEventListener(ev, unlockAudioPlayback, { capture: true, passive: true })
  );
}

// Registers a remote media element so a later unlock gesture can (re)start it.
// Returns an unregister function for effect cleanup.
export function registerRemoteMediaElement(el: HTMLMediaElement): () => void {
  remoteMediaElements.add(el);
  return () => { remoteMediaElements.delete(el); };
}

// Attempts to play one remote element immediately. Often succeeds (the browser
// may still honour the join gesture, or audio is already unlocked); if it is
// blocked, the armed gesture listeners will replay it on the next interaction.
// The rejection reason is logged so real-world failures are diagnosable.
export function playRemoteMediaElement(el: HTMLMediaElement): void {
  const attempt = el.play();
  if (attempt && typeof attempt.catch === 'function') {
    attempt.catch((err: any) => {
      console.warn('[windwatch-audio] play() rejected:', err?.name || err);
    });
  }
}

// Clears all unlock state and listeners. Called when leaving a room so nothing
// carries into the next session.
export function resetAudioUnlock(): void {
  remoteMediaElements.clear();
  if (gestureListenersArmed) {
    gestureListenersArmed = false;
    GESTURE_EVENTS.forEach(ev =>
      window.removeEventListener(ev, unlockAudioPlayback, { capture: true } as EventListenerOptions)
    );
  }
}
