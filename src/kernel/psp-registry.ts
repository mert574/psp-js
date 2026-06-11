/**
 * PSP system registry tree — faithful port of PPSSPP sceReg.cpp registry data.
 *
 * The PSP registry is a hierarchical key-value store used by games to query
 * system settings (fonts, language, button assignment, display resolution, etc.).
 */

export interface RegKeyValue {
  name: string;
  type: "dir" | "int" | "str" | "bin";
  intValue?: number;
  strValue?: string;
  children?: RegKeyValue[];
}

// Registry type codes as seen by PSP userland
export const REG_TYPE_DIR = 1;
export const REG_TYPE_INT = 2;
export const REG_TYPE_STR = 3;
export const REG_TYPE_BIN = 4;

export const SCE_REG_ERROR_CATEGORY_NOT_FOUND = 0x80580004;

// ── Font property entries (INFO0..INFO17) from PPSSPP sceReg.cpp ──────────

function fontEntry(
  h_size: number, v_size: number,
  h_resolution: number, v_resolution: number,
  extra_attributes: number, weight: number,
  family_code: number, style: number, sub_style: number,
  language_code: number, region_code: number, country_code: number,
  font_name: string, file_name: string,
  expire_date: number, shadow_option: number,
): RegKeyValue {
  return {
    name: "", // filled by caller
    type: "dir",
    intValue: 16, // 16 keys in each INFOx
    children: [
      { name: "h_size",           type: "int", intValue: h_size },
      { name: "v_size",           type: "int", intValue: v_size },
      { name: "h_resolution",     type: "int", intValue: h_resolution },
      { name: "v_resolution",     type: "int", intValue: v_resolution },
      { name: "extra_attributes", type: "int", intValue: extra_attributes },
      { name: "weight",           type: "int", intValue: weight },
      { name: "family_code",      type: "int", intValue: family_code },
      { name: "style",            type: "int", intValue: style },
      { name: "sub_style",        type: "int", intValue: sub_style },
      { name: "language_code",    type: "int", intValue: language_code },
      { name: "region_code",      type: "int", intValue: region_code },
      { name: "country_code",     type: "int", intValue: country_code },
      { name: "font_name",        type: "str", strValue: font_name },
      { name: "file_name",        type: "str", strValue: file_name },
      { name: "expire_date",      type: "int", intValue: expire_date },
      { name: "shadow_option",    type: "int", intValue: shadow_option },
    ],
  };
}

// Standard h/v/res defaults for INFO0-INFO8 and INFO17
const S = 0x288, R = 0x2000;
// Small font h/v for INFO9-INFO16
const SS = 0x1c0;

function makeInfo(index: number, ...args: Parameters<typeof fontEntry>): RegKeyValue {
  const e = fontEntry(...args);
  e.name = `INFO${index}`;
  return e;
}

