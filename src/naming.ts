export const BILLING_ACCOUNT_DEFAULT = "billingAccounts/01BD2E-3A6949-8F4C84";
export const QUOTA_PROJECT_DEFAULT = "anmho-infra-prod";

export const FRAMEWORKS_BY_RUNTIME = {
  go: ["chi", "connectrpc"],
  bun: ["hono", "connectrpc"],
} as const;

export type Runtime = keyof typeof FRAMEWORKS_BY_RUNTIME;
export type Framework = (typeof FRAMEWORKS_BY_RUNTIME)[Runtime][number];
export type GcpProjectMode = "create_new" | "use_existing";

export function slugify(value: string, maxLength = 63) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

export function compactIdentifier(
  value: string,
  maxLength: number,
  options: {
    separator?: "-" | "_";
    invalidPattern?: RegExp;
    trimPattern?: RegExp;
  } = {}
) {
  const separator = options.separator ?? "-";
  const invalidPattern = options.invalidPattern ?? /[^a-z0-9-]+/g;
  const trimPattern = options.trimPattern ?? /^-+|-+$/g;

  const normalized = value
    .toLowerCase()
    .replace(invalidPattern, separator)
    .replace(trimPattern, "");

  if (normalized.length <= maxLength) {
    return normalized || "service";
  }

  const hash = shortHash(normalized);
  const head = normalized.slice(0, Math.max(1, maxLength - hash.length - 1)).replace(new RegExp(`${separator}+$`), "");
  return `${head}${separator}${hash}`;
}

export function compactDatabaseName(serviceName: string) {
  return compactIdentifier(serviceName.replace(/-/g, "_"), 63, {
    separator: "_",
    invalidPattern: /[^a-z0-9_]+/g,
    trimPattern: /^_+|_+$/g,
  });
}

export function deriveDefaults(serviceName: string) {
  const normalizedServiceName = slugify(serviceName) || "my-service";

  return {
    serviceName: normalizedServiceName,
    projectName: normalizedServiceName,
    projectId: compactIdentifier(`anmho-${normalizedServiceName}`, 30),
    githubRepo: `anmho/${normalizedServiceName}`,
    cloudRunService: normalizedServiceName,
    neonDatabaseName: compactDatabaseName(normalizedServiceName),
  };
}

export function buildCreateProjectLabel(serviceName: string, projectId: string) {
  return `Create new project: ${serviceName} (${projectId})`;
}

export function buildGcpProjectOptions(
  serviceName: string,
  projectId: string,
  projectName: string,
  projects: Array<{ projectId: string; name: string }>
) {
  return [
    {
      label: buildCreateProjectLabel(serviceName, projectId),
      mode: "create_new" as const,
      projectId,
      projectName,
    },
    ...projects.map((project) => ({
      label: `Use existing project: ${project.name} (${project.projectId})`,
      mode: "use_existing" as const,
      projectId: project.projectId,
      projectName: project.name,
    })),
  ];
}

function shortHash(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).slice(0, 8);
}
