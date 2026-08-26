import { CompressedStringTable } from "../../src/compressed-string-table/mod.ts";

using table = CompressedStringTable.fromUtf8(["src/button.ts", "src/button.test.ts"]);
document.body.textContent = new TextDecoder().decode(table.get(1));
