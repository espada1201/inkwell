import { coarsen, type LatLon } from '../core/geo';
import { NodeDetector, type DetectorOutput } from '../core/sensor';
import { loadIdentity, safeStorage } from '../net/identity';
import { HEARTBEAT_EVERY_MS, signHeartbeat, signPick, signRetraction, signTrigger } from '../net/protocol';
import type { Transport } from '../net/transport';
import { Emitter } from '../ui/dom';

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
  ratioTrace: Float32Array = new Float32Array(0);
  head = 0;
  noise = 0;
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
  private readonly onMotion = (e: DeviceMotionEvent) => this.motion(e);
  private readonly onVisible = () => {
    if (document.visibilityState === 'visible' && this.state !== 'idle') this.requestWakeLock();
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
    window.removeEventListener('devicemotion', this.onMotion);
    document.removeEventListener('visibilitychange', this.onVisible);
    clearInterval(this.hbTimer);
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
    if (!this.detector) {
      // Learn the sample rate from the reported interval before building filters.
      if (e.interval > 0) this.intervals.push(e.interval < 1 ? e.interval * 1000 : e.interval);
      if (this.intervals.length < 10) return;
      const ms = [...this.intervals].sort((x, y) => x - y)[5];
      this.fs = Math.max(10, Math.min(200, Math.round(1000 / ms)));
      this.detector = new NodeDetector(this.fs);
      this.trace = new Float32Array(TRACE_S * this.fs);
      this.ratioTrace = new Float32Array(TRACE_S * this.fs);
      clearTimeout(this.noDataTimer);
      this.heartbeat();
    }
    const d = this.detector;
    const out = d.push({ t, x: a.x, y: a.y, z: a.z });
    this.trace[this.head] = d.level;
    this.ratioTrace[this.head] = d.ratio;
    this.head = (this.head + 1) % this.trace.length;
    this.noise += (d.level - this.noise) * 0.002;
    const s: SensorState = d.warmingUp ? 'warming' : 'listening';
    if (s !== this.state) this.set(s);
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
    if (out.kind === 'reject' && pickId) this.transport.publish(signRetraction(this.sk, pickId, out.reason));
    if (out.kind === 'trigger' && this.canPublish) {
      this.transport.publish(signTrigger(this.sk, { ...this.location!, t: out.t, phase: out.phase, pga: out.pga, dur: out.durS }, pickId));
      published = true;
    }
    this.log = [{ at: Date.now(), out, published }, ...this.log].slice(0, 30);
    this.emit();
  }

  private heartbeat() {
    if (!this.canPublish || !this.detector) return;
    this.transport.publish(signHeartbeat(this.sk, { ...this.location!, noise: this.noise, sps: this.fs }));
  }

  private async requestWakeLock() {
    const wl = (navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
    if (!wl) {
      this.wakeLock = 'unsupported';
      return this.emit();
    }
    try {
      this.lock = await wl.request('screen');
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
