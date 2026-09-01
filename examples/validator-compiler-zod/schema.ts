import * as z from "zod";

export const UserSchema = z.strictObject({
  id: z.string().min(1).max(64),
  age: z.number().int().min(0).max(130),
  role: z.enum(["admin", "member"]),
  active: z.boolean(),
  tags: z.array(z.string().min(1).max(24)).min(1).max(8),
  profile: z.strictObject({
    displayName: z.string().min(1).max(32),
    score: z.number().min(0).max(1),
  }),
  nickname: z.string().max(32).nullable().optional(),
});
