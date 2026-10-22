import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // A private, always-fresh dashboard: every page renders per request, so no
  // Cache Components / partial prefetching.
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
