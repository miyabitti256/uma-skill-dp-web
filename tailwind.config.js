/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        uma: {
          green: "#76c30f",
          greenLight: "#a5dc4a",
          greenDark: "#3c8604",
          brown: "#5b4333",
          brownMuted: "#7f6958",
          panel: "#f4f3f1",
          page: "#f6f5f8",
          border: "#c8c5cf",
          gold: "#f4b731",
          pink: "#eb4893",
          orange: "#d96200",
        }
      }
    },
  },
  plugins: [],
}
