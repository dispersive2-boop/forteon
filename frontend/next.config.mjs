/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Caddy обращается к 127.0.0.1:8080 с Host: forteon.pro — разрешаем dev-источники
  allowedDevOrigins: ["forteon.pro", "www.forteon.pro", "127.0.0.1", "localhost"],
  // Разделение /api/* и / делается reverse proxy (Caddy):
  //   forteon.pro      -> 127.0.0.1:8080 (этот frontend)
  //   forteon.pro/api  -> 127.0.0.1:8081 (FastAPI)
  // Поэтому rewrites не нужны — фронтенд обращается к /api/v1 на том же origin.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
