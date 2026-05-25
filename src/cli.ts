import { autocomplete, cancel, intro, isCancel, log, note, outro, select, spinner, text } from "@clack/prompts";
import pc from "picocolors";
import { readdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDeploymentVerificationCommands, buildLocalVerificationCommands, runPostScaffoldFlow, runPreGitBootstrapFlow } from "./post-scaffold";
import {
  bootstrapGitHubRepository,
  buildGitBootstrapConfig,
  commitAndPushGeneratedArtifacts,
  markGitHubRepositoryDeleteOnDestroy,
  type GitBootstrapResult,
} from "./git-bootstrap";
import {
  assertExistingProjectReadyForAutoDeploy,
  listOpenBillingAccounts,
  listAccessibleProjects,
  type BillingAccount,
  type GcpProject,
} from "./gcp";
import {
  BILLING_ACCOUNT_DEFAULT,
  QUOTA_PROJECT_DEFAULT,
  SERVICES_PROJECT_DEFAULT,
  SERVICES_PROJECT_NAME_DEFAULT,
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
  serviceName?: string;
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
  noGit?: boolean;
  profile: Profile;
  yes: boolean;
  help: boolean;
};

type DiscoveryState = {
  projects: GcpProject[];
  billingAccounts: BillingAccount[];
  warnings: string[];
};

type GcpSelection = {
  mode: GcpProjectMode;
  projectId: string;
  projectName: string;
};

type InteractiveStep = "serviceName" | "target" | "runtime" | "framework" | "modulePath" | "gcp" | "confirm";

type InteractiveState = {
  serviceName?: string;
  target?: DeployTarget;
  runtime?: Runtime;
  framework?: Framework;
  modulePath?: string;
  gcpSelection?: GcpSelection;
};

const DEFAULT_REGION = "us-west1";
const BACK = "__back__" as const;

export async function run(argv: string[]) {
  try {
    const args = parseArgs(argv);
    if (args.help) {
      printHelp();
      return;
    }

    intro(`${pc.bold("service")} ${pc.dim("microservice bootstrap")}`);

    const config = await resolveConfig(args);
    const targetDir = resolve(process.cwd(), config.directory);
    await assertPreScaffoldReady(config);

    note(
      [
        `${pc.bold("Output")}: ${targetDir}`,
        `${pc.bold("Target")}: ${config.target}`,
        `${pc.bold("Runtime")}: ${config.runtime} + ${config.framework}`,
        `${pc.bold("Project")}: ${config.gcpProjectMode === "create_new" ? "create" : "use"} ${config.gcpProjectName} (${config.gcpProject})`,
        `${pc.bold("API")}: https://${config.apiHostname}`,
        `${pc.bold("Local DB")}: docker compose postgres`,
        `${pc.bold("GitHub")}: ${config.git.enabled ? `anmho/${config.git.repository}` : "disabled"}`,
      ].join("\n"),
      "Scaffold"
    );

    const buildSpinner = spinner();
    buildSpinner.start("Generating project files");
    await scaffoldProject(config);
    buildSpinner.stop("Project files generated");

    const preGitResult = runPreGitBootstrapFlow(config, targetDir);
    if (preGitResult.changed) {
      log.step("Generated local SDK artifacts before initial GitHub push");
    }

    const gitSpinner = spinner();
    gitSpinner.start("Preparing git repository");
    const gitResult = await bootstrapGitHubRepository(targetDir, config.git);
    if (gitResult.status === "created") {
      await markGitHubRepositoryDeleteOnDestroy(targetDir);
      gitSpinner.stop(`GitHub repository created: ${gitResult.url}`);
    } else if (gitResult.status === "skipped-existing-worktree") {
      gitSpinner.stop(`Existing git worktree detected: ${gitResult.root}`);
    } else {
      gitSpinner.stop("Git bootstrap disabled");
    }

    const shouldRunPostScaffoldFlow = config.autoDeploy;
    if (shouldRunPostScaffoldFlow) {
      const automationSpinner = spinner();
      automationSpinner.start("Running post-scaffold automation");
      try {
        const result = await runPostScaffoldFlow(config, targetDir);
        automationSpinner.stop(result.message);
      } catch (error) {
        automationSpinner.stop("Post-scaffold automation failed");
        throw error;
      }

      if (gitResult.status === "created") {
        const publishSpinner = spinner();
        publishSpinner.start("Publishing generated artifacts");
        const result = commitAndPushGeneratedArtifacts(targetDir, "Record generated deployment artifacts");
        publishSpinner.stop(result.committed ? "Generated artifacts committed and pushed" : "Generated artifacts already committed");
      }
    } else if (gitResult.status === "created") {
      const publishSpinner = spinner();
      publishSpinner.start("Publishing generated git ownership");
      const result = commitAndPushGeneratedArtifacts(targetDir, "Record generated GitHub ownership");
      publishSpinner.stop(result.committed ? "GitHub ownership committed and pushed" : "GitHub ownership already committed");
    }

    outro(config.autoDeploy ? "Created and deployed" : "Created");
    console.log(formatCompletionSummary(config, targetDir, gitResult));
  } catch (error) {
    handleCliError(error);
  }
}

