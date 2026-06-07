import { describe, expect, test } from "bun:test";
import { runParallelTasks } from "./parallel-tasks";

describe("runParallelTasks", () => {
  test("runs tasks concurrently and reports success as each task finishes", async () => {
    const completed: string[] = [];
    const startedAt = Date.now();

    await runParallelTasks(
      [
        { label: "slow", task: () => Bun.sleep(60) },
        { label: "fast", task: () => Bun.sleep(10) },
      ],
      { onSuccess: (label) => completed.push(label) }
    );

    expect(Date.now() - startedAt).toBeLessThan(100);
    expect(completed).toEqual(["fast", "slow"]);
  });

  test("collects multiple failures before throwing", async () => {
    const failures: string[] = [];

    await expect(
      runParallelTasks(
        [
          { label: "one", task: () => Promise.reject(new Error("first")) },
          { label: "two", task: () => Promise.reject(new Error("second")) },
        ],
        { onFailure: (label) => failures.push(label) }
      )
    ).rejects.toThrow("Destroy failed for one or more resource groups:");

    expect(failures.sort()).toEqual(["one", "two"]);
  });
});
