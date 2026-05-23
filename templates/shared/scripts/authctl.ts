import serviceConfig from "../service.config";
import { existsSync } from "node:fs";

type CommandResult = {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
};

const decoder = new TextDecoder();

export type AuthDoctorResult = {
  hasAuthctl: boolean;
  hasResourceServerCommands: boolean;
  detail: string;
  resourceServerCommand?: ResourceServerCommand;
};

type ResourceServerCommand = {
  subject: string;
  mutationAction?: "upsert" | "create";
  actions: string[];
};

type ResourceServerMutationCommand = ResourceServerCommand & {
  mutationAction: "upsert" | "create";
};

export function defaultAuthResourceServerArgs() {
  const auth = serviceConfig.auth;
  return [
    "--resource-server",
    auth.resource_server.id,
    "--audience",
    auth.resource_server.audience,
    "--stage",
    serviceConfig.stage_default,
    ...auth.resource_server.default_scopes.flatMap((scope) => ["--scope", scope]),
  ];
}

export function runAuthCommand(args: string[]) {
  const [subject, action, ...rest] = args;

  if (!subject || subject === "doctor") {
    const result = runAuthDoctor();
    if (!result.hasAuthctl) {
      throw new Error(result.detail);
    }
    return result.detail;
  }

  if (subject === "resource-server" || subject === "resource-servers") {
    const command = resolveResourceServerCommand();
    if (!command) {
      throw new Error(
        "authctl is installed but does not expose resource-server commands; install @anmho/authctl@0.1.1 or newer before managing auth resource servers"
      );
    }
    if (action === "get" || action === "list" || action === "delete") {
      if (!command.actions.includes(action)) {
        throw new Error(`authctl ${command.subject} does not expose ${action}`);
      }
      if (action === "delete") {
        authctl([
          command.subject,
          action,
          "--resource-server",
          serviceConfig.auth.resource_server.id,
          "--stage",
          serviceConfig.stage_default,
          "--force",
          "--json",
          ...rest,
        ]);
        return `Auth resource server deleted: ${serviceConfig.auth.resource_server.id}`;
      }
      authctl([command.subject, action, ...rest]);
      return `Auth resource server ${action} finished`;
    }
    const mutation = ensureResourceServerCommandAvailable();
    const subcommand = action ?? mutation.mutationAction;
    if (!mutation.mutationAction || (subcommand !== mutation.mutationAction && !(subcommand === "upsert" && mutation.mutationAction === "create"))) {
      throw new Error(`Usage: service auth resource-server [${mutation.mutationAction}] [authctl args]`);
    }
    authctl([mutation.subject, mutation.mutationAction, ...defaultAuthResourceServerArgs(), "--json", ...rest]);
    return `Auth resource server ready: ${serviceConfig.auth.resource_server.id}`;
  }

  if (subject === "client" || subject === "clients") {
    return runClientCommand(action, rest);
  }

  throw new Error("Usage: service auth <doctor|resource-server|client> [args]");
}

export function ensureAuthResourceServer() {
  const command = ensureResourceServerCommandAvailable();
  authctl([command.subject, command.mutationAction, ...defaultAuthResourceServerArgs(), "--json"]);
  return `Auth resource server ready: ${serviceConfig.auth.resource_server.audience}`;
}

export function deleteAuthResourceServer() {
  const command = resolveResourceServerCommand();
  if (!command?.actions.includes("delete")) {
    return "authctl does not expose resource-server delete; auth resource server was not deleted";
  }

  authctl([
    command.subject,
    "delete",
    "--resource-server",
    serviceConfig.auth.resource_server.id,
    "--stage",
    serviceConfig.stage_default,
    "--force",
    "--json",
  ]);
  return `Auth resource server deleted: ${serviceConfig.auth.resource_server.id}`;
}

export function runAuthDoctor(): AuthDoctorResult {
  if (!authctlPath()) {
    return {
      hasAuthctl: false,
      hasResourceServerCommands: false,
      detail: "authctl is not installed; run bun install in this generated service or link @anmho/authctl before service create",
    };
  }

  const doctor = authctl(["doctor", "--json"], { allowFailure: true, quiet: true });
  const resourceServerCommand = resolveResourceServerCommand();
  const hasResourceServerCommands = Boolean(resourceServerCommand?.mutationAction);

  if (!doctor.success) {
    return {
      hasAuthctl: true,
      hasResourceServerCommands,
      resourceServerCommand,
      detail: `authctl doctor failed: ${doctor.stderr || doctor.stdout}`,
    };
  }

  if (!hasResourceServerCommands) {
    return {
      hasAuthctl: true,
      hasResourceServerCommands: false,
      resourceServerCommand,
      detail:
        "authctl is installed but does not expose resource-server upsert/create; install @anmho/authctl@0.1.1 or newer before service create",
    };
  }

  return {
    hasAuthctl: true,
    hasResourceServerCommands: true,
    resourceServerCommand,
    detail: `authctl ready for ${serviceConfig.auth.resource_server.id}`,
  };
}

function runClientCommand(action = "", rest: string[]) {
  if (action === "create") {
    authctl([
      "clients",
      "create",
      "--client-app",
      serviceConfig.auth.client.app_id,
      "--client-identity",
      serviceConfig.auth.client.identity,
      ...defaultClientTargetArgs(rest),
      "--stage",
      serviceConfig.stage_default,
      "--yes",
      "--json",
      ...rest,
    ]);
    return "Auth client created";
  }

  if (["list", "get", "rotate", "revoke"].includes(action)) {
    authctl(["clients", action, ...rest]);
    return `Auth client ${action} finished`;
  }

  throw new Error("Usage: service auth client <create|list|get|rotate|revoke> [args]");
}

