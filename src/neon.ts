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
      const projects = ((payload.data as { projects?: Array<{ id?: string; name?: string }> } | undefined)?.projects ?? []);
      return projects
        .map((project: { id?: string; name?: string }) => ({
          id: project.id ?? "",
          name: project.name ?? project.id ?? "",
        }))
        .filter((project: NeonProject) => Boolean(project.id))
        .sort((left: NeonProject, right: NeonProject) => left.name.localeCompare(right.name));
    },

    async listBranches(projectId: string) {
      const client = createApiClient({ apiKey: (apiKey?.trim() || (await resolveNeonApiKey())) });
      const payload = await client.listProjectBranches({ projectId });
      const branches = ((payload.data as { branches?: Array<{ id?: string; name?: string }> } | undefined)?.branches ?? []);
      return branches
        .map((branch: { id?: string; name?: string }) => ({
          id: branch.id ?? "",
          name: branch.name ?? branch.id ?? "",
        }))
        .filter((branch: NeonBranch) => Boolean(branch.id))
        .sort((left: NeonBranch, right: NeonBranch) => left.name.localeCompare(right.name));
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
