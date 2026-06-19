import DefaultTheme from "vitepress/theme";
import type { Theme } from "vitepress";
import { h } from "vue";
import FrameCycle from "./components/FrameCycle.vue";
import EmulatorLink from "./components/EmulatorLink.vue";
import HeroVideo from "./components/HeroVideo.vue";

// Extend VitePress's default theme:
//  - register the browser-only <FrameCycle /> animation (used in markdown,
//    wrapped in <ClientOnly> at the call site since it touches the DOM/GSAP);
//  - add an "Open emulator" button to the nav bar that links back to the app;
//  - fill the home hero's right-side image slot with a gameplay clip.
export default {
  extends: DefaultTheme,
  Layout() {
    return h(DefaultTheme.Layout, null, {
      "nav-bar-content-after": () => h(EmulatorLink),
      "home-hero-image": () => h(HeroVideo),
    });
  },
  enhanceApp({ app }) {
    app.component("FrameCycle", FrameCycle);
  },
} satisfies Theme;
