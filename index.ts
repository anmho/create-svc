#!/usr/bin/env bun

import { runServiceCommand } from "./src/service";

await runServiceCommand(process.argv.slice(2));
