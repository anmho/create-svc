import { join } from "node:path";

const protoc = Bun.which("protoc");
if (!protoc) {
  throw new Error("protoc is required for Bun ConnectRPC code generation");
}

const plugin = join(process.cwd(), "node_modules", ".bin", "protoc-gen-es");
if (!(await Bun.file(plugin).exists())) {
  throw new Error("protoc-gen-es is missing; run `bun install` first");
}

const result = Bun.spawnSync(
  [
    protoc,
    `--plugin=protoc-gen-es=${plugin}`,
    "--es_out=gen",
    "--es_opt=target=ts",
    "protos/dns/v1/dns.proto",
  ],
  {
    cwd: process.cwd(),
    stdout: "inherit",
    stderr: "inherit",
    env: process.env,
  }
);

if (result.exitCode !== 0) {
  throw new Error(`code generation failed with exit code ${result.exitCode}`);
}
