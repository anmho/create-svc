import {
  autocomplete,
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  note,
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
import {
  BILLING_ACCOUNT_DEFAULT,
  QUOTA_PROJECT_DEFAULT,
  deriveDefaults,
  frameworksForTargetRuntime,
  parseDeployTarget,
  slugify,
  type DeployTarget,
  type Framework,
  type GcpProjectMode,
  type Runtime,
} from "./naming";
import { parseProfile, type Profile } from "./profiles";
import {
  DirectoryConflictError,
  assertTargetDirectoryIsEmpty,
  scaffoldProject,
  type ScaffoldConfig,
} from "./scaffold";

type ParsedArgs = {
  directory?: string;
  target?: DeployTarget;
  runtime?: Runtime;
  framework?: Framework;
  modulePath?: string;
  gcpProjectMode?: GcpProjectMode;
  gcpProject?: string;
  region?: string;
  billingAccount?: string;
  quotaProjectId?: string;
  autoDeploy?: boolean;
  autoUpdate?: boolean;
  noUpdateCheck?: boolean;
  profile: Profile;
  yes: boolean;
  help: boolean;
};

type DiscoveryState = {
  projects: GcpProject[];
  billingAccounts: BillingAccount[];
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

    await maybeCheckForUpdate(args);

    intro(`${pc.bold("create-service")} ${pc.dim("microservice bootstrap")}`);

    const config = await resolveConfig(args);
    const targetDir = resolve(process.cwd(), config.directory);

    note(
      [
        `${pc.bold("Output")}: ${targetDir}`,
        `${pc.bold("Target")}: ${config.target}`,
        `${pc.bold("Runtime")}: ${config.runtime} + ${config.framework}`,
        `${pc.bold("Project")}: ${config.gcpProjectMode === "create_new" ? "create" : "use"} ${config.gcpProjectName} (${config.gcpProject})`,
        `${pc.bold("API")}: https://${config.apiHostname}`,
        `${pc.bold("Local DB")}: docker compose postgres`,
      ].join("\n"),
      "Scaffold"
    );

    const buildSpinner = spinner();
    buildSpinner.start("Generating project files");
    await scaffoldProject(config);
    buildSpinner.stop("Project files generated");

    const shouldRunPostScaffoldFlow = config.autoDeploy;
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

    const isBun = config.runtime === "bun";
    outro(
      [
        `Next: ${pc.cyan(`cd ${config.directory}`)}`,
        `Local DB: ${pc.cyan("started by local dev command")}`,
        `Migrate: ${pc.cyan(isBun ? "bun run migrate" : "make migrate")}`,
        `Local dev: ${pc.cyan(isBun ? "bun run dev" : "make dev")}`,
        `Create: ${pc.cyan(isBun ? "bun run service -- create" : "make create")}`,
        `Deploy: ${pc.cyan(isBun ? "bun run service -- deploy" : "make deploy")}`,
        `Personal env: ${pc.cyan(
          isBun
            ? `bun run deploy -- --environment personal --name ${config.serviceName}`
            : `make deploy ARGS="--environment personal --name ${config.serviceName}"`
        )}`,
        `Production API: ${pc.cyan(`https://${config.apiHostname}`)}`,
      ].join("\n")
    );
  } catch (error) {
    handleCliError(error);
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    profile: "microservice",
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

    if (token === "--auto-update") {
      parsed.autoUpdate = true;
      continue;
    }

    if (token === "--no-update-check") {
      parsed.noUpdateCheck = true;
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

    if (token === "--target") {
      parsed.target = parseDeployTarget(readValue());
      continue;
    }

    if (token.startsWith("--target=")) {
      parsed.target = parseDeployTarget(token.slice("--target=".length));
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

    if (token === "--profile") {
      parsed.profile = parseProfile(readValue());
      continue;
    }

    if (token.startsWith("--profile=")) {
      parsed.profile = parseProfile(token.slice("--profile=".length));
      continue;
    }

    if (token === "--module-path") {
      parsed.modulePath = readValue();
      continue;
    }

    if (token.startsWith("--module-path=")) {
      parsed.modulePath = token.slice("--module-path=".length);
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

const CURRENT_VERSION = "0.1.9";
const PACKAGE_NAME = "create-service";

async function maybeCheckForUpdate(args: ParsedArgs) {
  if (args.noUpdateCheck || shouldSkipUpdateCheck()) {
    return;
  }

  const latest = await resolveLatestVersion().catch(() => "");
  if (!latest || !isVersionGreater(latest, CURRENT_VERSION)) {
    return;
  }

  const command = `bunx ${PACKAGE_NAME}@latest ${Bun.argv.slice(2).filter((arg) => arg !== "--auto-update").join(" ")}`.trim();
  if (!args.autoUpdate) {
    log.info(`A newer ${PACKAGE_NAME} is available: ${CURRENT_VERSION} -> ${latest}. Run ${command}`);
    return;
  }

  const result = Bun.spawnSync(["bunx", `${PACKAGE_NAME}@latest`, ...Bun.argv.slice(2).filter((arg) => arg !== "--auto-update")], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      CREATE_SERVICE_NO_UPDATE_CHECK: "1",
    },
  });
  process.exit(result.exitCode);
}

function shouldSkipUpdateCheck() {
  return Boolean(
    process.env.CI ||
      process.env.CODEX_CI ||
      process.env.CREATE_SERVICE_NO_UPDATE_CHECK ||
      process.env.BUN_TEST ||
      process.env.npm_lifecycle_event
  );
}

async function resolveLatestVersion() {
  const response = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
    signal: AbortSignal.timeout(1_500),
  });
  if (!response.ok) {
    return "";
  }
  const payload = (await response.json()) as { version?: string };
  return payload.version?.trim() ?? "";
}

function isVersionGreater(left: string, right: string) {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const [leftMajor = 0, leftMinor = 0, leftPatch = 0] = parse(left);
  const [rightMajor = 0, rightMinor = 0, rightPatch = 0] = parse(right);
  return (
    leftMajor > rightMajor ||
    (leftMajor === rightMajor && leftMinor > rightMinor) ||
    (leftMajor === rightMajor && leftMinor === rightMinor && leftPatch > rightPatch)
  );
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
  const target = await resolveTarget(args);
  const runtime = await resolveRuntime(args, target);
  const framework = await resolveFramework(args, target, runtime);
  validateTargetRuntimeFramework(target, runtime, framework);
  const modulePath = await resolveModulePath(args, runtime, defaults.modulePath);
  const discovery = await waitForDiscovery(discoveryPromise);
  const gcpSelection = await resolveGcpSelection(args, defaults, discovery);
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
    modulePath,
    target,
    runtime,
    framework,
    profile: args.profile,
    region,
    gcpProjectMode: gcpSelection.mode,
    gcpProject: gcpSelection.projectId,
    gcpProjectName: gcpSelection.projectName,
    billingAccount,
    quotaProjectId: args.quotaProjectId ?? QUOTA_PROJECT_DEFAULT,
    autoDeploy,
    neonDatabaseName: defaults.neonDatabaseName,
    apiHostname: defaults.apiHostname,
    generatorRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  };
}

