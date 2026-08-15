# Vendored oneko sprites — provenance

These XBM bitmaps are the original `neko` (cat) artwork from **oneko**.

- **Upstream:** http://www.daidouji.com/oneko/distfiles/oneko-1.2.sakura.5.tar.gz
- **md5:** `456b318fa6e61431bf4f0a42b110014a` (matches the checksum in the
  Arch AUR `oneko` PKGBUILD)
- **Licence:** Public Domain — the AUR `oneko` package declares
  `license=('Public Domain')`.
- **Original author:** Masayuki Koba. Modified by Tatsuya Kato.
- **Files taken:** `bitmaps/neko/*.xbm` and `bitmasks/neko/*.xbm` only.

## What was deliberately NOT taken

The upstream tarball ships several other character sets whose rights are
reserved. `oneko.man` states:

> BSD Daemon Copyright 1988 by Marshall Kirk McKusick. All Rights Reserved.
>
> Sakura Kinomoto and Tomoyo Daidouji are characters in a comic strip
> "CARDCAPTOR SAKURA" (CLAMP, Kodansha), with the sanction indicated in
> CLAMP SCHOOL WEB CAMPUS.

Accordingly, the `bsd`, `sakura`, `tomoyo`, `dog`, and `tora` sprite sets are
**excluded** from this repository. Only the public-domain `neko` cat is
vendored and shipped.

## Regenerating the spritesheets

`tools/build-sprites.py` reads these XBM pairs and writes the PNG sheets in
`assets/`. The generated sheets are committed, so building is only needed
when changing the sprite pipeline.