function defaultClientTargetArgs(rest: string[]) {
  const hasResourceServer = hasFlag(rest, "--resource-server");
  const hasScope = hasFlag(rest, "--scope");
  return [
    ...(hasResourceServer ? [] : ["--resource-server", serviceConfig.auth.resource_server.id]),
    ...(hasScope ? [] : serviceConfig.auth.resource_server.default_scopes.flatMap((scope) => ["--scope", scope])),
  ];
}

function hasFlag(args: string[], name: string) {
  return args.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function ensureResourceServerCommandAvailable(): ResourceServerMutationCommand {
  const doctor = runAuthDoctor();
  if (!doctor.hasAuthctl || !doctor.hasResourceServerCommands) {
    throw new Error(doctor.detail);
  }
  if (!doctor.resourceServerCommand?.mutationAction) {
    throw new Error("authctl resource-server command discovery failed");
  }
  return doctor.resourceServerCommand as ResourceServerMutationCommand;
}

function resolveResourceServerCommand(): ResourceServerCommand | undefined {
  for (const subject of ["resource-servers", "resource-server", "resources"]) {
    const help = authctl([subject, "--help"], { allowFailure: true, quiet: true });
    const output = `${help.stdout}\n${help.stderr}`;
    if (!help.success || !output.includes(subject)) {
      continue;
    }
    const actions = ["upsert", "create", "get", "list", "delete"].filter((candidate) => output.includes(candidate));
    const mutationAction = actions.includes("upsert") ? "upsert" : actions.includes("create") ? "create" : undefined;
    if (actions.length > 0) {
      return { subject, mutationAction, actions };
    }
  }
  return undefined;
}

function authctl(args: string[], options: { allowFailure?: boolean; quiet?: boolean } = {}): CommandResult {
  const command = authctlPath();
  if (!command) {
    throw new Error("authctl is not installed; run bun install in this generated service or link @anmho/authctl");
  }

  const result = Bun.spawnSync([command, ...args], {
    cwd: process.cwd(),
    env: authctlEnvironment(),
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
  });

  const output = {
    success: result.success,
    stdout: result.stdout ? decoder.decode(result.stdout).trim() : "",
    stderr: result.stderr ? decoder.decode(result.stderr).trim() : "",
    exitCode: result.exitCode,
  };

  if (!output.success && !options.allowFailure) {
    throw new Error(formatAuthctlFailure(args, output));
  }

  if (output.stdout && !options.quiet) {
    console.log(output.stdout);
  }

  return output;
}

function formatAuthctlFailure(args: string[], output: CommandResult) {
  const detail = output.stderr || output.stdout;
  if (detail.includes("status_code\":401") || detail.includes("Forbidden. You don't have permission")) {
    return [
      `authctl ${args.join(" ")} failed with exit code ${output.exitCode}`,
      "authctl reached the auth internal API, but Cloudflare Access rejected the request.",
      "The service CLI tried to load the authctl Access token from Vault.",
      "Verify `vault login` works and that this path is readable:",
      "  secret/prod/apps/auth/authctl/cloudflare-access",
    ].join("\n");
  }

  return `authctl ${args.join(" ")} failed with exit code ${output.exitCode}\n${detail}`;
}

function authctlPath() {
  return existsSync("./node_modules/.bin/authctl") ? "./node_modules/.bin/authctl" : Bun.which("authctl");
}

function authctlEnvironment() {
  const env = { ...process.env };
  const fields = [
    {
      envName: "AUTH_INTERNAL_BASE_URL",
      fieldEnvName: "VAULT_AUTHCTL_ACCESS_BASE_URL_FIELD",
      defaultField: "AUTH_INTERNAL_BASE_URL",
    },
    {
      envName: "CLOUDFLARE_ACCESS_SERVICE_TOKEN_CLIENT_ID",
      fieldEnvName: "VAULT_AUTHCTL_ACCESS_CLIENT_ID_FIELD",
      defaultField: "CLOUDFLARE_ACCESS_SERVICE_TOKEN_CLIENT_ID",
    },
    {
      envName: "CLOUDFLARE_ACCESS_SERVICE_TOKEN_CLIENT_SECRET",
      fieldEnvName: "VAULT_AUTHCTL_ACCESS_CLIENT_SECRET_FIELD",
      defaultField: "CLOUDFLARE_ACCESS_SERVICE_TOKEN_CLIENT_SECRET",
    },
  ];

  for (const field of fields) {
    if (env[field.envName]?.trim()) {
      continue;
    }
    const value = readAuthctlAccessVaultField(env, env[field.fieldEnvName]?.trim() || field.defaultField);
    if (value) {
      env[field.envName] = value;
    }
  }

  return env;
}

function readAuthctlAccessVaultField(env: Record<string, string | undefined>, field: string) {
  const vault = Bun.which("vault");
  if (!vault) {
    return "";
  }

  const mount = env.VAULT_AUTHCTL_ACCESS_MOUNT?.trim() || env.VAULT_SECRET_MOUNT?.trim() || "secret";
  const path = env.VAULT_AUTHCTL_ACCESS_PATH?.trim() || "prod/apps/auth/authctl/cloudflare-access";
  const result = Bun.spawnSync([vault, "kv", "get", `-mount=${mount}`, `-field=${field}`, path], {
    cwd: process.cwd(),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!result.success || !result.stdout) {
    return "";
  }

  return decoder.decode(result.stdout).trim();
}
