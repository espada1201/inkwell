import { coarsen, type LatLon } from '../core/geo';
import { NodeDetector, type DetectorOutput } from '../core/sensor';
import { upperMedian } from '../core/stats';
import { loadIdentity, safeStorage } from '../net/identity';
import { HEARTBEAT_EVERY_MS, signHeartbeat, signPick, signRetraction, signTrigger } from '../net/protocol';
import type { Transport } from '../net/transport';
import { Emitter } from './emitter';

export type SensorState = 'idle' | 'unsupported' | 'denied' | 'no-data' | 'warming' | 'listening';

export interface LogEntry {
  at: number;
  out: Exclude<DetectorOutput, { kind: 'pick' }>;
  published: boolean;
}

interface MotionEventCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

const TRACE_S = 12;
const LOC_KEY = 'tremor.location';
const JOIN_KEY = 'tremor.join';

/**
 * Turns this device into a seismometer node: DeviceMotion → on-device detector → signed
 * Nostr events. Nothing leaves the phone unless the user joins and sets a (coarse) location.
 */
export class SensorNode extends Emitter {
  state: SensorState = 'idle';
  detector: NodeDetector | null = null;
  fs = 0;
  /** Ring buffer of recent shaking magnitude for the live trace. */
  trace: Float32Array = new Float32Array(0);
  head = 0;
  log: LogEntry[] = [];
  location: LatLon | null;
  joined: boolean;
  wakeLock: 'on' | 'off' | 'unsupported' = 'off';
  battery: { level: number; charging: boolean } | null = null;
  readonly pubkey: string;
  private readonly sk: Uint8Array;
  private intervals: number[] = [];
  private hbTimer: ReturnType<typeof setInterval> | undefined;
  private noDataTimer: ReturnType<typeof setTimeout> | undefined;
  private lock: { release(): Promise<void> } | null = null;
  private openPick: { t: number; id: string } | null = null;
  /** When the phone last finished warming up, so has listened without a break, and when the last sample came. */
  private since = 0;
  private lastSample = 0;
  private readonly onMotion = (e: DeviceMotionEvent) => this.motion(e);
  private readonly onVisible = () => {
    if (this.state === 'idle') return;
    // Hidden tabs get no motion events: say so at once rather than count as a quiet phone.
    if (document.visibilityState === 'hidden') this.heartbeat(false);
    else this.requestWakeLock();
  };

  constructor(private readonly transport: Transport) {
    super();
    const id = loadIdentity();
    this.sk = id.sk;
    this.pubkey = id.pubkey;
    const store = safeStorage();
    try {
      this.location = JSON.parse(store?.getItem(LOC_KEY) ?? 'null');
    } catch {
      this.location = null;
    }
    this.joined = store?.getItem(JOIN_KEY) === '1';
  }

  /** Must be called from a user gesture: iOS only grants motion access inside one. */
  async start() {
    if (typeof DeviceMotionEvent === 'undefined') return this.set('unsupported');
    const ctor = DeviceMotionEvent as unknown as MotionEventCtor;
    if (typeof ctor.requestPermission === 'function') {
      try {
        if ((await ctor.requestPermission()) !== 'granted') return this.set('denied');
      } catch {
        return this.set('denied');
      }
    }
    // A second tap, perhaps while the first was still asking, changes nothing; after a start
    // that found no motion data, start over.
    if (this.state === 'warming' || this.state === 'listening') return;
    if (this.hbTimer) this.stop();
    window.addEventListener('devicemotion', this.onMotion);
    document.addEventListener('visibilitychange', this.onVisible);
    this.set('warming');
    this.noDataTimer = setTimeout(() => {
      if (!this.detector) this.set('no-data');
    }, 4000);
    this.requestWakeLock();
    this.readBattery();
    this.hbTimer = setInterval(() => this.heartbeat(), HEARTBEAT_EVERY_MS);
  }

  stop() {
    // A pick still being checked never will be now.
    const out = this.detector?.interrupt(Date.now());
    if (out) this.handle(out);
    this.heartbeat(false);
    window.removeEventListener('devicemotion', this.onMotion);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearInterval(this.hbTimer);
    this.hbTimer = undefined;
    clearTimeout(this.noDataTimer);
    this.lock?.release().catch(() => {});
    this.lock = null;
    this.wakeLock = 'off';
    this.detector = null;
    this.intervals = [];
    this.set('idle');
  }

