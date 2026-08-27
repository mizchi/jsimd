import { DijkstraCsrGraph, SimdPriorityQueueU32 } from "../prototype/mod.ts";

using queue = new SimdPriorityQueueU32();
queue.push(1, 2).push(2, 1);
console.log(queue.pop());

using graph = DijkstraCsrGraph.from(
  new Uint32Array([0, 1, 1]),
  new Uint32Array([1]),
  new Float32Array([1]),
);
console.log(graph.shortestPath(0, 1));
