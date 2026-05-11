"use client";

import { useState } from "react";
import { detectDownloadPlatform, selectStoreUrl, type DownloadConfig } from "./download-links";

type DownloadLinkButtonProps = {
  config: DownloadConfig;
};

export function DownloadLinkButton({ config }: DownloadLinkButtonProps) {
  const [fallbackMessage, setFallbackMessage] = useState<string | null>(null);

  function openApp() {
    setFallbackMessage(null);
    const platform = detectDownloadPlatform(window.navigator.userAgent);
    const fallbackUrl = selectStoreUrl(platform, config);

    window.location.href = config.appDeepLink;

    window.setTimeout(() => {
      if (document.visibilityState !== "visible") {
        return;
      }

      if (fallbackUrl) {
        window.location.href = fallbackUrl;
        return;
      }

      setFallbackMessage("Store links are not configured yet. Use the download links below when they are available.");
    }, 900);
  }

  return (
    <div className="cta-stack">
      <button className="primary-action" type="button" onClick={openApp}>
        Open app
      </button>
      {fallbackMessage ? <p className="fallback-message">{fallbackMessage}</p> : null}
    </div>
  );
}
