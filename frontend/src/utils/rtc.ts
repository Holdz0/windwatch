import { applyVideoEncoding, CAMERA_ENCODING, screenEncodingFor } from './screenShare';
import type { ScreenSharePreset } from './screenShare';
import { randomId } from './session';

// Every connection negotiates these four slots once. Muting releases hardware
// with replaceTrack(null); sharing never replaces or mixes microphone audio.
const SLOTS = ['microphone', 'camera', 'screenVideo', 'screenAudio'] as const;
type Slot = typeof SLOTS[number];
export type MediaTracks = Record<Slot, MediaStreamTrack | null>;
export const emptyTracks = (): MediaTracks => ({ microphone: null, camera: null, screenVideo: null, screenAudio: null });

export interface RtcSignal {
  sessionId: string;
  description?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  restart?: boolean;
}

interface Link {
  pc: RTCPeerConnection;
  sessionId: string;
  senders: Record<Slot, RTCRtpSender>;
  camera: MediaStream;
  screen: MediaStream;
  jobs: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  channel?: RTCDataChannel;
}

interface MeshOptions {
  peerId: string;
  iceServers: RTCIceServer[];
  sendSignal: (peerId: string, signal: RtcSignal) => void;
  onStreams: (peerId: string, camera: MediaStream, screen: MediaStream) => void;
  onState: (peerId: string, state: RTCPeerConnectionState) => void;
  onDataChannel: (peerId: string, channel: RTCDataChannel) => void;
  onError: (error: unknown) => void;
}

export class RtcMesh {
  readonly links = new Map<string, Link>();
  private members = new Map<string, boolean>();
  private tracks = emptyTracks();
  private preset: ScreenSharePreset | null = null;
  private candidates = new Map<string, RTCIceCandidateInit[]>();
  private attempts = new Map<string, number>();
  private waiting = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;
  private online = true;
  private options: MeshOptions;

  constructor(options: MeshOptions) { this.options = options; }

  sync(members: { peerId: string; isReconnecting?: boolean }[]): void {
    this.members = new Map(members.map(member => [member.peerId, !!member.isReconnecting]));
    for (const peerId of this.links.keys()) if (!this.members.has(peerId)) { this.closeLink(peerId); this.attempts.delete(peerId); }
    for (const [peerId, timer] of this.waiting) {
      if (!this.members.has(peerId)) { clearTimeout(timer); this.waiting.delete(peerId); }
    }
    for (const [peerId, reconnecting] of this.members) {
      if (reconnecting || this.waiting.has(peerId) || !this.online) continue;
      const link = this.links.get(peerId);
      if (link) {
        if (!link.timer && link.pc.connectionState !== 'connected') this.recover(peerId, link);
        continue;
      }
      if (this.options.peerId < peerId) this.start(peerId);
      else this.waitForCaller(peerId);
    }
  }

  setOnline(online: boolean): void {
    const resumed = online && !this.online;
    this.online = online;
    if (resumed) this.resume();
  }

  private queue(peerId: string, link: Link, work: () => Promise<void>): Promise<void> {
    link.jobs = link.jobs.then(async () => {
      if (this.disposed || this.links.get(peerId) !== link) return;
      await work();
    }).catch(error => {
      if (this.disposed || this.links.get(peerId) !== link) return;
      this.options.onError(error);
      this.recover(peerId, link);
    });
    return link.jobs;
  }

