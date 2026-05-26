export type AuthctlCommand = {
  path: string;
  runWithBun: boolean;
};

export function authctlSpawnArgs(command: AuthctlCommand, args: string[]) {
  return command.runWithBun ? [bunExecutable(), command.path, ...args] : [command.path, ...args];
}

function bunExecutable() {
  return Bun.which("bun") ?? process.execPath;
}
