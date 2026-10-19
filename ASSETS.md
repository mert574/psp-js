# Distributed assets

## Current policy

No game images or firmware fonts are bundled. The 16 default PGF slots use
replacement fonts generated from the bundled OFL fonts. Existing gameplay videos
and screenshots remain as emulator demonstrations.

## Retained assets

- `docs/public/architecture.gif`: the project's architecture illustration.
- `docs/public/videos/` and `docs/public/screenshots/`: the existing emulator
  demonstrations and documentation captures. Underlying game artwork, animation,
  music, and other third-party content retain their respective rights and are
  excluded from the project's MIT code/illustration licensing. Retention is not
  a claim that the game publishers granted an MIT license or approved these clips.
- `src/frontend/fonts/`: Saira and Inconsolata UI font files accompanied by their
  existing SIL Open Font License notices. These browser UI fonts are separate
  from PSP PGF fonts.
- `public/flash0/font/ltn*.pgf`: modified Saira/Inconsolata fonts named PSP.js Sans
  and PSP.js Mono, under OFL-1.1. Copyright and license texts are beside the PGFs.
  `provenance.json` records source hashes, conversion settings, output hashes, and
  the browser version used to rasterize the glyphs.

`assets.json` inventories distributed binary paths, hashes, and source/rights
notes. `npm run check:assets` rejects unlisted binary assets in the public and
bundled-font directories. This verifies inventory and identity, not legal permission.

## Generating replacement fonts

Run `npm run fonts:generate` with Chrome installed. The converter uses only the
checked-in Saira/Inconsolata outlines; it checks the TrueType character map to
avoid drawing glyphs from browser fallback fonts. It also refreshes `assets.json`.
Raster output can vary across browser versions; review regenerated hashes.

The replacement set provides regular/bold/italic Sans and Mono faces at 13px and
18px, with supported Latin characters and punctuation. It does not duplicate the
original fonts' shapes/metrics or provide CJK coverage or shadow glyphs.

The old PGF files matched the pinned PPSSPP reference. They were replaced without
copying their glyph pixels. Their historical redistribution status is unchanged.

The old files remain in older commits and possibly earlier deployments. A current
tree cleanup does not clear historical rights or remove published artifacts.
Resolve historical redistribution with permission evidence or the program's
reviewers. Preserve original commit history; do not silently rewrite it or
re-upload a fresh repository to hide the assets.

## Adding a demo or screenshot

Use self-authored homebrew or content with explicit redistribution permission.
Record source URL, creator, exact license, attribution, and modifications, include
the required notice, then add its hash to `assets.json`. A locally owned game
copy is not itself proof of permission to redistribute its imagery or recordings.
Do not point public download/autoload links at unreviewed game files.
