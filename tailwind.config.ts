import type { Config } from "tailwindcss";

// สีแบรนด์ Finovas: น้ำเงินเข้ม (primary) + น้ำเงินสว่าง (accent) + เทาอ่อน (bg)
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#0b2a4a", // น้ำเงินเข้ม
          light: "#1e6fd6", // น้ำเงินสว่าง (accent)
          bg: "#f3f5f8", // เทาอ่อน
        },
        status: {
          positive: "#16a34a",
          medium: "#eab308",
          critical: "#dc2626",
        },
      },
      fontFamily: {
        thai: ["var(--font-thai)", "Sarabun", "Noto Sans Thai", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
