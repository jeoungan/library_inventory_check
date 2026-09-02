import type { NextConfig } from 'next';

const isGitHubPages = process.env.GITHUB_PAGES === 'true';
const repositoryBasePath = '/library_inventory_check';

const nextConfig: NextConfig = {
  ...(isGitHubPages ? {
    output: 'export' as const,
    basePath: repositoryBasePath,
    assetPrefix: repositoryBasePath,
    trailingSlash: true,
    images: { unoptimized: true },
  } : {}),
};

export default nextConfig;
