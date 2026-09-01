import { SimdUi, type UiContainer, type UiDocument, type UiNode } from "./signals.ts";
import { FakeDocument, FakeNode } from "./test_dom.ts";

function assertEquals(actual: unknown, expected: unknown, message: string): void {
  const left = JSON.stringify(actual);
  const right = JSON.stringify(expected);
  if (left !== right) throw new Error(`${message}: expected ${right}, got ${left}`);
}

function assertThrows(operation: () => unknown, constructor: typeof Error): void {
  try {
    operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}

async function assertRejects(
  operation: () => Promise<unknown>,
  constructor: typeof Error,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof constructor) return;
    throw error;
  }
  throw new Error(`expected ${constructor.name}`);
}

Deno.test("SimdUi binds fixed signal dependencies and deduplicates batched effects", async () => {
  const document = new FakeDocument();
  const host = document.createElement("main");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const first = ui.signal(1);
  const second = ui.signal(2);
  let runs = 0;
  const text = ui.text([first, second], () => {
    runs++;
    return `${first.value + second.value}`;
  });

  await ui.mount(host as unknown as UiContainer, ui.element("p", {}, [text]));
  assertEquals(host.textContent, "3", "initial text");
  assertEquals(runs, 1, "initial effect count");

  ui.batch(() => {
    first.value = 10;
    second.value = 20;
    first.value = 11;
  });

  assertEquals(host.textContent, "31", "batched text");
  assertEquals(runs, 2, "effect runs once for the batch");
  assertEquals(
    (text as unknown as FakeNode).textContentWrites,
    0,
    "text bindings use CharacterData.data",
  );
  assertEquals(ui.stats.lastEffectCount, 1, "one deduplicated effect");
  assertEquals(ui.stats.lastChangedSignalCount, 2, "two changed signals");
});

Deno.test("SimdUi freezes its signal/effect graph after mount", async () => {
  const document = new FakeDocument();
  const host = document.createElement("main");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const value = ui.signal(1);
  await ui.mount(host as unknown as UiContainer, ui.text([value], () => String(value.value)));
  assertThrows(() => ui.signal(2), Error);
  assertThrows(() => ui.effect([value], () => {}), Error);
  await assertRejects(
    () =>
      ui.mount(
        host as unknown as UiContainer,
        document.createTextNode("again") as unknown as UiNode,
      ),
    Error,
  );
});

Deno.test("SimdUi drains signals dirtied by an effect in the same flush", async () => {
  const document = new FakeDocument();
  const host = document.createElement("main");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const source = ui.signal(0);
  const derived = ui.signal(0);
  let derivedRuns = 0;
  ui.effect([source], () => {
    if (source.value > 0) derived.value = source.value * 2;
  });
  const text = ui.text([derived], () => {
    derivedRuns++;
    return String(derived.value);
  });
  await ui.mount(host as unknown as UiContainer, text);

  source.value = 3;

  assertEquals(host.textContent, "6", "nested signal update");
  assertEquals(derivedRuns, 2, "derived effect runs once after initial mount");
  assertEquals(ui.stats.lastChangedSignalCount, 2, "both flush rounds are counted");
  assertEquals(ui.stats.lastEffectCount, 2, "both effects are counted");
});

Deno.test("SimdUi destroy detaches the graph and stops future effects", async () => {
  const document = new FakeDocument();
  const host = document.createElement("main");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const value = ui.signal(0);
  let runs = 0;
  const text = ui.text([value], () => {
    runs++;
    return String(value.value);
  });
  await ui.mount(host as unknown as UiContainer, text);

  ui.destroy();
  value.value = 1;

  assertEquals(host.textContent, "", "root detached");
  assertEquals(runs, 1, "detached effect not invoked");
});

Deno.test("SimdUi completes the current effect queue before rethrowing", async () => {
  const document = new FakeDocument();
  const host = document.createElement("main");
  const ui = new SimdUi({ document: document as unknown as UiDocument });
  const source = ui.signal(0);
  let laterRuns = 0;
  ui.effect([source], () => {
    if (source.value === 1) throw new Error("expected effect failure");
  });
  ui.effect([source], () => laterRuns++);
  await ui.mount(host as unknown as UiContainer, document.createTextNode("root"));

  assertThrows(() => source.value = 1, Error);

  assertEquals(laterRuns, 2, "later effect still invoked");
  assertEquals(ui.stats.lastEffectCount, 2, "complete queue counted");
});