  private create(peerId: string, sessionId: string, caller: boolean): Link {
    this.closeLink(peerId);
    const pc = new RTCPeerConnection({ iceServers: this.options.iceServers });
    const camera = new MediaStream();
    const screen = new MediaStream();
    const senders = {} as Record<Slot, RTCRtpSender>;
    if (caller) for (const slot of SLOTS) {
      const kind = slot === 'microphone' || slot === 'screenAudio' ? 'audio' : 'video';
      senders[slot] = pc.addTransceiver(this.tracks[slot] || kind, { direction: 'sendrecv' }).sender;
    }
    const link: Link = { pc, sessionId, senders, camera, screen, jobs: Promise.resolve() };
    this.links.set(peerId, link);
    this.options.onStreams(peerId, camera, screen);
    this.options.onState(peerId, 'connecting');

    pc.onicecandidate = event => {
      if (event.candidate && this.links.get(peerId) === link && this.online)
        this.options.sendSignal(peerId, { sessionId, candidate: event.candidate.toJSON() });
    };
    pc.ontrack = event => {
      if (this.links.get(peerId) !== link) return;
      const index = pc.getTransceivers().indexOf(event.transceiver);
      const stream = index >= 2 ? screen : camera;
      if (!stream.getTracks().includes(event.track)) stream.addTrack(event.track);
      event.track.onended = () => stream.removeTrack(event.track);
      this.options.onStreams(peerId, camera, screen);
    };
    pc.onconnectionstatechange = () => {
      if (this.links.get(peerId) !== link) return;
      const state = pc.connectionState;
      this.options.onState(peerId, state);
      if (state === 'connected') {
        clearTimeout(link.timer);
        link.timer = undefined;
        this.attempts.delete(peerId);
        void this.queue(peerId, link, () => this.applyTracks(link));
      } else if (state === 'failed' || state === 'closed') this.recover(peerId, link);
      else if (state === 'disconnected') {
        clearTimeout(link.timer);
        link.timer = setTimeout(() => this.recover(peerId, link), 8000);
      }
    };
    const attachChannel = (channel: RTCDataChannel) => {
      link.channel = channel;
      this.options.onDataChannel(peerId, channel);
    };
    if (caller) attachChannel(pc.createDataChannel('files', { ordered: true }));
    else pc.ondatachannel = event => {
      if (event.channel.label === 'files') attachChannel(event.channel);
      else event.channel.close();
    };
    link.timer = setTimeout(() => this.recover(peerId, link), 20000);
    return link;
  }

  private start(peerId: string): void {
    if (this.disposed || !this.online || !this.members.has(peerId) || this.members.get(peerId)) return;
    const link = this.create(peerId, randomId(), true);
    void this.queue(peerId, link, async () => {
      await link.pc.setLocalDescription(await link.pc.createOffer());
      this.options.sendSignal(peerId, { sessionId: link.sessionId, description: link.pc.localDescription!.toJSON() });
      await this.applyTracks(link);
    });
  }

  async handleSignal(peerId: string, signal: RtcSignal): Promise<void> {
    if (this.disposed || !this.members.has(peerId) || !signal?.sessionId) return;
    let link = this.links.get(peerId);
    if (signal.restart) {
      if (this.options.peerId < peerId && (!link || link.sessionId === signal.sessionId)) {
        if (link) this.recover(peerId, link);
        else this.start(peerId);
      }
      return;
    }
    if (signal.description?.type === 'offer') {
      if (this.options.peerId < peerId) return;
      if (!link || link.sessionId !== signal.sessionId) link = this.create(peerId, signal.sessionId, false);
    }
    if (signal.candidate && (!link || link.sessionId !== signal.sessionId)) {
      // Candidates may overtake the offer during async negotiation. Keep a
      // bounded queue per generation; stale connection candidates never apply.
      if (this.candidates.size > 20) this.candidates.clear();
      const pending = this.candidates.get(signal.sessionId) || [];
      if (pending.length < 100) pending.push(signal.candidate);
      this.candidates.set(signal.sessionId, pending);
      return;
    }
    if (!link || link.sessionId !== signal.sessionId) return;
    const current = link;
    await this.queue(peerId, current, async () => {
      if (signal.description) {
        if (signal.description.type === 'answer' && current.pc.signalingState !== 'have-local-offer') return;
        await current.pc.setRemoteDescription(signal.description);
        if (signal.description.type === 'offer') {
          // The answerer adopts the offer's slots. Pre-creating empty local
          // transceivers here would leave them unassociated and create another
          // four receive-only slots when the offer is applied.
          const transceivers = current.pc.getTransceivers();
          if (transceivers.length !== SLOTS.length) throw new Error('Unexpected media slots');
          SLOTS.forEach((slot, index) => {
            transceivers[index].direction = 'sendrecv';
            current.senders[slot] = transceivers[index].sender;
          });
          await this.applyTracks(current);
        }
        const pending = this.candidates.get(signal.sessionId) || [];
        this.candidates.delete(signal.sessionId);
        for (const candidate of pending) await current.pc.addIceCandidate(candidate);
        if (signal.description.type === 'offer') {
          await current.pc.setLocalDescription(await current.pc.createAnswer());
          this.options.sendSignal(peerId, { sessionId: signal.sessionId, description: current.pc.localDescription!.toJSON() });
        }
        await this.applyTracks(current);
      } else if (signal.candidate) {
        if (current.pc.remoteDescription) await current.pc.addIceCandidate(signal.candidate);
        else {
          const pending = this.candidates.get(signal.sessionId) || [];
          if (pending.length < 100) pending.push(signal.candidate);
          this.candidates.set(signal.sessionId, pending);
        }
      }
    });
  }

