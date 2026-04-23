import {
  autocomplete,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import pc from "picocolors";
import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPostScaffoldFlow } from "./post-scaffold";
import { listOpenBillingAccounts, listAccessibleProjects, type BillingAccount, type GcpProject } from "./gcp";
import { discoverNeonDefaults } from "./neon";
import {
  BILLING_ACCOUNT_DEFAULT,
  FRAMEWORKS_BY_RUNTIME,
  QUOTA_PROJECT_DEFAULT,
  deriveDefaults,
  slugify,
  type Framework,
  type GcpProjectMode,
  type Runtime,
} from "./naming";
import {
  DirectoryConflictError,
  assertTargetDirectoryIsEmpty,
  scaffoldProject,
  type ScaffoldConfig,
} from "./scaffold";

type ParsedArgs = {
  directory?: string;
  runtime?: Runtime;
  framework?: Framework;
  gcpProjectMode?: GcpProjectMode;
  gcpProject?: string;
  githubRepo?: string;
  region?: string;
  billingAccount?: string;
  quotaProjectId?: string;
  autoDeploy?: boolean;
  yes: boolean;
  help: boolean;
};

type DiscoveryState = {
  projects: GcpProject[];
  billingAccounts: BillingAccount[];
  neonProjectId?: string;
  neonBaseBranchId?: string;
  neonBaseBranchName?: string;
  neonError?: string;
  warnings: string[];
};

const DEFAULT_REGION = "us-west1";

export async function run(argv: string[]) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      printHelp();
      return;
    }

    intro(`${pc.bold("create-svc")} ${pc.dim("Cloud Run scaffold")}`);

    const config = await resolveConfig(args);
    const targetDir = resolve(process.cwd(), config.directory);

    note(
      [
        `${pc.bold("Output")}: ${targetDir}`,
        `${pc.bold("Runtime")}: ${config.runtime} + ${config.framework}`,
        `${pc.bold("Project")}: ${config.gcpProjectMode === "create_new" ? "create" : "use"} ${config.gcpProjectName} (${config.gcpProject})`,
        `${pc.bold("GitHub")}: ${config.githubRepo}`,
        `${pc.bold("Neon")}: ${config.neonProjectId || "(set later)"} / ${config.neonBaseBranchName || "(set later)"}`,
      ].join("\n"),
      "Scaffold"
    );

    const buildSpinner = spinner();
    buildSpinner.start("Generating project files");
    await scaffoldProject(config);
    buildSpinner.stop("Project files generated");

    const shouldRunPostScaffoldFlow = Boolean(process.stdout.isTTY && process.stdin.isTTY && (config.createGithubRepo || config.autoDeploy));
    if (shouldRunPostScaffoldFlow) {
      const automationSpinner = spinner();
      automationSpinner.start("Running post-scaffold automation");
      try {
        const result = await runPostScaffoldFlow(config, targetDir);
        automationSpinner.stop(result.message);
      } catch (error) {
        automationSpinner.stop("Post-scaffold automation skipped");
        log.warn(error instanceof Error ? error.message : String(error));
      }
    }

    outro(
      [
        `Next: ${pc.cyan(`cd ${config.directory}`)}`,
        `Local dev: ${pc.cyan("bun dev")}`,
        `Bootstrap: ${pc.cyan("bun run bootstrap")}`,
        `Deploy: ${pc.cyan("bun run deploy")}`,
        `Personal env: ${pc.cyan(`bun run deploy -- --environment personal --name ${config.serviceName}`)}`,
      ].join("\n")
    );
  } catch (error) {
    handleCliError(error);
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    yes: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) {
      continue;
    }

    if (!token.startsWith("-") && !parsed.directory) {
      parsed.directory = token;
      continue;
    }

    const next = argv[i + 1];
    const readValue = () => {
      if (!next || next.startsWith("-")) {
        throw new Error(`Missing value for ${token}`);
      }
      i += 1;
      return next;
    };

    if (token === "--yes" || token === "-y") {
      parsed.yes = true;
      continue;
    }

    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }

    if (token === "--runtime") {
      parsed.runtime = readValue() as Runtime;
      continue;
    }

    if (token.startsWith("--runtime=")) {
      parsed.runtime = token.slice("--runtime=".length) as Runtime;
      continue;
    }

    if (token === "--framework") {
      parsed.framework = readValue() as Framework;
      continue;
    }

    if (token.startsWith("--framework=")) {
      parsed.framework = token.slice("--framework=".length) as Framework;
      continue;
    }

    if (token === "--project-mode") {
      parsed.gcpProjectMode = readValue() as GcpProjectMode;
      continue;
    }

    if (token.startsWith("--project-mode=")) {
      parsed.gcpProjectMode = token.slice("--project-mode=".length) as GcpProjectMode;
      continue;
    }

    if (token === "--project-id" || token === "--gcp-project") {
      parsed.gcpProject = readValue();
      continue;
    }

    if (token.startsWith("--project-id=")) {
      parsed.gcpProject = token.slice("--project-id=".length);
      continue;
    }

    if (token.startsWith("--gcp-project=")) {
      parsed.gcpProject = token.slice("--gcp-project=".length);
      continue;
    }

    if (token === "--github-repo") {
      parsed.githubRepo = readValue();
      continue;
    }

    if (token.startsWith("--github-repo=")) {
      parsed.githubRepo = token.slice("--github-repo=".length);
      continue;
    }

    if (token === "--region") {
      parsed.region = readValue();
      continue;
    }

    if (token.startsWith("--region=")) {
      parsed.region = token.slice("--region=".length);
      continue;
    }

    if (token === "--billing-account") {
      parsed.billingAccount = readValue();
      continue;
    }

    if (token.startsWith("--billing-account=")) {
      parsed.billingAccount = token.slice("--billing-account=".length);
      continue;
    }

    if (token === "--quota-project") {
      parsed.quotaProjectId = readValue();
      continue;
    }

    if (token.startsWith("--quota-project=")) {
      parsed.quotaProjectId = token.slice("--quota-project=".length);
      continue;
    }

    if (token === "--auto-deploy") {
      parsed.autoDeploy = true;
      continue;
    }

    if (token === "--no-auto-deploy") {
      parsed.autoDeploy = false;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return parsed;
}

