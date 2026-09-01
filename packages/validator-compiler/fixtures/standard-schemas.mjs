import * as v from "valibot";
import * as z from "zod";

export const ZodUser = z.strictObject({
  name: z.string().min(1),
  age: z.number().int().min(0).max(130),
});

export const ValibotUser = v.strictObject({
  name: v.pipe(v.string(), v.minLength(1)),
  age: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(130)),
});
