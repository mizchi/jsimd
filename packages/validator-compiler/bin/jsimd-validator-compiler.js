#!/usr/bin/env node
import process from "node:process";
import { main } from "../dist/cli.js";

await main(process.argv.slice(2));
