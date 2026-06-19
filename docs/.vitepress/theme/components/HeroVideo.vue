<script setup lang="ts">
// Rendered into VitePress's `home-hero-image` slot, so it fills the empty right
// side of the home hero. withBase keeps the path right under the docs base.
import { withBase } from "vitepress";
</script>

<template>
  <div class="hero-video">
    <video
      :src="withBase('/videos/ridge-racer.mp4')"
      autoplay
      muted
      loop
      playsinline
      preload="metadata"
    ></video>
    <span class="hero-video__cap">Ridge Racer, in-game replay</span>
  </div>
</template>

<style scoped>
.hero-video {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.hero-video video {
  width: 100%;
  max-width: 460px;
  border-radius: 12px;
  border: 1px solid var(--vp-c-divider);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.25);
}
.hero-video__cap {
  font-size: 12px;
  color: var(--vp-c-text-3);
}
</style>
