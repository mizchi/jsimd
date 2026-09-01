import { computed } from "./computed.ts";
import { SimdUi, type UiContainer, type UiDocument } from "./signals.ts";
import { FakeDocument } from "./test_dom.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

Deno.test("computed propagates a diamond dependency without glitches", async () => {
  const document = new FakeDocument();
  const host = document.createElement("main");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const source = ui.signal(1);
  const left = computed(ui, [source], () => source.value * 2);
  const right = computed(ui, [source], () => source.value * 3);
  const total = computed(ui, [left, right], () => left.value + right.value);
  let textRuns = 0;
  const text = ui.text([total], () => {
    textRuns++;
    return String(total.value);
  });
  await ui.mount(host as unknown as UiContainer, text);

  ui.batch(() => {
    source.value = 2;
    source.value = 3;
  });

  assertEquals(host.textContent, "15", "derived text");
  assertEquals(textRuns, 2, "one downstream update");
  assertEquals(ui.stats.lastEffectCount, 4, "two branches, join, and text");
});

Deno.test("computed suppresses unchanged derived values", async () => {
  const document = new FakeDocument();
  const host = document.createElement("main");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const source = ui.signal(1);
  const parity = computed(ui, [source], () => source.value & 1);
  let textRuns = 0;
  const text = ui.text([parity], () => {
    textRuns++;
    return String(parity.value);
  });
  await ui.mount(host as unknown as UiContainer, text);

  source.value = 3;

  assertEquals(host.textContent, "1", "stable derived text");
  assertEquals(textRuns, 1, "unchanged value stops propagation");
});
