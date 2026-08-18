# Changelog

All notable changes to the internal `@xzzpig/pi-components` shared library are
documented here.

## 0.1.1

### Fixed

- **Bundle-safe runtime artifacts.** Consumer Pi packages now bundle compiled
  JavaScript and declarations rather than relying on Node to execute TypeScript
  from `node_modules`.

### Changed

- **Internal distribution.** This package is intentionally private and is
  bundled into consumer package tarballs instead of being published separately.

## 0.1.0

### Added

- Bounded session transcript state, native Pi message rendering, terminal-safe
  tool output, and a scrollable transcript viewport for Pi extensions.
