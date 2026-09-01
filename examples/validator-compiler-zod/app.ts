import UserValidator, { is, type Output as User, validate } from "./generated/user.js";

const user: User = {
  id: "user-1",
  age: 36,
  role: "admin",
  active: true,
  tags: ["compiler", "simd"],
  profile: {
    displayName: "Ada",
    score: 0.95,
  },
};

if (!is(user)) throw new Error("generated predicate rejected a valid user");

const raw = validate({ ...user, age: 131 });
if (raw.issues === undefined) throw new Error("generated diagnostics accepted an invalid age");

const standard = UserValidator["~standard"].validate(user);
if (!("value" in standard)) throw new Error("Standard Schema wrapper rejected a valid user");

console.log("valid user", user.id);
console.log("invalid user", raw.issues[0]);