  async setTracks(tracks: MediaTracks, preset: ScreenSharePreset | null): Promise<void> {
    this.tracks = { ...tracks };
    this.preset = preset;
    await Promise.all(Array.from(this.links, ([peerId, link]) => this.queue(peerId, link, () => this.applyTracks(link))));
  }

  private async applyTracks(link: Link): Promise<void> {
    for (const slot of SLOTS) {
      const track = this.tracks[slot];
      if (link.senders[slot] && link.senders[slot].track !== track) await link.senders[slot].replaceTrack(track);
    }
    if (link.senders.camera) await applyVideoEncoding(link.senders.camera, CAMERA_ENCODING);
    if (this.preset && link.senders.screenVideo) await applyVideoEncoding(link.senders.screenVideo, screenEncodingFor(this.preset));
  }

  private waitForCaller(peerId: string): void {
    this.waiting.set(peerId, setTimeout(() => {
      this.waiting.delete(peerId);
      if (!this.online || this.disposed || !this.members.has(peerId) || this.links.has(peerId)) return;
      this.options.sendSignal(peerId, { sessionId: 'missing', restart: true });
      this.waitForCaller(peerId);
    }, 5000));
  }

  private recover(peerId: string, link: Link): void {
    if (this.disposed || this.links.get(peerId) !== link) return;
    clearTimeout(link.timer);
    if (!this.online || this.members.get(peerId)) { link.timer = undefined; return; }
    if (this.options.peerId > peerId) {
      this.options.sendSignal(peerId, { sessionId: link.sessionId, restart: true });
      link.timer = setTimeout(() => this.recover(peerId, link), 5000);
      return;
    }
    this.closeLink(peerId);
    const attempt = this.attempts.get(peerId) || 0;
    this.attempts.set(peerId, attempt + 1);
    this.options.onState(peerId, 'connecting');
    this.waiting.set(peerId, setTimeout(() => {
      this.waiting.delete(peerId);
      this.start(peerId);
    }, Math.min(15000, 1000 * 2 ** attempt)));
  }

  resume(): void {
    for (const [peerId, link] of this.links) {
      if (['failed', 'disconnected', 'closed', 'new'].includes(link.pc.connectionState) ||
          (!link.timer && link.pc.connectionState === 'connecting')) this.recover(peerId, link);
    }
    this.sync(Array.from(this.members, ([peerId, isReconnecting]) => ({ peerId, isReconnecting })));
  }

  private closeLink(peerId: string): void {
    const link = this.links.get(peerId);
    if (link) {
      this.links.delete(peerId);
      clearTimeout(link.timer);
      this.candidates.delete(link.sessionId);
      link.channel?.close();
      link.pc.close();
    }
    const timer = this.waiting.get(peerId);
    clearTimeout(timer);
    this.waiting.delete(peerId);
  }

  dispose(): void {
    this.disposed = true;
    for (const peerId of this.links.keys()) this.closeLink(peerId);
    for (const timer of this.waiting.values()) clearTimeout(timer);
    this.waiting.clear();
    this.members.clear();
    this.candidates.clear();
  }
}
