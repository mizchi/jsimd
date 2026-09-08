import "./style.css";
import { createPixelGearKernel } from "../kernel.ts";

const host = document.querySelector("main");
if (!(host instanceof HTMLElement)) throw new Error("pixel gear experiment requires <main>");
const kernel = await createPixelGearKernel();
const { mountPixelGearDemo } = await import("./demo.ts");
mountPixelGearDemo(host, kernel);
