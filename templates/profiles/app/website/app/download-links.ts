export type DownloadPlatform = "ios" | "android" | "unknown";

export type DownloadConfig = {
  appDeepLink: string;
  iosStoreUrl: string;
  androidStoreUrl: string;
};

export function detectDownloadPlatform(userAgent: string): DownloadPlatform {
  if (/\b(iPhone|iPad|iPod)\b/i.test(userAgent)) {
    return "ios";
  }

  if (/\bAndroid\b/i.test(userAgent)) {
    return "android";
  }

  return "unknown";
}

export function isConfiguredStoreUrl(url: string | undefined): url is string {
  return Boolean(url?.trim());
}

export function selectStoreUrl(platform: DownloadPlatform, config: DownloadConfig) {
  if (platform === "ios" && isConfiguredStoreUrl(config.iosStoreUrl)) {
    return config.iosStoreUrl;
  }

  if (platform === "android" && isConfiguredStoreUrl(config.androidStoreUrl)) {
    return config.androidStoreUrl;
  }

  return undefined;
}

export function hasAnyStoreUrl(config: DownloadConfig) {
  return isConfiguredStoreUrl(config.iosStoreUrl) || isConfiguredStoreUrl(config.androidStoreUrl);
}
