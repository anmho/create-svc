import { DownloadLinkButton } from "./download-link-button";
import { hasAnyStoreUrl, isConfiguredStoreUrl, type DownloadConfig } from "./download-links";

const downloadConfig: DownloadConfig = {
  appDeepLink: process.env.NEXT_PUBLIC_APP_DEEP_LINK || "{{APP_DEEP_LINK}}",
  iosStoreUrl: process.env.NEXT_PUBLIC_IOS_STORE_URL || "{{IOS_STORE_URL}}",
  androidStoreUrl: process.env.NEXT_PUBLIC_ANDROID_STORE_URL || "{{ANDROID_STORE_URL}}",
};

export default function Home() {
  const hasStoreLinks = hasAnyStoreUrl(downloadConfig);

  return (
    <main className="page">
      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">{{EXAMPLE_LABEL}}</p>
          <h1 id="hero-title">{{SERVICE_NAME}}</h1>
          <p className="summary">Open the mobile app to continue, or download it when store links are available.</p>
          <DownloadLinkButton config={downloadConfig} />
        </div>

        <div className="download-panel" aria-label="Download links">
          <p className="panel-label">Download</p>
          <StoreLink label="iOS" url={downloadConfig.iosStoreUrl} />
          <StoreLink label="Android" url={downloadConfig.androidStoreUrl} />
          {!hasStoreLinks ? <p className="placeholder">Store URLs are placeholders until release.</p> : null}
        </div>
      </section>
    </main>
  );
}

function StoreLink({ label, url }: { label: string; url: string }) {
  if (!isConfiguredStoreUrl(url)) {
    return (
      <span className="store-link disabled" aria-disabled="true">
        {label} coming soon
      </span>
    );
  }

  return (
    <a className="store-link" href={url}>
      {label}
    </a>
  );
}
