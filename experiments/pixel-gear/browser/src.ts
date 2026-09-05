import "./style.css";

const host = document.querySelector("main");
if (!(host instanceof HTMLElement)) throw new Error("pixel gear experiment requires <main>");
const { mountPixelGearDemo } = await import("./demo.ts");
mountPixelGearDemo(host);
