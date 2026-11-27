/** @type {import('tailwindcss').Config} */
export default {
  content: ["./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx,css}"],
  theme: {
    extend: {
      colors: {
        ink: {
          900: "#08070d",
          800: "#100d18",
          700: "#211a2a",
        },
        brand: {
          DEFAULT: "#9b5de5",
          dim: "#7540b8",
          glow: "#d6b7ff",
          pink: "#ed70d7",
        },
      },
      fontFamily: {
        sans: ["-apple-system", "BlinkMacSystemFont", "Segoe UI", "Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(168,104,245,.36), 0 0 28px -5px rgba(168,104,245,.42)",
      },
    },
  },
  plugins: [],
};
