import { describe, expect, it } from "vitest";
import { loadBundledFonts } from "./bundled-fonts.js";

describe("bundled replacement font loading", () => {
  it("loads every slot under the deployment base path", async () => {
    const requested: string[] = [];
    const bytes = new Uint8Array(16);
    bytes.set([0x50, 0x47, 0x46, 0x30], 4);
    const fetcher = (async (url: string) => {
      requested.push(url);
      return new Response(bytes);
    }) as typeof fetch;
    const fonts = await loadBundledFonts("/psp-js/", fetcher);
    expect(fonts.size).toBe(16);
    expect(requested).toContain("/psp-js/flash0/font/ltn15.pgf");
    expect(fonts.has("flash0:/font/ltn0.pgf")).toBe(true);
  });

  it("rejects missing files and HTML fallback pages", async () => {
    const missing = (async () => new Response("missing", { status: 404 })) as typeof fetch;
    await expect(loadBundledFonts("/", missing)).rejects.toThrow("HTTP 404");
    const html = (async () => new Response("<!doctype html><title>SPA fallback</title>")) as typeof fetch;
    await expect(loadBundledFonts("/", html)).rejects.toThrow("not a PGF");
  });
});
