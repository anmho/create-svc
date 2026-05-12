import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@svc/api-client", "@svc/tokens"],
};

export default nextConfig;
