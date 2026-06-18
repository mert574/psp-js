<script setup lang="ts">
// The emulator app lives one level above the docs base: "/psp-js/" in
// production (docs base "/psp-js/docs/") and "/" in dev (docs base "/docs/").
// Derive it from BASE_URL so the link is right in both, no hardcoded origin.
const href = import.meta.env.BASE_URL.replace(/docs\/?$/, "");
</script>

<template>
  <a class="emulator-link" :href="href">Open emulator</a>
</template>

<style scoped>
.emulator-link {
  display: inline-flex;
  align-items: center;
  margin-left: 12px;
  padding: 0 14px;
  height: 32px;
  border-radius: 8px;
  border: 1px solid var(--vp-c-brand-1);
  color: var(--vp-c-brand-1);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  transition: background-color 0.2s, color 0.2s;
}
.emulator-link:hover {
  background-color: var(--vp-c-brand-1);
  color: var(--vp-c-white);
}
</style>