export async function resolveConfig(args: ParsedArgs): Promise<ScaffoldConfig> {
  const inferredName = slugify(basename(args.directory ?? "my-service"));
  const serviceName = args.yes
    ? inferredName
    : await promptText("Service name", inferredName, (value) => validateServiceNameInput(value, args.directory));
  const directory = args.directory ?? serviceName;
  const targetDir = resolve(process.cwd(), directory);
  await assertTargetDirectoryIsEmpty(targetDir);

  const discoveryPromise = discoverCloudInputs();
  const defaults = deriveDefaults(serviceName);
  const runtime = await resolveRuntime(args);
  const framework = await resolveFramework(args, runtime);
  const discovery = await discoveryPromise;
  assertDiscoveryReady(discovery);
  const gcpSelection = await resolveGcpSelection(args, defaults, discovery);
  const githubRepo = args.githubRepo ?? defaults.githubRepo;
  const region = args.region ?? DEFAULT_REGION;
  const billingAccount = chooseBillingAccount(args.billingAccount, discovery.billingAccounts);
  const autoDeploy = resolveAutoDeploy(args.autoDeploy);

  if (!args.yes) {
    const okay = await confirm({
      message: "Create the scaffold with these defaults?",
      initialValue: true,
    });
    if (isCancel(okay) || !okay) {
      cancel("Aborted");
      process.exit(1);
    }
  }

  for (const warning of discovery.warnings) {
    log.warn(warning);
  }

  return {
    directory,
    serviceName,
    runtime,
    framework,
    region,
    gcpProjectMode: gcpSelection.mode,
    gcpProject: gcpSelection.projectId,
    gcpProjectName: gcpSelection.projectName,
    billingAccount,
    quotaProjectId: args.quotaProjectId ?? QUOTA_PROJECT_DEFAULT,
    githubRepo,
    githubVisibility: "public",
    createGithubRepo: true,
    autoDeploy,
    neonProjectId: discovery.neonProjectId ?? "",
    neonBaseBranchId: discovery.neonBaseBranchId ?? "",
    neonBaseBranchName: discovery.neonBaseBranchName ?? "main",
    neonDatabaseName: defaults.neonDatabaseName,
    generatorRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  };
}

