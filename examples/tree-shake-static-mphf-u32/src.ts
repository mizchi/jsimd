import { StaticMphfU32 } from "../../packages/jsimd/src/static-mphf-u32/mod.ts";

using keywords = StaticMphfU32.from([10, 20, 30, 40]);
document.body.textContent = String(keywords.lookup(30));
