import { AtomicEffectBatch } from "./atomic_effect_batch.ts";
import { PackedSignalGraph } from "./signal_graph.ts";

let sink = 0;

for (
  const specification of [
    { effectCount: 128, signalCount: 32, fanout: 4, changed: 2 },
    { effectCount: 1_024, signalCount: 128, fanout: 64, changed: 8 },
    { effectCount: 8_192, signalCount: 256, fanout: 4, changed: 2 },
    { effectCount: 8_192, signalCount: 256, fanout: 1_024, changed: 16 },
    { effectCount: 65_536, signalCount: 256, fanout: 4, changed: 2 },
    { effectCount: 65_536, signalCount: 256, fanout: 8_192, changed: 16 },
  ]
) {
  const rows = Array.from({ length: specification.signalCount }, (_, signalId) =>
    Array.from(
      { length: specification.fanout },
      (_, index) => (signalId * 977 + index * 33) % specification.effectCount,
    ));
  const graph = await PackedSignalGraph.create({
    effectCount: specification.effectCount,
    subscribersBySignal: rows,
  });
  const changed = Array.from({ length: specification.changed }, (_, index) => index * 7);
  const group =
    `signals e=${specification.effectCount} fanout=${specification.fanout} changed=${specification.changed}`;
  Deno.bench({
    name: "sparse scalar",
    group,
    baseline: true,
    fn() {
      sink ^= graph.collect(changed, "scalar").length;
    },
  });
  Deno.bench({
    name: graph.strategyFor(changed) === "simd" ? "dense Wasm SIMD" : "SIMD request → scalar",
    group,
    fn() {
      sink ^= graph.collect(changed, "simd").length;
    },
  });
}

for (
  const specification of [
    { effectCount: 1_024, signalCount: 128, fanout: 64, changed: 8 },
    { effectCount: 8_192, signalCount: 256, fanout: 1_024, changed: 16 },
  ]
) {
  const rows = Array.from({ length: specification.signalCount }, (_, signalId) =>
    Array.from(
      { length: specification.fanout },
      (_, index) => (signalId * 977 + index * 33) % specification.effectCount,
    ));
  const graph = await PackedSignalGraph.create({
    effectCount: specification.effectCount,
    subscribersBySignal: rows,
  });
  const changed = Array.from({ length: specification.changed }, (_, index) => index * 7);
  const packed = Uint32Array.from(changed);
  const group = `signal input e=${specification.effectCount} changed=${specification.changed}`;
  Deno.bench({
    name: "input generic iterable",
    group,
    baseline: true,
    fn() {
      sink ^= graph.collect(changed).length;
    },
  });
  Deno.bench({
    name: "input pre-deduplicated Uint32Array",
    group,
    fn() {
      sink ^= graph.collectPacked(packed).length;
    },
  });
}

for (const count of [32, 1_024, 65_536]) {
  const capacity = Math.max(128, count);
  const effectIds = Array.from({ length: count }, (_, index) => index % capacity);
  const atomic = AtomicEffectBatch.create(capacity);
  const localWords = new Uint32Array(Math.ceil(capacity / 32));
  const group = `dirty effect marks=${count}`;
  Deno.bench({
    name: "local bitmap",
    group,
    baseline: true,
    fn() {
      for (const effectId of effectIds) {
        localWords[effectId >>> 5] = (localWords[effectId >>> 5]! | (1 << (effectId & 31))) >>> 0;
      }
      sink ^= drainLocal(localWords);
    },
  });
  Deno.bench({
    name: "Atomics.or + exchange drain",
    group,
    fn() {
      atomic.markMany(effectIds);
      sink ^= atomic.drain().length;
    },
  });
}

function drainLocal(words: Uint32Array): number {
  let count = 0;
  for (let index = 0; index < words.length; index++) {
    count += popcount(words[index]!);
    words[index] = 0;
  }
  return count;
}

function popcount(value: number): number {
  value -= (value >>> 1) & 0x5555_5555;
  value = (value & 0x3333_3333) + ((value >>> 2) & 0x3333_3333);
  return (((value + (value >>> 4)) & 0x0f0f_0f0f) * 0x0101_0101) >>> 24;
}

for (const effectCount of [1_024, 8_192]) {
  const signalCount = 128;
  const rows = Array.from(
    { length: signalCount },
    (_, signalId) =>
      Array.from({ length: 64 }, (_, index) => (signalId * 977 + index * 33) % effectCount),
  );
  Deno.bench({
    name: `graph construction e=${effectCount}`,
    async fn() {
      const graph = await PackedSignalGraph.create({ effectCount, subscribersBySignal: rows });
      sink ^= graph.effectCount;
    },
  });
}
