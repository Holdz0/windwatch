import { applyAudioEncoding, applyVideoEncoding, CAMERA_ENCODING, screenEncodingFor } from './screenShare';
import type { ScreenSharePreset } from './screenShare';
import { preferScreenCodecs, saverBudget, saverCameraEncoding, trafficBitrate } from './saver';
import type { SaverStats, TrafficSample } from './saver';
import { randomId } from './session';
import { readScreenQuality, refreshScreenEncoding, ScreenQualityRecovery, SCREEN_QUALITY_INTERVAL } from './screenRecovery';

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
  quality: ScreenQualityRecovery;
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
  private traffic = new Map<string, TrafficSample>();
  private qualityTimer?: ReturnType<typeof setTimeout>;
  private qualitySampling = false;
  private qualityGeneration = 0;

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
    // Rebalance existing senders when someone joins/leaves, including links
    // that were already connected before the new viewer appeared.
    for (const [peerId, link] of this.links) void this.queue(peerId, link, () => this.applyEncoding(link));
    this.updateQualityMonitor();
  }

  setOnline(online: boolean): void {
    const resumed = online && !this.online;
    this.online = online;
    if (resumed) this.resume();
    this.updateQualityMonitor();
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
      const transceiver = pc.addTransceiver(this.tracks[slot] || kind, { direction: 'sendrecv' });
      if (slot === 'screenVideo') preferScreenCodecs(transceiver);
      senders[slot] = transceiver.sender;
    }
    const link: Link = { pc, sessionId, senders, camera, screen, jobs: Promise.resolve(), quality: new ScreenQualityRecovery() };
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
      link.quality = new ScreenQualityRecovery();
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
      this.updateQualityMonitor();
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
            if (slot === 'screenVideo') preferScreenCodecs(transceivers[index]);
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
    this.qualityGeneration++;
    for (const link of this.links.values()) link.quality = new ScreenQualityRecovery();
    this.tracks = { ...tracks };
    this.preset = preset;
    this.traffic.clear();
    await Promise.all(Array.from(this.links, ([peerId, link]) => this.queue(peerId, link, () => this.applyTracks(link))));
    this.updateQualityMonitor();
  }

  private async applyTracks(link: Link): Promise<void> {
    for (const slot of SLOTS) {
      const track = this.tracks[slot];
      if (link.senders[slot] && link.senders[slot].track !== track) await link.senders[slot].replaceTrack(track);
    }
    await this.applyEncoding(link);
  }

  private activeSaverBudget() {
    return this.preset?.id === 'saver' && this.tracks.screenVideo ? saverBudget(this.members.size, {
      microphone: !!this.tracks.microphone, camera: !!this.tracks.camera, screenAudio: !!this.tracks.screenAudio
    }) : null;
  }

  private async applyEncoding(link: Link): Promise<void> {
    const budget = this.activeSaverBudget();
    if (link.senders.microphone) await applyAudioEncoding(link.senders.microphone, budget?.microphone);
    if (link.senders.screenAudio) await applyAudioEncoding(link.senders.screenAudio, budget?.screenAudio);
    if (link.senders.camera) await applyVideoEncoding(link.senders.camera,
      budget && this.tracks.camera ? saverCameraEncoding(this.tracks.camera, budget.camera) : CAMERA_ENCODING);
    if (this.preset && link.senders.screenVideo) await applyVideoEncoding(link.senders.screenVideo, {
      ...screenEncodingFor(this.preset), ...(budget ? { maxBitrate: budget.screen, priority: 'medium' as const } : {})
    });
  }

  private updateQualityMonitor(): void {
    const active = !this.disposed && this.online && this.tracks.screenVideo?.readyState === 'live' &&
      [...this.links.values()].some(link => link.pc.connectionState === 'connected');
    if (!active) { clearTimeout(this.qualityTimer); this.qualityTimer = undefined; return; }
    if (this.qualityTimer || this.qualitySampling) return;
    this.qualityTimer = setTimeout(() => {
      this.qualityTimer = undefined;
      void this.sampleScreenQuality();
    }, SCREEN_QUALITY_INTERVAL);
  }

  private async sampleScreenQuality(): Promise<void> {
    this.qualitySampling = true;
    const track = this.tracks.screenVideo;
    const preset = this.preset;
    const generation = this.qualityGeneration;
    try {
      if (!track || track.readyState !== 'live' || !preset || !this.online || this.disposed) return;
      await Promise.all([...this.links].map(async ([peerId, link]) => {
        try {
          if (link.pc.connectionState !== 'connected' || link.senders.screenVideo?.track !== track) return;
          const reports = await link.pc.getStats();
          if (this.disposed || !this.online || generation !== this.qualityGeneration ||
            this.links.get(peerId) !== link || link.pc.connectionState !== 'connected') return;
          const sample = readScreenQuality(reports, link.pc.getTransceivers()[2]?.mid ?? null, track.getSettings());
          const budget = this.activeSaverBudget();
          if (!sample || !link.quality.observe(sample, { width: preset.maxWidth, height: preset.maxHeight,
            fps: preset.frameRate, bitrate: budget?.screen ?? preset.maxBitrate,
            otherBitrate: (this.tracks.microphone ? budget?.microphone ?? 24_000 : 0) +
              (this.tracks.screenAudio ? budget?.screenAudio ?? 64_000 : 0) })) return;
          await this.queue(peerId, link, async () => {
            if (generation !== this.qualityGeneration || link.pc.connectionState !== 'connected') return;
            const currentBudget = this.activeSaverBudget();
            await refreshScreenEncoding(link.senders.screenVideo, { ...screenEncodingFor(preset),
              ...(currentBudget ? { maxBitrate: currentBudget.screen, priority: 'medium' as const } : {}) });
          });
        } catch { /* Optional stats/hints must never tear down a healthy call. */ }
      }));
    } finally {
      this.qualitySampling = false;
      this.updateQualityMonitor();
    }
  }

  /** Display traffic statistics only while the saver settings panel is visible. */
  async getSaverStats(): Promise<SaverStats | null> {
    const budget = this.activeSaverBudget();
    if (!budget || this.disposed) { this.traffic.clear(); return null; }
    const links = [...this.links.values()].filter(link => link.pc.connectionState === 'connected');
    const samples: TrafficSample[] = [];
    let width = 0, height = 0, fps = 0, limitedBy = 'none';
    await Promise.all(links.map(async link => {
      try {
        const reports = await link.pc.getStats();
        if (this.disposed || !this.activeSaverBudget() || link.pc.connectionState !== 'connected') return;
        const screenMid = link.pc.getTransceivers()[2]?.mid;
        reports.forEach((report: RTCOutboundRtpStreamStats) => {
          if (report.type !== 'outbound-rtp') return;
          samples.push({ id: `${link.sessionId}:${report.id}`, timestamp: report.timestamp,
            bytes: (report.bytesSent || 0) + (report.headerBytesSent || 0) });
          if (report.mid !== screenMid || report.kind !== 'video') return;
          if (report.frameHeight && (!height || report.frameHeight < height)) {
            width = report.frameWidth || 0; height = report.frameHeight; fps = report.framesPerSecond || 0;
          }
          if (report.qualityLimitationReason && report.qualityLimitationReason !== 'none') limitedBy = report.qualityLimitationReason;
        });
      } catch { /* A closed/recovering connection has no useful sample. */ }
    }));
    if (this.disposed || !this.activeSaverBudget()) return null;
    return { viewers: links.length, mediaBitrate: trafficBitrate(this.traffic, samples),
      screenBitrateLimit: budget.screen, width, height, fps, limitedBy };
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
    this.updateQualityMonitor();
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
    this.traffic.clear();
  }
}
