// Motion / presence detection from live WiFi RSSI.
//
// Technique (mirrors ruvnet/ruview's Welford z-score anomaly approach):
// every access point's RSSI is tracked with a slow EWMA baseline (mean +
// variance). A human moving in the room perturbs the multipath reflections,
// which shows up as the current RSSI deviating from that baseline. We
// normalise the deviation into a z-score per AP and aggregate the z-scores
// across all APs into a single "motion energy" number (RMS z). Sustained
// high energy => motion / presence; low energy => the room is quiet.

export interface BssidObs {
  bssid: string;
  ssid: string;
  rssi_dbm: number;
  signal_pct: number;
  channel: number;
  band: string;
}

export interface ApState {
  bssid: string;
  ssid: string;
  rssi: number;
  z: number; // normalised deviation from baseline this frame
}

export interface Frame {
  t: number;
  calibrating: boolean;
  state: "calibrating" | "quiet" | "motion";
  motionScore: number; // smoothed RMS z across APs
  motionRaw: number;
  apCount: number;
  aps: ApState[]; // sorted by |z| desc
}

export interface SensingEvent {
  t: number;
  type: "motion_started" | "motion_stopped";
  motionScore: number;
  topAps: { ssid: string; z: number }[];
  durationMs?: number;
}

interface ApBaseline {
  ssid: string;
  mean: number; // slow EWMA of RSSI
  var: number; // slow EWMA of squared deviation
  count: number;
  lastSeen: number;
}

const ALPHA_SLOW = 0.03; // baseline adaptation (~33 frames memory)
const STD_FLOOR = 1.0; // dBm; avoids z blow-up when an AP is very stable
const MOTION_SMOOTH = 0.4; // EWMA on the aggregate score for display
const MOTION_ON = 1.6; // enter "motion" above this smoothed RMS z
const MOTION_OFF = 1.1; // leave "motion" below this (hysteresis)
const MIN_COUNT = 12; // frames before an AP contributes to detection
const STOP_GRACE_MS = 2500; // how long motion must stay low before "stopped"

export class MotionDetector {
  private baselines = new Map<string, ApBaseline>();
  private smoothScore = 0;
  private state: "calibrating" | "quiet" | "motion" = "calibrating";
  private calibrationUntil: number;
  private motionStartedAt = 0;
  private lowSince = 0;

  constructor(calibrationMs = 8000, private now: () => number = Date.now) {
    this.calibrationUntil = this.now() + calibrationMs;
  }

  update(obs: BssidObs[]): { frame: Frame; event?: SensingEvent } {
    const t = this.now();
    const calibrating = t < this.calibrationUntil;
    const aps: ApState[] = [];
    const zsq: number[] = [];

    for (const o of obs) {
      let b = this.baselines.get(o.bssid);
      if (!b) {
        b = { ssid: o.ssid, mean: o.rssi_dbm, var: STD_FLOOR * STD_FLOOR, count: 0, lastSeen: t };
        this.baselines.set(o.bssid, b);
      }
      const dev = o.rssi_dbm - b.mean;
      const std = Math.max(Math.sqrt(b.var), STD_FLOOR);
      const z = dev / std;

      // Update slow baseline AFTER measuring deviation.
      b.mean += ALPHA_SLOW * dev;
      b.var += ALPHA_SLOW * (dev * dev - b.var);
      b.count += 1;
      b.lastSeen = t;
      b.ssid = o.ssid || b.ssid;

      if (b.count >= MIN_COUNT) {
        aps.push({ bssid: o.bssid, ssid: o.ssid, rssi: o.rssi_dbm, z });
        zsq.push(z * z);
      } else {
        aps.push({ bssid: o.bssid, ssid: o.ssid, rssi: o.rssi_dbm, z: 0 });
      }
    }

    const motionRaw = zsq.length ? Math.sqrt(zsq.reduce((a, c) => a + c, 0) / zsq.length) : 0;
    this.smoothScore += MOTION_SMOOTH * (motionRaw - this.smoothScore);

    aps.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

    let event: SensingEvent | undefined;
    if (!calibrating) {
      if (this.state === "calibrating") this.state = "quiet";

      if (this.state === "quiet" && this.smoothScore >= MOTION_ON) {
        this.state = "motion";
        this.motionStartedAt = t;
        event = {
          t,
          type: "motion_started",
          motionScore: round(this.smoothScore),
          topAps: aps.slice(0, 3).map((a) => ({ ssid: a.ssid, z: round(a.z) })),
        };
      } else if (this.state === "motion") {
        if (this.smoothScore <= MOTION_OFF) {
          if (this.lowSince === 0) this.lowSince = t;
          if (t - this.lowSince >= STOP_GRACE_MS) {
            this.state = "quiet";
            event = {
              t,
              type: "motion_stopped",
              motionScore: round(this.smoothScore),
              topAps: aps.slice(0, 3).map((a) => ({ ssid: a.ssid, z: round(a.z) })),
              durationMs: t - this.motionStartedAt,
            };
            this.lowSince = 0;
          }
        } else {
          this.lowSince = 0;
        }
      }
    }

    const frame: Frame = {
      t,
      calibrating,
      state: calibrating ? "calibrating" : this.state,
      motionScore: round(this.smoothScore),
      motionRaw: round(motionRaw),
      apCount: obs.length,
      aps: aps.slice(0, 14).map((a) => ({ ...a, z: round(a.z), rssi: round(a.rssi) })),
    };

    return { frame, event };
  }
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
