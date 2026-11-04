/** @type {import('next').NextConfig} */
const nextConfig = {
  // The itinerary fragments carry Supabase-hosted <img> URLs directly (already
  // sized/re-hosted by trip-place-photo / brand-logo), so we render raw
  // HTML rather than next/image — no remotePatterns needed.
  reactStrictMode: true,
};

export default nextConfig;
