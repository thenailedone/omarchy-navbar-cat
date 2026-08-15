# Vendored oneko sprites — provenance

These XBM bitmaps are the original `neko` (cat) artwork from **oneko**.

- **Upstream:** http://www.daidouji.com/oneko/distfiles/oneko-1.2.sakura.5.tar.gz
- **md5:** `456b318fa6e61431bf4f0a42b110014a` (matches the checksum in the
  Arch AUR `oneko` PKGBUILD)
- **Licence:** Public Domain — the AUR `oneko` package declares
  `license=('Public Domain')`.
- **Original author:** Masayuki Koba. Modified by Tatsuya Kato.
- **Files taken:** the `neko`, `tora`, and `dog` sprite sets only —
  `bitmaps/{neko,tora,dog}/*.xbm` and `bitmasks/{neko,dog}/*.xbm`.

`tora` ships 32 bitmaps and no masks of its own: oneko reuses the neko masks
for it (`oneko.c:157` passes `mati2_mask_bits` for both the neko and tora
columns), and `tools/build-sprites.py` does the same.

## What was deliberately NOT taken

The upstream tarball ships several other character sets whose rights are
reserved. `oneko.man` states:

> BSD Daemon Copyright 1988 by Marshall Kirk McKusick. All Rights Reserved.
>
> Sakura Kinomoto and Tomoyo Daidouji are characters in a comic strip
> "CARDCAPTOR SAKURA" (CLAMP, Kodansha), with the sanction indicated in
> CLAMP SCHOOL WEB CAMPUS.

Accordingly the `bsd`, `sakura`, and `tomoyo` sets are **excluded** from this
repository.

`tora` and `dog` are shipped. Neither is named in the man page's reserved-rights
notice, so both fall under the package's Public Domain declaration — note that
this is inferred from the absence of a claim rather than from an explicit
statement about those two sets. `bsd`, `sakura`, and `tomoyo` are the ones with
actual claims on them, and they stay out.

## Regenerating the spritesheets

`tools/build-sprites.py` reads these XBM pairs and writes the PNG sheets in
`assets/`. The generated sheets are committed, so building is only needed
when changing the sprite pipeline.
