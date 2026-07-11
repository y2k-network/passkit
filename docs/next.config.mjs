import path from 'node:path';

import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // docs content is co-located with the library source at ../src (see
  // source.config.ts), and docs/ has its own lockfile alongside the root
  // package's bun.lock — pin the workspace root to the repo root so
  // Turbopack both resolves ../src and stops guessing.
  turbopack: {
    root: path.join(import.meta.dirname, '..'),
  },
};

export default withMDX(config);
