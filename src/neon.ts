import { createApiClient } from "@neondatabase/api-client";
import { resolveNeonApiKey } from "./vault";

export type NeonProject = {
  id: string;
  name: string;
};

export type NeonBranch = {
  id: string;
  name: string;
};

export type NeonApi = {
  listProjects(): Promise<NeonProject[]>;
  listBranches(projectId: string): Promise<NeonBranch[]>;
};

export function createNeonApi(apiKey = process.env.NEON_API_KEY): NeonApi {
  return {
    async listProjects() {
      const client = createApiClient({ apiKey: (apiKey?.trim() || (await resolveNeonApiKey())) });
      const payload = await client.listProjects({ limit: 100 });
      return (payload.projects ?? [])
        .map((project) => ({
          id: project.id ?? "",
          name: project.name ?? project.id ?? "",
        }))
        .filter((project) => project.id)
        .sort((left, right) => left.name.localeCompare(right.name));
    },

    async listBranches(projectId: string) {
      const client = createApiClient({ apiKey: (apiKey?.trim() || (await resolveNeonApiKey())) });
      const payload = await client.listProjectBranches({ projectId });
      return (payload.branches ?? [])
        .map((branch) => ({
          id: branch.id ?? "",
          name: branch.name ?? branch.id ?? "",
        }))
        .filter((branch) => branch.id)
        .sort((left, right) => left.name.localeCompare(right.name));
    },
  };
}

export async function listProjects(api = createNeonApi()): Promise<NeonProject[]> {
  return api.listProjects();
}

export async function listBranches(projectId: string, api = createNeonApi()): Promise<NeonBranch[]> {
  return api.listBranches(projectId);
}

export async function discoverNeonDefaults(serviceLabel = "this service", api = createNeonApi()) {
  const projects = await listProjects(api);
  const project = projects[0];
  if (!project) {
    throw new Error(`No Neon projects are available for ${serviceLabel}`);
  }

  const branches = await listBranches(project.id, api);
  const branch = branches.find((candidate) => candidate.name === "main") ?? branches[0];
  if (!branch) {
    throw new Error(`No Neon branches are available in project ${project.id}`);
  }

  return {
    projectId: project.id,
    baseBranchId: branch.id,
    baseBranchName: branch.name,
  };
}
