import { useEffect, useRef, useState } from 'react';
import type { Participant } from '../types';
import { playRemoteMediaElement, registerRemoteMediaElement } from '../utils/audio';

function AudioStream({ stream, volume, active }: { stream?: MediaStream; volume: number; active: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!stream) return;
    const changed = () => setRevision(value => value + 1);
    stream.addEventListener('addtrack', changed);
    stream.addEventListener('removetrack', changed);
    return () => { stream.removeEventListener('addtrack', changed); stream.removeEventListener('removetrack', changed); };
  }, [stream]);
  useEffect(() => {
    const element = ref.current;
    if (!element || !stream || !active) return;
    const tracks = stream.getAudioTracks();
    if (!tracks.length) return;
    element.srcObject = new MediaStream(tracks);
    const unregister = registerRemoteMediaElement(element);
    const play = () => playRemoteMediaElement(element);
    tracks.forEach(track => track.addEventListener('unmute', play));
    play();
    return () => {
      unregister();
      tracks.forEach(track => track.removeEventListener('unmute', play));
      element.pause();
      element.srcObject = null;
    };
  }, [stream, revision, active]);
  useEffect(() => { if (ref.current) ref.current.volume = volume; }, [volume]);
  return <audio ref={ref} autoPlay muted={volume === 0} />;
}

// This subtree survives pinning, screen sharing, chat overlays and hidden
// thumbnails. Each remote source has exactly one playback element.
export default function RemoteAudio({ participants, volumes }: {
  participants: Participant[];
  volumes: Record<string, number>;
}) {
  return <div className="remote-audio" aria-hidden="true">
    {participants.filter(p => p.socketId !== 'local').map(p => <div key={p.peerId} data-audio-peer={p.peerId}>
      <AudioStream stream={p.stream} volume={volumes[p.peerId] ?? 1} active={!p.isAudioMuted} />
      <AudioStream stream={p.screenStream} volume={volumes[p.peerId] ?? 1} active={!!p.isScreenSharing && !!p.hasScreenAudio} />
    </div>)}
  </div>;
}
