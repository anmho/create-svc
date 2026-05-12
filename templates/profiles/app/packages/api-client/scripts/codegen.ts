import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const workspaceRoot = resolve(packageRoot, "..", "..");
const buf = Bun.which("buf") ?? join(workspaceRoot, "node_modules", ".bin", "buf");
if (!(await Bun.file(buf).exists())) {
  throw new Error("buf is required for protobuf code generation");
}

const plugin = join(workspaceRoot, "node_modules", ".bin", "protoc-gen-es");
if (!(await Bun.file(plugin).exists())) {
  throw new Error("protoc-gen-es is missing; run `bun install` first");
}

await mkdir(join(packageRoot, "src", "gen"), { recursive: true });

const result = Bun.spawnSync(["buf", "generate"], {
  cwd: workspaceRoot,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    PATH: `${join(workspaceRoot, "node_modules", ".bin")}:${process.env.PATH ?? ""}`,
  },
});

if (result.exitCode !== 0) {
  throw new Error(`code generation failed with exit code ${result.exitCode}`);
}
