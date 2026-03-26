/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0E131F",
        mist: "#F4F8FB",
        mint: "#A6E3D0",
        coral: "#FF7A59",
        steel: "#2B3A55",
      },
      fontFamily: {
        display: ["Space Grotesk", "sans-serif"],
        body: ["Manrope", "sans-serif"],
      },
      boxShadow: {
        soft: "0 20px 50px -25px rgba(14, 19, 31, 0.45)",
      },
      keyframes: {
        floatIn: {
          "0%": { opacity: "0", transform: "translateY(18px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        floatIn: "floatIn 450ms ease-out forwards",
      },
    },
  },
  plugins: [],
};
