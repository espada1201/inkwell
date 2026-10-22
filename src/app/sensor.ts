import { coarsen, distanceKm, type LatLon } from '../core/geo';
import { DEFAULT_DEPTH_KM, distanceFor, hypocentralKm, pgaFor, VP_KMS, VS_KMS } from '../core/physics';
import { NodeDetector, type DetectorOutput } from '../core/sensor';
import { upperMedian } from '../core/stats';
import { loadIdentity, safeStorage } from '../net/identity';
import { HEARTBEAT_EVERY_MS, signHeartbeat, signOutput, signRetraction } from '../net/protocol';
import type { Transport } from '../net/transport';
import type { UsgsQuake } from '../net/usgs';
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
const LISTENED_KEY = 'tremor.listened';

/** What this phone made of a quake nearby: confirmed its shaking, missed it, or too weak here to notice. */
export type Verdict = 'felt' | 'missed' | 'too weak';

/** Monday 00:00, local time, of the week `t` falls in. */
function weekStart(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** How far from its epicentre, km, a quake 10 km deep still shakes the ground this hard (m/s²): `pgaFor` inverted. 0 if not even right above it. */
export function reachKm(mag: number, pga: number): number {
  const r = distanceFor(mag, pga);
  return r > DEFAULT_DEPTH_KM ? Math.sqrt(r ** 2 - DEFAULT_DEPTH_KM ** 2) : 0;
}

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
  /** When this phone listened, this session: from the end of each warm-up to the last sample before a break. */
  private stretches: { from: number; to: number }[] = [];
  /** Onsets of the shaking it confirmed. */
  private confirmed: number[] = [];
  /** Listening time kept in this browser for the week starting `week`, from sessions before this one. */
  private before = { week: 0, ms: 0 };
  private lastSample = 0;
  /** Wall clock minus the clock motion events are stamped by. */
  private offset = 0;
  private readonly onMotion = (e: DeviceMotionEvent) => this.motion(e);
  private readonly onVisible = () => {
    if (this.state === 'idle') return;
    // Hidden tabs get no motion events: say so at once rather than count as a quiet phone.
    if (document.visibilityState === 'hidden') {
      this.interrupt();
      this.saveListened();
    } else this.requestWakeLock();
  };

  constructor(private readonly transport: Transport, id = loadIdentity()) {
    super();
    this.sk = id.sk;
    this.pubkey = id.pubkey;
    const store = safeStorage();
    try {
      this.location = JSON.parse(store?.getItem(LOC_KEY) ?? 'null');
    } catch {
      this.location = null;
    }
    this.joined = store?.getItem(JOIN_KEY) === '1';
    try {
      const b = JSON.parse(store?.getItem(LISTENED_KEY) ?? 'null');
      if (Number.isFinite(b?.week) && Number.isFinite(b?.ms) && b.ms >= 0) this.before = { week: b.week, ms: b.ms };
    } catch {
      /* start the count afresh */
    }
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
    this.hbTimer = setInterval(() => {
      this.heartbeat();
      this.saveListened();
    }, HEARTBEAT_EVERY_MS);
  }

  stop() {
    this.interrupt();
    this.saveListened();
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
    if (!on) {
      // Leaving: withdraw a pick still being checked, whose verdict will not be sent (the check
      // goes on here, for the log), and say this phone has stopped while it still may, or it is
      // counted on for minutes.
      if (this.openPick) this.transport.publish(signRetraction(this.sk, this.openPick.id, 'interrupted'));
      this.openPick = null;
      this.heartbeat(false);
    }
    this.joined = on;
    safeStorage()?.setItem(JOIN_KEY, on ? '1' : '0');
    this.heartbeat();
    this.emit();
  }

  get canPublish() {
    return this.joined && !!this.location;
  }

  /** Time spent listening, ms: this session, and this week (from Monday, local time) in this browser. */
  listened(now = Date.now()) {
    const week = weekStart(now);
    let session = 0;
    let inWeek = this.before.week === week ? this.before.ms : 0;
    for (const s of this.stretches) {
      session += s.to - s.from;
      inWeek += Math.max(0, s.to - Math.max(s.from, week));
    }
    return { session, week: inWeek };
  }

  /**
   * The quakes whose shaking here the model puts above the detector's floor, from while this
   * phone listened, and what it made of each. Rough: it judges by the background now.
   */
  nearbyQuakes(quakes: UsgsQuake[]): { quake: UsgsQuake; km: number; pga: number; verdict: Verdict }[] {
    const d = this.detector;
    const here = this.location;
    if (!d || !here) return [];
    return quakes.flatMap((quake) => {
      if (quake.mag === null) return [];
      const km = distanceKm(here, quake);
      const r = hypocentralKm(km, quake.depthKm);
      const pga = pgaFor(quake.mag, r);
      // From a little before its P wave was due here until a little after its S wave.
      const from = quake.time + (r / VP_KMS) * 1000 - 3000;
      const to = quake.time + (r / VS_KMS) * 1000 + 5000;
      const felt = this.confirmed.some((t) => t >= from && t <= to);
      // Listening from before the shaking was due until its verdict would have come.
      const heard = this.stretches.some((s) => s.from <= from && s.to >= to + 30_000);
      if (pga < d.floor || !(felt || heard)) return [];
      return [{ quake, km, pga, verdict: felt ? 'felt' : pga < d.noticesPga ? 'too weak' : 'missed' }];
    });
  }

  /** The samples stop here: withdraw a pick still being checked, which never will be now, and say this phone has stopped. */
  private interrupt() {
    // Interrupted, the detector starts afresh: report the background it had.
    const noise = this.detector?.background;
    const out = this.detector?.interrupt(Date.now());
    if (out) this.handle(out);
    this.heartbeat(false, noise);
  }

  private set(s: SensorState) {
    this.state = s;
    this.emit();
  }

  private motion(e: DeviceMotionEvent) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x === null || a.y === null || a.z === null) return;
    // Time samples by the wall clock, as the network does: the event clock drifts from it over
    // days and stands still while the device sleeps. Re-anchor once they part by 20 ms.
    const offset = Date.now() - performance.now();
    if (Math.abs(offset - this.offset) > 20) this.offset = offset;
    const t = this.offset + e.timeStamp;
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
        this.stretches.push({ from: t, to: t });
        this.heartbeat();
      }
    }
    if (s === 'listening') this.stretches.at(-1)!.to = t;
    if (out) this.handle(out);
  }

  private handle(out: DetectorOutput) {
    // Picks go out within a second or so of the shaking; the verdict follows 15–30 s later.
    const open = this.openPick?.t === out.t ? this.openPick.id : undefined;
    this.openPick = null;
    // Only while sharing, except that a pick already out is still withdrawn (a retraction needs no location).
    const ev = this.canPublish || out.kind === 'reject' ? signOutput(this.sk, this.location!, out, open) : null;
    if (ev) this.transport.publish(ev);
    if (out.kind === 'pick') {
      if (ev) this.openPick = { t: out.t, id: ev.id };
      return;
    }
    if (out.kind === 'trigger') this.confirmed.push(out.t);
    this.log = [{ at: Date.now(), out, published: !!ev }, ...this.log].slice(0, 30);
    this.emit();
  }

  /** I'm here and listening since the end of the warm-up; or, with `listening` false, I have stopped. `noise`: the background to report, if not the detector's now. */
  private heartbeat(listening = true, noise?: number) {
    const d = this.detector;
    if (!this.canPublish || !d) return;
    // Not listening yet (still learning the background), or no samples lately (a hidden tab
    // whose timer still fires): stay silent and go stale.
    if (listening && (d.warmingUp || Date.now() - this.lastSample > 5000)) return;
    this.transport.publish(signHeartbeat(this.sk, { ...this.location!, noise: noise ?? d.background, sps: listening ? this.fs : 0, since: this.stretches.at(-1)?.from }));
  }

  /** Keep this week's listening time in this browser. */
  private saveListened(now = Date.now()) {
    // shortcut: two tabs listening at once each keep their own count and the last to save wins; add per-tab counts if people run several.
    try {
      safeStorage()?.setItem(LISTENED_KEY, JSON.stringify({ week: weekStart(now), ms: this.listened(now).week }));
    } catch {
      /* storage full or blocked: the count lasts this session */
    }
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
