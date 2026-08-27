import { BitmapGridAStar } from "../prototype/mod.ts";

using grid = BitmapGridAStar.fromObstacles(8, 8, new Uint8Array(64));
console.log(grid.findPath(0, 0, 7, 7));
