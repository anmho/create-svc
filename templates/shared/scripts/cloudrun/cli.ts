#!/usr/bin/env bun

import { bootstrap } from "./bootstrap";
import { cleanup } from "./cleanup";
import { deploy } from "./deploy";
import { runMain } from "./lib";

async function main(argv = Bun.argv.slice(2)) {
  const [command, ...rest] = argv;

  if (command === "bootstrap") {
    await runMain("Bootstrap", async () => {
      await bootstrap();
      return "Bootstrap finished";
    });
    return;
  }

  if (command === "deploy") {
    await runMain("Deploy", () => deploy(rest));
    return;
  }

  if (command === "cleanup") {
    await runMain("Cleanup", () => cleanup(rest));
    return;
  }

  throw new Error("Usage: svc-cloudrun <bootstrap|deploy|cleanup> [args]");
}

if (import.meta.main) {
  await main();
}