async function waitForDiscovery(discoveryPromise: Promise<DiscoveryState>) {
  const indicator = spinner();
  indicator.start("Discovering GCP defaults");
  try {
    const discovery = await discoveryPromise;
    indicator.stop("GCP defaults discovered");
    return discovery;
  } catch (error) {
    indicator.stop("GCP defaults discovery failed");
    throw error;
  }
}

async function resolveTarget(args: ParsedArgs): Promise<DeployTarget> {
  if (args.target) {
    return args.target;
  }

  if (args.yes) {
    return "cloudrun";
  }

  const value = await select({
    message: "Deploy target",
    initialValue: "cloudrun",
    options: [
      { value: "cloudrun", label: "Cloud Run", hint: "Default" },
      { value: "workers", label: "Cloudflare Workers" },
    ],
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  return value as DeployTarget;
}

async function resolveRuntime(args: ParsedArgs, target: DeployTarget): Promise<Runtime> {
  if (args.runtime) {
    return args.runtime;
  }

  if (target === "workers") {
    return "bun";
  }

  if (args.yes) {
    return "go";
  }

  const value = await select({
    message: "Runtime",
    initialValue: target === "cloudrun" ? "go" : "bun",
    options:
      target === "cloudrun"
        ? [
            { value: "go", label: "Go", hint: "Default" },
            { value: "bun", label: "Bun" },
          ]
        : [{ value: "bun", label: "Bun/TypeScript", hint: "Workers runtime" }],
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  return value as Runtime;
}

async function resolveFramework(args: ParsedArgs, target: DeployTarget, runtime: Runtime): Promise<Framework> {
  const allowed = frameworksForTargetRuntime(target, runtime);
  if (args.framework) {
    if (allowed.some((framework) => framework === args.framework)) {
      return args.framework;
    }
    throw new Error(`Framework ${args.framework} is not valid for target ${target} and runtime ${runtime}`);
  }

  if (args.yes) {
    return target === "cloudrun" && runtime === "go" ? "connectrpc" : allowed[0]!;
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

  return value as Framework;
}

async function resolveModulePath(args: ParsedArgs, runtime: Runtime, initialValue: string) {
  if (runtime !== "go") {
    return args.modulePath ?? initialValue;
  }

  if (args.modulePath) {
    return args.modulePath.trim();
  }

  if (args.yes) {
    return initialValue;
  }

  return promptText("Go module path", initialValue, (value) => {
    if (!value.trim()) {
      return "Go module path is required";
    }
    return true;
  });
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

  return result;
}

export function assertDiscoveryReady(discovery: DiscoveryState) {
  return discovery;
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
  return false;
}

async function promptText(
  message: string,
  initialValue: string,
  validate: (value: string) => true | string
): Promise<string> {
  const value = await text({
    message,
    initialValue,
    validate: (input) => normalizeValidationResult(validate((input ?? "").trim())),
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

export function validateProfileRuntimeFramework(profile: Profile, runtime: Runtime, framework: Framework) {
  validateTargetRuntimeFramework("cloudrun", runtime, framework);
}

export function validateTargetRuntimeFramework(target: DeployTarget, runtime: Runtime, framework: Framework) {
  const allowed = frameworksForTargetRuntime(target, runtime);
  if (!allowed.some((candidate) => candidate === framework)) {
    throw new Error(`Framework ${framework} is not valid for target ${target} and runtime ${runtime}`);
  }
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
  bun run index.ts [service_id] [options]

Options:
  --target <cloudrun|workers>     Deploy target for the generated service
  --profile <microservice>        Compatibility no-op; app workspaces moved out
  --runtime <go|bun>              Runtime scaffold to generate
  --framework <name>              Framework for the selected runtime
  --module-path <path>            Go module path for generated Go scaffolds
  --project-mode <mode>           create_new or use_existing
  --project-id <id>               GCP project id
  --billing-account <name>        Billing account resource name
  --quota-project <id>            Billing quota project for gcloud calls
  --region <region>               Cloud Run region
  --auto-deploy                   Run service create after scaffold
  --no-auto-deploy                Scaffold only
  --auto-update                   Re-run through create-service@latest when a newer version exists
  --no-update-check               Skip the best-effort npm update check
  --yes, -y                       Accept defaults without prompts
  --help, -h                      Show this message
`);
}

function matchesProject(project: GcpProject, query: string) {
  return project.projectId === query || project.name === query;
}
