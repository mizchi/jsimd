import { SimdUi, type UiSignal } from "./signals.ts";

/** Creates a fixed-dependency derived signal without adding code to the minimal signals entry. */
export function computed<T>(
  ui: SimdUi,
  dependencies: readonly UiSignal<unknown>[],
  compute: () => T,
): UiSignal<T> {
  if (typeof compute !== "function") throw new TypeError("compute must be a function");
  const value = ui.signal(compute());
  ui.effect(dependencies, () => value.value = compute());
  return value;
}