  setLocation(p: LatLon | null) {
    this.location = p && coarsen(p);
    safeStorage()?.setItem(LOC_KEY, JSON.stringify(this.location));
    this.heartbeat();
    this.emit();
  }

  setJoined(on: boolean) {
    // Leaving: say this phone has stopped while it still may, or it is counted on for minutes.
    if (!on) this.heartbeat(false);
    this.joined = on;
    safeStorage()?.setItem(JOIN_KEY, on ? '1' : '0');
    this.heartbeat();
    this.emit();
  }

  get canPublish() {
    return this.joined && !!this.location;
  }

  private set(s: SensorState) {
    this.state = s;
    this.emit();
  }

  private motion(e: DeviceMotionEvent) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    const t = performance.timeOrigin + e.timeStamp;
    this.lastSample = t;
    if (!this.detector) {
      // Learn the sample rate from the reported interval before building filters.
      if (e.interval > 0) this.intervals.push(e.interval < 1 ? e.interval * 1000 : e.interval);
      if (this.intervals.length < 10) return;
      const ms = upperMedian(this.intervals)!;
      this.fs = Math.max(10, Math.min(200, Math.round(1000 / ms)));
      this.detector = new NodeDetector(this.fs);
      this.trace = new Float32Array(TRACE_S * this.fs);
      clearTimeout(this.noDataTimer);
    }
    const d = this.detector;
    const out = d.push({ t, x: a.x, y: a.y, z: a.z });
    this.trace[this.head] = d.level;
    this.head = (this.head + 1) % this.trace.length;
    const s: SensorState = d.warmingUp ? 'warming' : 'listening';
    if (s !== this.state) {
      this.set(s);
      // Listening once the background is learned, after a break too: tell the network.
      if (s === 'listening') {
        this.since = t;
        this.heartbeat();
      }
    }
    if (out) this.handle(out);
  }

  private handle(out: DetectorOutput) {
    // Picks go out within half a second; the verdict follows once the shaking has been vetted.
    const pickId = this.openPick?.t === out.t ? this.openPick.id : undefined;
    let published = false;
    if (out.kind === 'pick') {
      this.openPick = null;
      if (this.canPublish) {
        const ev = signPick(this.sk, { ...this.location!, t: out.t, phase: out.phase });
        this.transport.publish(ev);
        this.openPick = { t: out.t, id: ev.id };
      }
      return;
    }
    this.openPick = null;
    if (out.kind === 'reject' && pickId) {
      this.transport.publish(signRetraction(this.sk, pickId, out.reason));
      published = true;
    }
    if (out.kind === 'trigger' && this.canPublish) {
      this.transport.publish(signTrigger(this.sk, { ...this.location!, t: out.t, phase: out.phase, pga: out.pga, dur: out.durS }, pickId));
      published = true;
    }
    this.log = [{ at: Date.now(), out, published }, ...this.log].slice(0, 30);
    this.emit();
  }

  /** I'm here and listening since `since`; or, with `listening` false, I have stopped. */
  private heartbeat(listening = true) {
    const d = this.detector;
    if (!this.canPublish || !d) return;
    // Not listening yet (still learning the background), or no samples lately (a hidden tab
    // whose timer still fires): stay silent and go stale.
    if (listening && (d.warmingUp || Date.now() - this.lastSample > 5000)) return;
    this.transport.publish(signHeartbeat(this.sk, { ...this.location!, noise: d.background, sps: listening ? this.fs : 0, since: this.since }));
  }

  private async requestWakeLock() {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl) {
      this.wakeLock = 'unsupported';
      return this.emit();
    }
    try {
      const lock = await wl.request('screen');
      // One lock at a time, and none once stopped: Stop may come while this one was asked for.
      this.lock?.release().catch(() => {});
      this.lock = this.state === 'idle' ? null : lock;
      if (!this.lock) return void lock.release().catch(() => {});
      this.wakeLock = 'on';
    } catch {
      this.wakeLock = 'off';
    }
    this.emit();
  }

  private async readBattery() {
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener(t: string, f: () => void): void }> };
    if (!nav.getBattery) return;
    try {
      const b = await nav.getBattery();
      const read = () => {
        this.battery = { level: b.level, charging: b.charging };
        this.emit();
      };
      b.addEventListener('levelchange', read);
      b.addEventListener('chargingchange', read);
      read();
    } catch {
      /* not available */
    }
  }
}
