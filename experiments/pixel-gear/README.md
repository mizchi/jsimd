# Pixel × Gear × Gel experiment

This prototype is intentionally isolated from the `ui-core-simd` browser comparison and is not a
published package or public API.

It explores three interactions:

- a rotating rigid gear displacing sand and water cells;
- high-viscosity material represented as a bonded aggregate with boundary-only steady-state work;
- local fracture and component rebuilding when accumulated contact stress exceeds bond strength.

Run it with:

```sh
just dev-pixel-gear-experiment
```

Validate the isolated experiment with:

```sh
just test-pixel-gear-experiment
```

The experiment reuses `ui-core-simd/pixel_sim.ts` and `ui-core-simd/signals.ts`, but no gear or gel
entry point is reachable from the normal UI comparison build.

The isolated browser app owns its shared runtime dependencies and keeps their combined JavaScript
under a 10 kB gzip experiment budget.
