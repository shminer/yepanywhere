#!/usr/bin/env node

import { spawn } from "node:child_process";
import { exitIfUnsafeHome } from "./safe-home.js";

const rawArgs = process.argv.slice(2);
const stdinNull = rawArgs[0] === "--stdin-null";
const [command, ...args] = stdinNull ? rawArgs.slice(1) : rawArgs;

if (!command) {
  console.error(
    "Usage: node scripts/run-with-safe-home.js <command> [args...]",
  );
  process.exit(1);
}

exitIfUnsafeHome({ entrypoint: command });

const child = spawn(command, args, {
  stdio: [stdinNull ? "ignore" : "inherit", "inherit", "inherit"],
  env: process.env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
