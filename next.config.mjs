/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // อย่าให้ Next ไปสแกนโค้ดต้นแบบเดิม (prototype/) หรือ docs
  eslint: {
    dirs: ["app", "lib"],
  },
};

export default nextConfig;
