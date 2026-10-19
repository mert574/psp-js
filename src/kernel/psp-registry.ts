/** PSP registry values describing this emulator's bundled fonts and settings. */
export interface RegKeyValue {
  name: string; type: "dir" | "int" | "str" | "bin";
  intValue?: number; strValue?: string; children?: RegKeyValue[];
}
export const REG_TYPE_DIR = 1, REG_TYPE_INT = 2, REG_TYPE_STR = 3, REG_TYPE_BIN = 4;
export const SCE_REG_ERROR_CATEGORY_NOT_FOUND = 0x80580004;
const integer = (name: string, value: number): RegKeyValue => ({ name, type: "int", intValue: value });
const text = (name: string, value: string): RegKeyValue => ({ name, type: "str", strValue: value });
const directory = (name: string, children: RegKeyValue[]): RegKeyValue => ({ name, type: "dir", intValue: children.length, children });
const fonts = Array.from({ length: 16 }, (_, slot) => {
  const small = slot >= 8;
  const style = small ? [1,1,1,1,5,5,2,2][slot-8]! : [1,1,2,2,5,5,6,6][slot]!;
  return directory(`INFO${slot}`, [
    integer("h_size", (small ? 13 : 18) * 36), integer("v_size", (small ? 13 : 18) * 36),
    integer("h_resolution", 0x2000), integer("v_resolution", 0x2000),
    integer("extra_attributes", 0), integer("weight", 0), integer("family_code", slot % 2 + 1),
    integer("style", style), integer("sub_style", 0), integer("language_code", 2),
    integer("region_code", 0), integer("country_code", 1),
    text("font_name", slot % 2 ? "PSP.js Mono" : "PSP.js Sans"), text("file_name", `ltn${slot}.pgf`),
    integer("expire_date", 0), integer("shadow_option", 0),
  ]);
});
export const REGISTRY_TREE = directory("", [
  directory("DATA", [
    directory("FONT", [text("path_name", "flash0:/font"), integer("num_fonts", fonts.length), directory("PROPERTY", fonts)]),
    directory("COUNT", ["boot_count", "game_exec_count", "slide_count", "usb_connect_count", "wifi_connect_count", "psn_access_count"].map(name => integer(name, 0))),
  ]),
  directory("SYSPROFILE", [integer("sound_reduction", 0), directory("RESOLUTION", [integer("horizontal", 0x2012), integer("vertical", 0x2012)])]),
]);
export function lookupCategory(path: string): { keys: RegKeyValue[]; count: number } | null {
  const parts = path.toLowerCase().split("/").filter(Boolean);
  let current: RegKeyValue | undefined = REGISTRY_TREE;
  for (const part of parts) current = current?.children?.find(child => child.name.toLowerCase() === part);
  return current?.type === "dir" && current.children ? { keys: current.children, count: current.children.length } : null;
}
