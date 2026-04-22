/** @type {import('next').NextConfig} */
const nextConfig = {
  // Standard Next.js config — fully Netlify-compatible
  // No Vercel-specific services, edge runtime, or platform APIs

  // xlsx needs to be treated as an external on the server side
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = [...(config.externals || []), 'xlsx']
    }
    return config
  },

  // Disable x-powered-by header
  poweredByHeader: false,

  // All pages are standard SSR/SSG — no edge-only routes
  // Netlify handles Next.js SSR via @netlify/plugin-nextjs automatically
}

module.exports = nextConfig
