import { readLocalFonts } from "./local-fonts.js";

/** Fetch the complete licensed replacement set; reject missing/HTML responses. */
export async function loadBundledFonts(baseUrl: string, fetcher: typeof fetch = fetch): Promise<Map<string, Uint8Array>> {
  const files = await Promise.all(Array.from({ length: 16 }, async (_, slot) => {
    const name = `ltn${slot}.pgf`;
    const response = await fetcher(`${baseUrl}flash0/font/${name}`);
    if (!response.ok) throw new Error(`Could not load ${name}: HTTP ${response.status}`);
    const bytes = await response.arrayBuffer();
    return { name, arrayBuffer: async () => bytes };
  }));
  return readLocalFonts(files);
}
