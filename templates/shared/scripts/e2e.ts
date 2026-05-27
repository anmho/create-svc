type Target = "local" | "prod";

export {};

type CommandOptions = {
  allowFailure?: boolean;
};

type CloudRunService = {
  status?: {
    latestReadyRevisionName?: string;
  };
};

type MonitoringSeries = {
  resource?: {
    labels?: Record<string, string>;
  };
  points?: Array<{
    value?: {
      int64Value?: string;
      doubleValue?: number;
    };
    interval?: {
      endTime?: string;
    };
  }>;
};

const args = parseArgs(Bun.argv.slice(2));
const serviceName = "{{SERVICE_NAME}}";
const projectId = "{{PROJECT_ID}}";
const region = "{{REGION}}";
const apiHostname = "{{API_HOSTNAME}}";
const baseUrl = args.url ?? (args.target === "prod" ? `https://${apiHostname}` : `http://127.0.0.1:${Bun.env.PORT || "3000"}`);
const proofId = `e2e-${Date.now()}-${Math.random().toString(16).slice(2)}`;

section(`${serviceName} ${args.target} e2e`);
detail("base_url", baseUrl);
detail("event_id", proofId);

await requestJSON(`${baseUrl}/healthz`, { expectStatus: 200 });

const webhookPayload = {
  id: proofId,
  source: "generated-e2e",
  service: serviceName,
  target: args.target,
};
const firstWebhook = await requestJSON(`${baseUrl}/webhooks/generated-e2e`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-webhook-event-id": proofId,
  },
  body: JSON.stringify(webhookPayload),
  expectStatus: 202,
});
detail("webhook_first", JSON.stringify(firstWebhook));

const secondWebhook = await requestJSON(`${baseUrl}/webhooks/generated-e2e`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-webhook-event-id": proofId,
  },
  body: JSON.stringify(webhookPayload),
  expectStatus: 200,
});
detail("webhook_duplicate", JSON.stringify(secondWebhook));
if (!isDuplicateWebhook(secondWebhook)) {
  throw new Error("second webhook delivery did not report duplicate=true");
}

if (args.target === "prod") {
  await Bun.sleep(5_000);
  const state = await printCloudRunState();
  await printCloudLogs(serviceName, state.apiRevision);
  await printCloudLogs(`${serviceName}-worker`, state.workerRevision);
  await printCloudMetrics(state);
}

section("e2e complete");

async function requestJSON(
  url: string,
  options: RequestInit & { expectStatus: number } = { expectStatus: 200 }
) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (response.status !== options.expectStatus) {
    throw new Error(`${url} returned ${response.status}, expected ${options.expectStatus}: ${text}`);
  }
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function isDuplicateWebhook(value: unknown) {
  return Boolean(value && typeof value === "object" && "duplicate" in value && value.duplicate === true);
}

async function printCloudRunState() {
  const [api, worker] = await Promise.all([
    describeCloudRunService(serviceName),
    describeCloudRunService(`${serviceName}-worker`),
  ]);
  const apiRevision = api.status?.latestReadyRevisionName ?? "";
  const workerRevision = worker.status?.latestReadyRevisionName ?? "";
  if (!apiRevision) {
    throw new Error(`Cloud Run service ${serviceName} did not report latestReadyRevisionName`);
  }
  if (!workerRevision) {
    throw new Error(`Cloud Run service ${serviceName}-worker did not report latestReadyRevisionName`);
  }
  detail("api_revision", apiRevision);
  detail("worker_revision", workerRevision);
  return { apiRevision, workerRevision };
}

async function describeCloudRunService(name: string): Promise<CloudRunService> {
  const output = await command([
    "gcloud",
    "run",
    "services",
    "describe",
    name,
    "--project",
    projectId,
    "--region",
    region,
    "--format=json",
  ]);
  return JSON.parse(output || "{}") as CloudRunService;
}

async function printCloudLogs(name: string, revision: string) {
  const filter = [
    'resource.type="cloud_run_revision"',
    `resource.labels.service_name="${name}"`,
    `resource.labels.revision_name="${revision}"`,
  ].join(" AND ");
  const output = await command([
    "gcloud",
    "logging",
    "read",
    filter,
    "--project",
    projectId,
    "--limit=3",
    "--format=json",
  ]);
  const rows = JSON.parse(output || "[]") as unknown[];
  section(`cloud logs ${name}`);
  if (rows.length === 0) {
    throw new Error(`Cloud Logging did not return rows for ${name} revision ${revision}`);
  }
  console.log(JSON.stringify(rows, null, 2));
}

async function printCloudMetrics(expected: { apiRevision: string; workerRevision: string }) {
  const expectedRevisions = new Set([expected.apiRevision, expected.workerRevision]);
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const rows = await readCloudMetrics();
    const seenRevisions = new Set(rows.map((row) => row.revision).filter(Boolean));
    section(`cloud metrics container/instance_count attempt ${attempt}`);
    for (const row of rows) {
      console.log(`${row.service}\t${row.revision}\t${row.value}\t${row.endTime}`);
    }
    const missing = [...expectedRevisions].filter((revision) => !seenRevisions.has(revision));
    if (missing.length === 0) {
      return;
    }
    if (attempt === 6) {
      throw new Error(`Cloud Monitoring did not return current revision metrics: ${missing.join(", ")}`);
    }
    detail("metrics_waiting_for_revisions", missing.join(", "));
    await Bun.sleep(20_000);
  }
}

async function readCloudMetrics() {
  const end = new Date().toISOString();
  const start = new Date(Date.now() - 20 * 60_000).toISOString();
  const accessToken = await command(["gcloud", "auth", "print-access-token"]);
  const filter = `metric.type="run.googleapis.com/container/instance_count" AND resource.labels.service_name=starts_with("${serviceName}")`;
  const url = new URL(`https://monitoring.googleapis.com/v3/projects/${projectId}/timeSeries`);
  url.searchParams.set("filter", filter);
  url.searchParams.set("interval.startTime", start);
  url.searchParams.set("interval.endTime", end);
  url.searchParams.set("aggregation.alignmentPeriod", "60s");
  url.searchParams.set("aggregation.perSeriesAligner", "ALIGN_SUM");
  url.searchParams.set("view", "FULL");
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Cloud Monitoring query failed: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as { timeSeries?: MonitoringSeries[] };
  return ((data.timeSeries ?? []) as MonitoringSeries[]).map((series) => {
    const labels = series.resource?.labels ?? {};
    const point = series.points?.[0];
    const value = point?.value?.int64Value ?? point?.value?.doubleValue ?? "";
    return {
      service: labels.service_name ?? "",
      revision: labels.revision_name ?? "",
      value,
      endTime: point?.interval?.endTime ?? "",
    };
  });
}

async function command(commandArgs: string[], options: CommandOptions = {}) {
  const process = Bun.spawn(commandArgs, {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: Bun.env,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`${commandArgs.join(" ")} failed with exit code ${exitCode}\n${stderr.trim()}`);
  }
  return stdout.trim();
}

function parseArgs(argv: string[]) {
  let target: Target = "local";
  let url = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--local") {
      target = "local";
    } else if (arg === "--prod") {
      target = "prod";
    } else if (arg === "--url") {
      const value = argv[index + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("Missing value for --url");
      }
      url = value;
      index += 1;
    } else if (arg.startsWith("--url=")) {
      url = arg.slice("--url=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: bun run ./scripts/e2e.ts [--local|--prod] [--url <origin>]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { target, url };
}

function section(title: string) {
  console.log(`\n== ${title} ==`);
}

function detail(key: string, value: string) {
  console.log(`${key}: ${value}`);
}