function formatCompletionSummary(config: ScaffoldConfig, targetDir: string, gitResult: GitBootstrapResult) {
  const isBun = config.runtime === "bun";
  const devCommand = isBun ? "bun run dev" : "make dev";
  const migrateCommand = isBun ? "bun run migrate" : "make migrate";
  const lifecycleCommands: Array<[string, string]> = config.autoDeploy
    ? [
        ["service deploy", "Deploys later changes."],
        [`service deploy --environment personal --name ${config.serviceName}`, "Deploys your personal environment."],
      ]
    : [
        ["service create", "Provisions auth, database, migrations, and the first deploy."],
        ["service deploy", "Deploys later changes."],
      ];
  const repository =
    gitResult.status === "created"
      ? gitResult.url
      : config.git.enabled
        ? `https://github.com/${config.git.owner}/${config.git.repository}`
        : undefined;

  return [
    "",
    `Success! Created ${config.serviceName} at ${targetDir}`,
    "",
    "Inside that directory, you can run:",
    formatCommand(devCommand, "Starts local development."),
    formatCommand(migrateCommand, "Applies local database migrations."),
    ...lifecycleCommands.map(([command, description]) => formatCommand(command, description)),
    "",
    "Control-plane defaults:",
    `  Auth issuer: https://auth.anmho.com/api/auth`,
    `  Auth resource: api://${config.serviceName}`,
    `  Auth token URL: https://auth.anmho.com/api/auth/oauth2/token`,
    ...(config.target === "workers"
      ? [
          `  Trigger.dev task: ${config.serviceName}-waitlist-follow-up`,
          `  Trigger.dev project env: TRIGGER_PROJECT_REF`,
          `  Trigger.dev deploy env: TRIGGER_ACCESS_TOKEN`,
          `  Trigger.dev secret env: TRIGGER_SECRET_KEY`,
        ]
      : [
          `  Temporal: enabled by default`,
          `  Temporal address: localhost:7233`,
          `  Temporal task queue: ${config.serviceName}`,
          `  Temporal API key secret: ${config.serviceName}-temporal-api-key`,
        ]),
    config.runtime === "go" ? `  Go module: ${config.modulePath}` : undefined,
    "",
    config.autoDeploy ? "Verified production after deploy:" : "After deploy, verify production with:",
    ...buildDeploymentVerificationCommands(config).map(formatShellCommand),
    config.autoDeploy ? "" : undefined,
    config.autoDeploy ? "Local dev started:" : undefined,
    config.autoDeploy ? "  .service/local-dev.pid" : undefined,
    config.autoDeploy ? "  .service/local-dev.log" : undefined,
    config.autoDeploy ? "" : undefined,
    config.autoDeploy ? "Verified local dev:" : undefined,
    ...(config.autoDeploy ? buildLocalVerificationCommands(config).map(formatShellCommand) : []),
    "",
    config.autoDeploy ? "Next:" : "We suggest that you begin by typing:",
    "",
    `  cd ${config.directory}`,
    config.autoDeploy ? "  tail -f .service/local-dev.log" : `  ${devCommand}`,
    "",
    repository ? `Repository: ${repository}` : undefined,
    `Production API: https://${config.apiHostname}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCommand(command: string, description: string) {
  return [`  ${command}`, `    ${description}`].join("\n");
}

function formatShellCommand(command: { command: string; args: string[] }) {
  return `  ${[command.command, ...command.args].join(" ")}`;
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

    if (!token.startsWith("-") && !parsed.serviceName) {
      parsed.serviceName = token;
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

    if (token === "--no-git") {
      parsed.noGit = true;
      continue;
    }

    if (token === "--runtime") {
      parsed.runtime = readValue() as Runtime;
      continue;
    }

    if (token === "--dir") {
      parsed.directory = readValue();
      continue;
    }

    if (token.startsWith("--dir=")) {
      parsed.directory = token.slice("--dir=".length);
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

export async function resolveConfig(args: ParsedArgs): Promise<ScaffoldConfig> {
  const inferredName = slugify(args.serviceName ?? basename(args.directory ?? "my-service"));
  if (!args.yes) {
    return resolveInteractiveConfig(args, inferredName);
  }

  const serviceName = inferredName;
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
  if (gcpSelection === BACK) {
    throw new Error("Unexpected back navigation in non-interactive config");
  }
  const region = args.region ?? DEFAULT_REGION;
  const billingAccount = chooseBillingAccount(args.billingAccount, discovery.billingAccounts);
  const autoDeploy = resolveAutoDeploy(args.autoDeploy);
  const git = buildGitBootstrapConfig(serviceName, args.noGit);

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
    git,
    neonDatabaseName: defaults.neonDatabaseName,
    apiHostname: defaults.apiHostname,
    generatorRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  };
}

async function resolveInteractiveConfig(args: ParsedArgs, initialServiceName: string): Promise<ScaffoldConfig> {
  const state: InteractiveState = {
    serviceName: args.serviceName ? slugify(args.serviceName) : undefined,
    target: args.target,
    runtime: args.runtime,
    framework: args.framework,
    modulePath: args.modulePath,
  };
  let serviceNameDraft = state.serviceName ?? initialServiceName;
  let discovery: DiscoveryState | undefined;
  const discoveryPromise = discoverCloudInputs();
  let step: InteractiveStep = state.serviceName ? "target" : "serviceName";

  while (true) {
    if (step === "serviceName") {
      const value = await promptText("Service name", serviceNameDraft, (input) => validateServiceNameInput(input, args.directory));
      serviceNameDraft = value;
      state.serviceName = value;
      step = "target";
      continue;
    }

    if (!state.serviceName) {
      step = "serviceName";
      continue;
    }

    const defaults = deriveDefaults(state.serviceName);

    if (step === "target") {
      if (args.target) {
        state.target = args.target;
      } else {
        const value = await promptSelectWithBack<DeployTarget>(
          "Deploy target",
          [
            { value: "cloudrun", label: "Cloud Run", hint: "Default" },
            { value: "workers", label: "Cloudflare Workers" },
          ],
          "cloudrun",
          step,
          args,
          state
        );
        if (value === BACK) {
          step = previousPromptStep(step, args, state) ?? step;
          continue;
        }
        state.target = value;
        state.runtime = undefined;
        state.framework = undefined;
      }
      step = "runtime";
      continue;
    }

    if (step === "runtime") {
      if (!state.target) {
        step = "target";
        continue;
      }
      if (state.target === "workers") {
        state.runtime = "bun";
      } else if (args.runtime) {
        state.runtime = args.runtime;
      } else {
        const value = await promptSelectWithBack<Runtime>(
          "Runtime",
          [
            { value: "go", label: "Go", hint: "Default" },
            { value: "bun", label: "Bun" },
          ],
          "go",
          step,
          args,
          state
        );
        if (value === BACK) {
          step = previousPromptStep(step, args, state) ?? step;
          continue;
        }
        state.runtime = value;
        state.framework = undefined;
      }
      step = "framework";
      continue;
    }

    if (step === "framework") {
      if (!state.target || !state.runtime) {
        step = state.target ? "runtime" : "target";
        continue;
      }
      const allowed = frameworksForTargetRuntime(state.target, state.runtime);
      if (args.framework) {
        if (!allowed.some((framework) => framework === args.framework)) {
          throw new Error(`Framework ${args.framework} is not valid for target ${state.target} and runtime ${state.runtime}`);
        }
        state.framework = args.framework;
      } else {
        const value = await promptSelectWithBack<Framework>(
          "Framework",
          allowed.map((framework, index) => ({
            value: framework,
            label: framework,
            hint: index === 0 ? "Default" : undefined,
          })),
          allowed[0],
          step,
          args,
          state
        );
        if (value === BACK) {
          step = previousPromptStep(step, args, state) ?? step;
          continue;
        }
        state.framework = value;
      }
      step = "modulePath";
      continue;
    }

    if (step === "modulePath") {
      if (!state.runtime) {
        step = "runtime";
        continue;
      }
      if (state.runtime !== "go") {
        state.modulePath = args.modulePath ?? defaults.modulePath;
      } else if (args.modulePath) {
        state.modulePath = args.modulePath.trim();
      } else {
        const value = await promptTextWithBack(
          "Go module path",
          state.modulePath ?? defaults.modulePath,
          (input) => {
            if (!input.trim()) {
              return "Go module path is required";
            }
            return true;
          },
          step,
          args,
          state
        );
        if (value === BACK) {
          step = previousPromptStep(step, args, state) ?? step;
          continue;
        }
        state.modulePath = value;
      }
      step = "gcp";
      continue;
    }

    if (step === "gcp") {
      discovery ??= await waitForDiscovery(discoveryPromise);
      const value = await resolveGcpSelection(args, defaults, discovery, {
        allowBack: Boolean(previousPromptStep(step, args, state)),
      });
      if (value === BACK) {
        step = previousPromptStep(step, args, state) ?? step;
        continue;
      }
      state.gcpSelection = value;
      step = "confirm";
      continue;
    }

    if (step === "confirm") {
      if (!state.target || !state.runtime || !state.framework || !state.modulePath || !state.gcpSelection) {
        step = "serviceName";
        continue;
      }
      const value = await promptSelectWithBack<"create">(
        "Create the scaffold with these defaults?",
        [{ value: "create", label: "Create scaffold", hint: "Default" }],
        "create",
        step,
        args,
        state
      );
      if (value === BACK) {
        step = previousPromptStep(step, args, state) ?? step;
        continue;
      }

      const directory = args.directory ?? state.serviceName;
      const targetDir = resolve(process.cwd(), directory);
      await assertTargetDirectoryIsEmpty(targetDir);
      const billingAccount = chooseBillingAccount(args.billingAccount, discovery?.billingAccounts ?? []);

      for (const warning of discovery?.warnings ?? []) {
        log.warn(warning);
      }

      return {
        directory,
        serviceName: state.serviceName,
        modulePath: state.modulePath,
        target: state.target,
        runtime: state.runtime,
        framework: state.framework,
        profile: args.profile,
        region: args.region ?? DEFAULT_REGION,
        gcpProjectMode: state.gcpSelection.mode,
        gcpProject: state.gcpSelection.projectId,
        gcpProjectName: state.gcpSelection.projectName,
        billingAccount,
        quotaProjectId: args.quotaProjectId ?? QUOTA_PROJECT_DEFAULT,
        autoDeploy: resolveAutoDeploy(args.autoDeploy),
        git: buildGitBootstrapConfig(state.serviceName, args.noGit),
        neonDatabaseName: defaults.neonDatabaseName,
        apiHostname: defaults.apiHostname,
        generatorRoot: resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      };
    }
  }
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
  discovery: DiscoveryState,
  options: { allowBack?: boolean } = {}
): Promise<GcpSelection | typeof BACK> {
  if (args.gcpProject && !args.gcpProjectMode) {
    const existing = discovery.projects.find((project) => matchesProject(project, args.gcpProject ?? ""));
    return {
      mode: "use_existing" as const,
      projectId: args.gcpProject,
      projectName: existing?.name ?? args.gcpProject,
    };
  }

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
      projectId: args.gcpProject ?? SERVICES_PROJECT_DEFAULT,
      projectName: existing?.name ?? args.gcpProject ?? SERVICES_PROJECT_NAME_DEFAULT,
    };
  }

  if (args.yes) {
    return sharedServicesProjectSelection(discovery);
  }

  const mode = await select({
    message: "GCP project",
    initialValue: "use_shared",
    options: [
      ...(options.allowBack
        ? [
            {
              value: BACK,
              label: "Back",
              hint: "Return to previous step",
            },
          ]
        : []),
      {
        value: "use_shared",
        label: `Use shared services project: ${sharedServicesProjectSelection(discovery).projectName} (${SERVICES_PROJECT_DEFAULT})`,
        hint: "Default",
      },
      {
        value: "create_new",
        label: `Create new project: ${defaults.projectName} (${defaults.projectId})`,
        hint: "May hit billing quota limits",
      },
      {
        value: "use_existing",
        label: "Use another existing project...",
        hint: discovery.projects.length > 0 ? `${discovery.projects.length} available` : "Pass --project-id to use an undiscovered project",
      },
    ],
  });

  if (isCancel(mode)) {
    cancel("Aborted");
    process.exit(1);
  }

  if (mode === BACK) {
    return BACK;
  }

  if (mode === "use_shared") {
    return sharedServicesProjectSelection(discovery);
  }

  if (mode === "create_new") {
    return {
      mode: "create_new" as const,
      projectId: defaults.projectId,
      projectName: defaults.projectName,
    };
  }

  if (discovery.projects.length === 0) {
    return sharedServicesProjectSelection(discovery);
  }

  const selected = await promptForExistingProject(discovery.projects, options);
  if (selected === BACK) {
    return BACK;
  }
  if (!selected) {
    return resolveGcpSelection(
      {
        ...args,
        gcpProjectMode: undefined,
        gcpProject: undefined,
      },
      defaults,
      discovery,
      options
    );
  }

  return {
    mode: selected.mode,
    projectId: selected.projectId,
    projectName: selected.projectName,
  };
}

function sharedServicesProjectSelection(discovery: DiscoveryState): GcpSelection {
  const project = discovery.projects.find((candidate) => candidate.projectId === SERVICES_PROJECT_DEFAULT);
  return {
    mode: "use_existing" as const,
    projectId: SERVICES_PROJECT_DEFAULT,
    projectName: project?.name ?? SERVICES_PROJECT_NAME_DEFAULT,
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

async function assertPreScaffoldReady(config: ScaffoldConfig) {
  if (config.target !== "cloudrun" || !config.autoDeploy || config.gcpProjectMode !== "use_existing") {
    return;
  }

  await assertExistingProjectReadyForAutoDeploy(config.gcpProject);
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

export function resolveAutoDeploy(value: boolean | undefined) {
  if (value !== undefined) {
    return value;
  }
  return true;
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

async function promptTextWithBack(
  message: string,
  initialValue: string,
  validate: (value: string) => true | string,
  step: InteractiveStep,
  args: ParsedArgs,
  state: InteractiveState
): Promise<string | typeof BACK> {
  const allowBack = Boolean(previousPromptStep(step, args, state));
  const value = await text({
    message: allowBack ? `${message} (type "back" to return)` : message,
    initialValue,
    validate: (input) => {
      const normalized = (input ?? "").trim().toLowerCase();
      if (allowBack && (normalized === "back" || normalized === "<")) {
        return undefined;
      }
      return normalizeValidationResult(validate((input ?? "").trim()));
    },
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  const trimmed = value.trim();
  if (allowBack && (trimmed.toLowerCase() === "back" || trimmed === "<")) {
    return BACK;
  }

  return trimmed;
}

async function promptSelectWithBack<Value extends string>(
  message: string,
  options: Array<{ value: Value; label?: string; hint?: string; disabled?: boolean }>,
  initialValue: Value | undefined,
  step: InteractiveStep,
  args: ParsedArgs,
  state: InteractiveState
): Promise<Value | typeof BACK> {
  const allowBack = Boolean(previousPromptStep(step, args, state));
  const value = await select<Value | typeof BACK>({
    message,
    initialValue,
    options: [
      ...(allowBack
        ? [
            {
              value: BACK,
              label: "Back",
              hint: "Return to previous step",
            },
          ]
        : []),
      ...options,
    ] as any,
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  return value;
}

function previousPromptStep(step: InteractiveStep, args: ParsedArgs, state: InteractiveState): InteractiveStep | undefined {
  const steps: InteractiveStep[] = ["serviceName", "target", "runtime", "framework", "modulePath", "gcp", "confirm"];
  const currentIndex = steps.indexOf(step);
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = steps[index];
    if (candidate && isPromptableStep(candidate, args, state)) {
      return candidate;
    }
  }
  return undefined;
}

function isPromptableStep(step: InteractiveStep, args: ParsedArgs, state: InteractiveState) {
  if (step === "serviceName") {
    return !args.serviceName;
  }
  if (step === "target") {
    return !args.target;
  }
  if (step === "runtime") {
    return state.target !== "workers" && !args.runtime;
  }
  if (step === "framework") {
    return !args.framework;
  }
  if (step === "modulePath") {
    return state.runtime === "go" && !args.modulePath;
  }
  if (step === "gcp") {
    return !args.gcpProjectMode;
  }
  return step === "confirm";
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

async function promptForExistingProject(projects: GcpProject[], options: { allowBack?: boolean } = {}) {
  const value = await autocomplete({
    message: "Existing GCP project",
    placeholder: "Search by project name or id",
    maxItems: 10,
    options: [
      ...(options.allowBack
        ? [
            {
              value: BACK,
              label: "Back",
              hint: "Return to project mode",
            },
          ]
        : []),
      ...projects.map((project) => ({
        value: project.projectId,
        label: project.name ?? project.projectId,
        hint: project.projectId,
      })),
    ],
  });

  if (isCancel(value)) {
    cancel("Aborted");
    process.exit(1);
  }

  if (value === BACK) {
    return BACK;
  }

  const project = projects.find((candidate) => candidate.projectId === value);
  if (project) {
    return {
      mode: "use_existing" as const,
      projectId: project.projectId,
      projectName: project.name ?? project.projectId,
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
  console.log(formatScaffoldHelp());
}

export function formatScaffoldHelp() {
  return [
    "Usage:",
    "  service new <service_id> [options]",
    "  service create <service_id> [options]",
    "",
    "Examples:",
    "  service new waitlist-api --target cloudrun --runtime bun --framework hono",
    "  service new waitlist-api --auto-deploy",
    "  service create waitlist-api --yes",
    "",
    "Options:",
    "  --dir <path>                    Output directory; defaults to ./<service_id>",
    "  --target <cloudrun|workers>     Deploy target for the generated service",
    "  --runtime <go|bun>              Runtime scaffold to generate",
    "  --framework <name>              Framework for the selected runtime",
    "  --module-path <path>            Go module path for generated Go scaffolds",
    "  --project-mode <mode>           create_new or use_existing",
    "  --project-id <id>               GCP project id",
    "  --billing-account <name>        Billing account resource name",
    "  --quota-project <id>            Billing quota project for gcloud calls",
    "  --region <region>               Cloud Run region",
    "  --auto-deploy                   Scaffold, run service create, verify prod/local, and start local dev (default)",
    "  --no-auto-deploy                Scaffold only",
    "  --no-git                        Skip default private GitHub repo: anmho/<service_id>",
    "  --yes, -y                       Accept defaults without prompts",
    "  --help, -h                      Show this message",
    "",
    "Inside a generated service repo, run service --help for create, deploy, doctor, auth, and sdk commands.",
  ].join("\n");
}

function matchesProject(project: GcpProject, query: string) {
  return project.projectId === query || project.name === query;
}
