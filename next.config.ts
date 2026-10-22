import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/search-console", destination: "/websites", permanent: false },
      { source: "/search-console/:id", destination: "/overview", permanent: false },
    ];
  },
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
