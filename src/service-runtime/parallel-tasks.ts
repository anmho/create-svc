export type ParallelTask = {
  label: string;
  task: () => Promise<unknown> | unknown;
};

type ParallelTaskOptions = {
  onSuccess?: (label: string) => void;
  onFailure?: (label: string, error: unknown) => void;
  formatError?: (error: unknown) => string;
};

export async function runParallelTasks(tasks: ParallelTask[], options: ParallelTaskOptions = {}) {
  const failures: string[] = [];
  const format = options.formatError ?? defaultFormatError;

  await Promise.all(
    tasks.map(async ({ label, task }) => {
      try {
        await task();
        options.onSuccess?.(label);
      } catch (error) {
        failures.push(`${label}: ${format(error)}`);
        options.onFailure?.(label, error);
      }
    })
  );

  if (failures.length > 0) {
    throw new Error(["Destroy failed for one or more resource groups:", ...failures.map((failure) => `- ${failure}`)].join("\n"));
  }
}

function defaultFormatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
