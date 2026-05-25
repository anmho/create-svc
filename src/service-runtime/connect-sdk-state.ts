export type SdkState = {
  mode?: string;
  module?: string;
  remote?: {
    commit?: string;
    digest?: string;
  };
};

export function formatSdkModeDetail(state: SdkState, fallbackModule: string) {
  if (state.mode !== "local" && state.mode !== "remote") {
    throw new Error("SDK mode must be local or remote");
  }
  const module = state.module || fallbackModule;
  if (state.mode === "remote") {
    const version = state.remote?.commit ? `@${state.remote.commit}` : "without recorded commit";
    const digest = state.remote?.digest ? ` (${state.remote.digest})` : "";
    return `${state.mode}: ${module}${version}${digest}`;
  }
  return `${state.mode}: ${module}`;
}
