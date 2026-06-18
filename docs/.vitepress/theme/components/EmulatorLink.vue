<script setup lang="ts">
// The emulator app lives one level above the docs base: "/psp-js/" in
// production (docs base "/psp-js/docs/") and "/" in dev (docs base "/docs/").
// Derive it from BASE_URL so the link is right in both, no hardcoded origin.
const href = import.meta.env.BASE_URL.replace(/docs\/?$/, "");
</script>

<template>
  <!--
    target="_blank" is load-bearing here, not just a UX choice. VitePress's
    router intercepts same-origin extensionless links (like "/psp-js/") and
    tries to route them inside the docs SPA, where the app route doesn't exist,
    so a plain link just silently does nothing on click. The router skips
    _blank links, so this does a real browser navigation. rel guards the opener.
  -->
  <a class="emulator-link" :href="href" target="_blank" rel="noopener">Open emulator</a>
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
