import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import FrameCycle from "./components/FrameCycle.vue";

// Extend VitePress's default theme and register our browser-only animation
// component globally so markdown pages can use <FrameCycle /> (wrapped in
// <ClientOnly> at the call site, since it touches the DOM and GSAP).
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("FrameCycle", FrameCycle);
  },
} satisfies Theme;
