import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Settings posts a whole v1 backup file to a Server Action. The default
    // 1MB cap would reject a large export; the importer itself refuses
    // anything over 10MB, and the extra headroom covers JSON escaping.
    serverActions: { bodySizeLimit: "12mb" },
  },
};

export default nextConfig;
