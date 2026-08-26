import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Domain packages are consumed as TypeScript source (Blueprint §2: the web
  // app is thin — pages + actions only; domain code stays in packages).
  transpilePackages: ['@taxfs/shared'],
};

export default nextConfig;
