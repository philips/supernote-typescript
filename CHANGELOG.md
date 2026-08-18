# Changelog

## Unreleased

### Added

- `toPdf({ vectorInk: true })` draws Supernote ink as real PDF vector paths
  instead of rasterizing it, sharing the same stroke-decode logic as
  `toSvg({ vectorInk: true })`. See
  https://github.com/philips/supernote-typescript/issues/95.
- The fixture comparison site now includes a third pane showing the
  library's vector-ink PDF export alongside the device-exported SVG ink and
  the library's vector-ink SVG.

## [2022-08-11] - 0.1.0

### Changed

- First feature release.
