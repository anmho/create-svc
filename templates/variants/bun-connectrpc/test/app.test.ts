import { expect, test } from "bun:test";
import { createDnsService } from "../src/index";

test("listRecords starts empty", async () => {
  const service = createDnsService();
  const response = await service.listRecords?.({} as never, {} as never);

  expect(response).toEqual({ records: [] });
});
