import { FmIndexBytes } from "../../src/fm-index-bytes/mod.ts";

const encoder = new TextEncoder();
using index = FmIndexBytes.from(encoder.encode("banana"));
document.body.textContent = String(index.count(encoder.encode("ana")));
