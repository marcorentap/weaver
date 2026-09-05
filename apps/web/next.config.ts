import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Rows re-render on every cursor move; the compiler's memoization is what
  // keeps that from re-parsing every block's state and every markdown file.
  reactCompiler: true,
  // The agent SDK is ESM, spawns processes and resolves its own tools at run
  // time: bundling it into the server chunk breaks all three.
  serverExternalPackages: ["@earendil-works/pi-coding-agent"],
  experimental: {
    serverActions: {
      // `saveGraph` autosaves the whole live graph in one call, and a tool
      // block's `output` can be a whole file's content or a large diff: the
      // 1 MB default is well inside what a single `read` or `edit` block
      // produces.
      bodySizeLimit: "128mb",
    },
  },
};

export default nextConfig;
