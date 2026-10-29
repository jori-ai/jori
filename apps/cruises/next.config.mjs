/** @type {import('next').NextConfig} */
const nextConfig = {
  // Hero images are the cruise lines' own CDN URLs (Akamai/imgix/Scene7),
  // rendered as plain <img>. next/image would proxy every one of them through
  // Vercel's optimizer — thousands of distinct URLs on a two-person site, all
  // billable, for images the lines already serve resized.
  reactStrictMode: true,
};

export default nextConfig;
