import * as z from "zod";

const metrics = Object.fromEntries(
  Array.from({ length: 32 }, (_, index) => [
    `value${index}`,
    z.number().min(index).max(index + 100),
  ]),
) as Record<string, z.ZodNumber>;

export const TelemetrySchema = z.strictObject(metrics);
