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
