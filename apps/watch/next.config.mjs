/** @type {import('next').NextConfig} */
// Posters are TMDB's own CDN (image.tmdb.org), rendered as plain <img> — no Vercel
// image optimizer (Hobby plan CPU budget; TMDB already serves sized variants).
const nextConfig = { reactStrictMode: true };
export default nextConfig;
