import * as z from "zod";

const schema = z.compile(z.object({
  name: z.string().min(1),
  age: z.number().int().min(0).max(130),
  active: z.boolean(),
  tags: z.array(z.string()),
}));

export const validate = (input: unknown): boolean => schema.safeParse(input).success;
