import { expect, test } from "bun:test";
import { detectDownloadPlatform, selectStoreUrl, type DownloadConfig } from "../app/download-links";

const config: DownloadConfig = {
  appDeepLink: "personaltracker://open",
  iosStoreUrl: "https://apps.apple.com/app/example",
  androidStoreUrl: "https://play.google.com/store/apps/details?id=example",
};

test("detects iOS user agents", () => {
  expect(detectDownloadPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("ios");
  expect(detectDownloadPlatform("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)")).toBe("ios");
});

test("detects Android user agents", () => {
  expect(detectDownloadPlatform("Mozilla/5.0 (Linux; Android 14; Pixel 8)")).toBe("android");
});

test("returns unknown for desktop user agents", () => {
  expect(detectDownloadPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("unknown");
});

test("selects the configured platform store URL", () => {
  expect(selectStoreUrl("ios", config)).toBe(config.iosStoreUrl);
  expect(selectStoreUrl("android", config)).toBe(config.androidStoreUrl);
});

test("does not select empty store URLs", () => {
  expect(
    selectStoreUrl("ios", {
      ...config,
      iosStoreUrl: "",
    })
  ).toBeUndefined();
  expect(selectStoreUrl("unknown", config)).toBeUndefined();
});
