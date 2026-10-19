/** Load caller-provided PGF files for this browser session, without uploading them. */
export async function readLocalFonts(
  files: Iterable<Pick<File, "name" | "arrayBuffer">>,
): Promise<Map<string, Uint8Array>> {
  const fonts = new Map<string, Uint8Array>();
  for (const file of files) {
    const name = file.name.toLowerCase();
    if (!/^ltn(?:[0-9]|1[0-5])\.pgf$/.test(name)) {
      throw new Error("Choose PGF files named ltn0.pgf through ltn15.pgf.");
    }
    const buffer = await file.arrayBuffer();
    if (buffer.byteLength < 8) throw new Error(`${file.name} is not a PGF font.`);
    const view = new DataView(buffer);
    const offset = view.getUint32(4, true) === 0x30464750 ? 0 : view.getUint32(0, true);
    if (offset > buffer.byteLength - 8 || view.getUint32(offset + 4, true) !== 0x30464750) {
      throw new Error(`${file.name} is not a PGF font.`);
    }
    fonts.set(`flash0:/font/${name}`, new Uint8Array(buffer));
  }
  return fonts;
}