const fontInfoEntries: RegKeyValue[] = [
  // INFO0: Japanese
  makeInfo(0,  S, S, R, R, 0, 0, 1, 0x67, 0, 1, 0, 1, "FTT-NewRodin Pro DB",          "jpn0.pgf",  0, 0),
  // INFO1-INFO8: Latin (0x288 size)
  makeInfo(1,  S, S, R, R, 0, 0, 1, 1,    0, 2, 0, 1, "FTT-NewRodin Pro Latin",        "ltn0.pgf",  0, 0),
  makeInfo(2,  S, S, R, R, 0, 0, 2, 1,    0, 2, 0, 1, "FTT-Matisse Pro Latin",         "ltn1.pgf",  0, 0),
  makeInfo(3,  S, S, R, R, 0, 0, 1, 2,    0, 2, 0, 1, "FTT-NewRodin Pro Latin",        "ltn2.pgf",  0, 0),
  makeInfo(4,  S, S, R, R, 0, 0, 2, 2,    0, 2, 0, 1, "FTT-Matisse Pro Latin",         "ltn3.pgf",  0, 0),
  makeInfo(5,  S, S, R, R, 0, 0, 1, 5,    0, 2, 0, 1, "FTT-NewRodin Pro Latin",        "ltn4.pgf",  0, 0),
  makeInfo(6,  S, S, R, R, 0, 0, 2, 5,    0, 2, 0, 1, "FTT-Matisse Pro Latin",         "ltn5.pgf",  0, 0),
  makeInfo(7,  S, S, R, R, 0, 0, 1, 6,    0, 2, 0, 1, "FTT-NewRodin Pro Latin",        "ltn6.pgf",  0, 0),
  makeInfo(8,  S, S, R, R, 0, 0, 2, 6,    0, 2, 0, 1, "FTT-Matisse Pro Latin",         "ltn7.pgf",  0, 0),
  // INFO9-INFO16: Latin small (0x1c0 size)
  makeInfo(9,  SS, SS, R, R, 0, 0, 1, 1,  0, 2, 0, 1, "FTT-NewRodin Pro Latin",        "ltn8.pgf",  0, 0),
  makeInfo(10, SS, SS, R, R, 0, 0, 2, 1,  0, 2, 0, 1, "FTT-Matisse Pro Latin",         "ltn9.pgf",  0, 0),
  makeInfo(11, SS, SS, R, R, 0, 0, 1, 2,  0, 2, 0, 1, "FTT-NewRodin Pro Latin",        "ltn10.pgf", 0, 0),
  makeInfo(12, SS, SS, R, R, 0, 0, 2, 2,  0, 2, 0, 1, "FTT-Matisse Pro Latin",         "ltn11.pgf", 0, 0),
  makeInfo(13, SS, SS, R, R, 0, 0, 1, 5,  0, 2, 0, 1, "FTT-NewRodin Pro Latin",        "ltn12.pgf", 0, 0),
  makeInfo(14, SS, SS, R, R, 0, 0, 2, 5,  0, 2, 0, 1, "FTT-Matisse Pro Latin",         "ltn13.pgf", 0, 0),
  makeInfo(15, SS, SS, R, R, 0, 0, 1, 6,  0, 2, 0, 1, "FTT-NewRodin Pro Latin",        "ltn14.pgf", 0, 0),
  makeInfo(16, SS, SS, R, R, 0, 0, 2, 6,  0, 2, 0, 1, "FTT-Matisse Pro Latin",         "ltn15.pgf", 0, 0),
  // INFO17: Korean
  makeInfo(17, S, S, R, R, 0, 0, 1, 1,    0, 3, 0, 3, "AsiaNHH(512Johab)",             "kr0.pgf",   0, 0),
];

// ── Full registry tree ───────────────────────────────────────────────────

export const REGISTRY_TREE: RegKeyValue = {
  name: "",
  type: "dir",
  intValue: 2, // 2 children: DATA, SYSPROFILE
  children: [
    {
      name: "DATA",
      type: "dir",
      intValue: 2, // FONT, COUNT
      children: [
        {
          name: "FONT",
          type: "dir",
          intValue: 3, // path_name, num_fonts, PROPERTY
          children: [
            { name: "path_name", type: "str", strValue: "flash0:/font" },
            { name: "num_fonts", type: "int", intValue: 0x12 },
            {
              name: "PROPERTY",
              type: "dir",
              intValue: 18, // INFO0..INFO17
              children: fontInfoEntries,
            },
          ],
        },
        {
          name: "COUNT",
          type: "dir",
          intValue: 6,
          children: [
            { name: "boot_count",         type: "int", intValue: 0 },
            { name: "game_exec_count",    type: "int", intValue: 0x46 },
            { name: "slide_count",        type: "int", intValue: 0 },
            { name: "usb_connect_count",  type: "int", intValue: 0xec },
            { name: "wifi_connect_count", type: "int", intValue: 0 },
            { name: "psn_access_count",   type: "int", intValue: 0 },
          ],
        },
      ],
    },
    {
      name: "SYSPROFILE",
      type: "dir",
      intValue: 2, // sound_reduction, RESOLUTION
      children: [
        { name: "sound_reduction", type: "int", intValue: 0 },
        {
          name: "RESOLUTION",
          type: "dir",
          intValue: 2,
          children: [
            { name: "horizontal", type: "int", intValue: 0x2012 },
            { name: "vertical",   type: "int", intValue: 0x2012 },
          ],
        },
      ],
    },
  ],
};

/**
 * Navigate the registry tree by path (e.g. "/DATA/FONT/PROPERTY/INFO0").
 * Strips leading `/`, splits by `/`, walks directory children.
 *
 * Returns the keys (children) and count (intValue) of the final directory,
 * or null if not found.
 */
export function lookupCategory(path: string): { keys: RegKeyValue[]; count: number } | null {
  // Strip leading slash
  let p = path;
  if (p.startsWith("/")) p = p.slice(1);

  const parts = p.split("/").filter(s => s.length > 0);
  let node = REGISTRY_TREE;

  for (const part of parts) {
    if (node.type !== "dir" || !node.children) return null;
    const partLower = part.toLowerCase();
    const child = node.children.find(c => c.name.toLowerCase() === partLower);
    if (!child) return null;
    node = child;
  }

  if (node.type !== "dir" || !node.children) return null;
  return { keys: node.children, count: node.intValue ?? node.children.length };
}