async function resolveRuntime(args: ParsedArgs): Promise<Runtime> {
  if (args.runtime) {
    return args.runtime;
  }

  if (args.yes) {
    return "go";
  }

  const value = await select({
    message: "Runtime",
    initialValue: "go",
    options: [
      { value: "go", label: "Go", hint: "Default" },
      { value: "bun", label: "Bun" },
    ],
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  return value;
}

async function resolveFramework(args: ParsedArgs, runtime: Runtime): Promise<Framework> {
  const allowed = FRAMEWORKS_BY_RUNTIME[runtime];
  if (args.framework) {
    if (allowed.includes(args.framework)) {
      return args.framework;
    }
    throw new Error(`Framework ${args.framework} is not valid for runtime ${runtime}`);
  }

  if (args.yes) {
    return allowed[0];
  }

  const value = await select({
    message: "Framework",
    initialValue: allowed[0],
    options: allowed.map((framework, index) => ({
      value: framework,
      label: framework,
      hint: index === 0 ? "Default" : undefined,
    })),
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  return value;
}

async function resolveGcpSelection(
  args: ParsedArgs,
  defaults: ReturnType<typeof deriveDefaults>,
  discovery: DiscoveryState
) {
  if (args.gcpProjectMode && args.gcpProject) {
    const existing = discovery.projects.find((project) => matchesProject(project, args.gcpProject ?? ""));
    return {
      mode: args.gcpProjectMode,
      projectId: args.gcpProject,
      projectName: args.gcpProjectMode === "create_new" ? defaults.projectName : existing?.name ?? args.gcpProject,
    };
  }

  if (args.gcpProjectMode === "create_new") {
    return {
      mode: "create_new" as const,
      projectId: args.gcpProject ?? defaults.projectId,
      projectName: defaults.projectName,
    };
  }

  if (args.gcpProjectMode === "use_existing") {
    const existing = discovery.projects.find((project) => project.projectId === args.gcpProject);
    return {
      mode: "use_existing" as const,
      projectId: args.gcpProject ?? discovery.projects[0]?.projectId ?? defaults.projectId,
      projectName: existing?.name ?? args.gcpProject ?? defaults.projectName,
    };
  }

  if (args.yes) {
    return {
      mode: "create_new" as const,
      projectId: defaults.projectId,
      projectName: defaults.projectName,
    };
  }

  const mode = await select({
    message: "GCP project",
    initialValue: "create_new",
    options: [
      {
        value: "create_new",
        label: `Create new project: ${defaults.projectName} (${defaults.projectId})`,
        hint: "Default",
      },
      {
        value: "use_existing",
        label: "Use existing project...",
        hint: discovery.projects.length > 0 ? `${discovery.projects.length} available` : "Unavailable",
        disabled: discovery.projects.length === 0,
      },
    ],
  });

  if (isCancel(mode)) {
    cancel("Aborted");
    process.exit(1);
  }

  if (mode === "create_new") {
    return {
      mode: "create_new" as const,
      projectId: defaults.projectId,
      projectName: defaults.projectName,
    };
  }

  if (discovery.projects.length === 0) {
    throw new Error("No existing GCP projects were discovered");
  }

  const selected = await promptForExistingProject(discovery.projects);
  if (!selected) {
    return resolveGcpSelection(
      {
        ...args,
        gcpProjectMode: undefined,
        gcpProject: undefined,
      },
      defaults,
      discovery
    );
  }

  return {
    mode: selected.mode,
    projectId: selected.projectId,
    projectName: selected.projectName,
  };
}

async function discoverCloudInputs(): Promise<DiscoveryState> {
  const result: DiscoveryState = {
    projects: [],
    billingAccounts: [],
    warnings: [],
  };

  try {
    result.projects = await listAccessibleProjects();
  } catch (error) {
    result.warnings.push(`Skipping GCP project discovery: ${formatError(error)}`);
  }

  try {
    result.billingAccounts = await listOpenBillingAccounts();
  } catch (error) {
    result.warnings.push(`Skipping billing account discovery: ${formatError(error)}`);
  }

  try {
    const neonDefaults = await discoverNeonDefaults();
    result.neonProjectId = neonDefaults.projectId;
    result.neonBaseBranchId = neonDefaults.baseBranchId;
    result.neonBaseBranchName = neonDefaults.baseBranchName;
  } catch (error) {
    result.neonError = formatError(error);
  }

  return result;
}

export function assertDiscoveryReady(discovery: DiscoveryState) {
  if (!discovery.neonError) {
    return;
  }

  throw new Error(formatNeonDiscoveryRequirement(discovery.neonError));
}

function chooseBillingAccount(input: string | undefined, accounts: BillingAccount[]) {
  if (input) {
    return input;
  }

  const preferred = accounts.find((account) => account.name === BILLING_ACCOUNT_DEFAULT);
  if (preferred) {
    return preferred.name;
  }

  return accounts[0]?.name ?? BILLING_ACCOUNT_DEFAULT;
}

function resolveAutoDeploy(value: boolean | undefined) {
  if (value !== undefined) {
    return value;
  }
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

async function promptText(
  message: string,
  initialValue: string,
  validate: (value: string) => true | string
): Promise<string> {
  const value = await text({
    message,
    initialValue,
    validate: (input) => normalizeValidationResult(validate(input.trim())),
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  return value.trim();
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatNeonDiscoveryRequirement(reason: string) {
  if (reason.includes("Vault secret resolution requires")) {
    return [
      "Neon discovery is required before scaffolding.",
      "Set NEON_API_KEY, or use Vault by providing VAULT_ADDR and either VAULT_TOKEN, VAULT_TOKEN_FILE, or ~/.vault-token.",
      "Optional overrides: VAULT_SECRET_MOUNT, VAULT_NEON_API_KEY_PATH, VAULT_NEON_API_KEY_FIELD.",
    ].join(" ");
  }

  return `Neon discovery is required before scaffolding: ${reason}`;
}

function handleCliError(error: unknown) {
  if (error instanceof DirectoryConflictError) {
    log.error(`Target directory already exists and is not empty: ${error.targetDir}`);
    process.exit(1);
  }

  log.error(formatError(error));
  process.exit(1);
}

async function promptForExistingProject(projects: GcpProject[]) {
  const value = await autocomplete({
    message: "Existing GCP project",
    placeholder: "Search by project name or id",
    maxItems: 10,
    options: [
      {
        value: "__back__",
        label: "Back",
        hint: "Return to project mode",
      },
      ...projects.map((project) => ({
        value: project.projectId,
        label: project.name,
        hint: project.projectId,
      })),
    ],
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  if (value === "__back__") {
    return undefined;
  }

  const project = projects.find((candidate) => candidate.projectId === value);
  if (project) {
    return {
      mode: "use_existing" as const,
      projectId: project.projectId,
      projectName: project.name,
    };
  }

  return undefined;
}

export function normalizeValidationResult(result: true | string): string | undefined {
  return result === true ? undefined : result;
}

export function validateServiceNameInput(rawValue: string, directoryOverride?: string) {
  const serviceName = slugify(rawValue);
  if (!serviceName) {
    return "Service name is required";
  }

  const directory = directoryOverride ?? serviceName;
  const targetDir = resolve(process.cwd(), directory);

  try {
    const entries = readdirSync(targetDir);
    if (entries.length > 0) {
      return "Directory already exists and is not empty";
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return "Unable to check target directory";
    }
  }

  return true;
}

function printHelp() {
  log.message(`
Usage:
  bun run index.ts [directory] [options]

Options:
  --runtime <go|bun>              Runtime scaffold to generate
  --framework <name>              Framework for the selected runtime
  --project-mode <mode>           create_new or use_existing
  --project-id <id>               GCP project id
  --github-repo <owner/repo>      GitHub repository
  --billing-account <name>        Billing account resource name
  --quota-project <id>            Billing quota project for gcloud calls
  --region <region>               Cloud Run region
  --auto-deploy                   Run bootstrap and first deploy after scaffold
  --no-auto-deploy                Scaffold only
  --yes, -y                       Accept defaults without prompts
  --help, -h                      Show this message
`);
}
