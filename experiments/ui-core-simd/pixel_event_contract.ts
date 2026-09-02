export const PIXEL_EVENT_RECORD_WORDS = 4;

export const PIXEL_EVENT_KIND = {
  vaporized: 1,
  condensed: 2,
  ignited: 3,
  solidified: 4,
  corroded: 5,
  extinguished: 6,
} as const;

export type PixelEventKind = typeof PIXEL_EVENT_KIND[keyof typeof PIXEL_EVENT_KIND];
