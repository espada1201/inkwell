/// <reference lib="webworker" />
import { calibrate, type PhoneModel } from '../core/phonemodel';
import { simulatePlan, type PlanInput, type PlanResult, type Summary } from '../core/planner';

export interface PlanRequest {
  id: number;
  input: PlanInput;
  /** Phone counts for the "how many phones are enough" curve. */
  sweep: number[];
}

export type PlanMessage =
  | { id: number; type: 'progress'; phones: number; value: number }
  | { id: number; type: 'result'; result: PlanResult }
  | { id: number; type: 'point'; summary: Summary };

const models = new Map<number, PhoneModel>();
const points = new Map<string, Summary>();
let latest = 0;

const post = (m: PlanMessage) => postMessage(m);
const yieldToMessages = () => new Promise((r) => setTimeout(r, 0));

self.onmessage = (e: MessageEvent<PlanRequest>) => {
  latest = e.data.id;
  void run(e.data);
};

/** Step a simulation in ~40 ms slices so a newer request can pre-empt it. Null if pre-empted. */
async function drive<T>(id: number, steps: Generator<number, T>, phones: number): Promise<T | null> {
  let slice = performance.now();
  for (;;) {
    const s = steps.next();
    if (s.done) return s.value;
    if (performance.now() - slice > 40) {
      post({ id, type: 'progress', phones, value: s.value });
      await yieldToMessages();
      if (id !== latest) return null;
      slice = performance.now();
    }
  }
}

async function run({ id, input, sweep }: PlanRequest) {
  await yieldToMessages();
  if (id !== latest) return;
  let model = models.get(input.mag);
  if (!model) models.set(input.mag, (model = calibrate(input.mag)));
  const result = await drive(id, simulatePlan({ ...input, confirm: true }, model), input.phones);
  if (!result) return;
  post({ id, type: 'result', result });
  for (const phones of sweep) {
    const key = JSON.stringify({ ...input, phones });
    let summary = points.get(key) ?? (phones === input.phones ? result.summary : null);
    if (!summary) {
      const r = await drive(id, simulatePlan({ ...input, phones, confirm: false }, model), phones);
      if (!r) return;
      summary = r.summary;
    }
    points.set(key, summary);
    post({ id, type: 'point', summary });
  }
}
