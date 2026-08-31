import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Rows re-render on every cursor move; the compiler's memoization is what
  // keeps that from re-parsing every block's state and every markdown file.
  reactCompiler: true,
};

export default nextConfig;
