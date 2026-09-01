import { type AtomicInputBuffer, type AtomicInputKind } from "./atomic_input.ts";

const COORDINATE_SCALE = 64;
const PRESSURE_SCALE = 0xffff;

export interface PointerEventData {
  readonly clientX: number;
  readonly clientY: number;
  readonly pointerId: number;
  readonly buttons: number;
  readonly button: number;
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly timeStamp: number;
  readonly pressure?: number;
  readonly detail?: number;
}

/** Allocation-free main-thread extraction for coalescible pointer state. */
export function writeLatestPointerEvent(
  input: AtomicInputBuffer,
  kind: AtomicInputKind,
  targetId: number,
  event: PointerEventData,
): number {
  return input.publishLatest(
    kind,
    targetId,
    fixedCoordinate(event.clientX),
    fixedCoordinate(event.clientY),
    event.pointerId,
    packFlags(event),
    timestampMicros(event.timeStamp),
    packDetail(event),
  );
}

/** Allocation-free main-thread extraction for lossless pointer/click records. */
export function writeDiscretePointerEvent(
  input: AtomicInputBuffer,
  kind: AtomicInputKind,
  targetId: number,
  event: PointerEventData,
): boolean {
  return input.push(
    kind,
    targetId,
    fixedCoordinate(event.clientX),
    fixedCoordinate(event.clientY),
    event.pointerId,
    packFlags(event),
    timestampMicros(event.timeStamp),
    packDetail(event),
  );
}

function fixedCoordinate(value: number): number {
  return clampI32(Math.round(value * COORDINATE_SCALE));
}

function timestampMicros(value: number): number {
  return Math.round(value * 1_000) >>> 0;
}

function packFlags(event: PointerEventData): number {
  const modifiers = (event.shiftKey ? 1 : 0) |
    (event.ctrlKey ? 2 : 0) |
    (event.altKey ? 4 : 0) |
    (event.metaKey ? 8 : 0);
  return ((event.buttons & 0xffff) | (((event.button + 1) & 0xff) << 16) | (modifiers << 24)) >>> 0;
}

function packDetail(event: PointerEventData): number {
  const pressure = Math.round(Math.min(1, Math.max(0, event.pressure ?? 0)) * PRESSURE_SCALE);
  return (pressure | ((event.detail ?? 0) & 0xffff) << 16) >>> 0;
}

function clampI32(value: number): number {
  return Math.min(0x7fff_ffff, Math.max(-0x8000_0000, value)) | 0;
}
