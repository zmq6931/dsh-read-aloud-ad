# Changelog

## 0.1.2 — 2026-11-19

Packaging fix; no functional change.

- `package.json` is written as UTF-8 **without** a BOM again. The 0.1.1 tarball carried a byte-order mark, which made strict readers reject the manifest (`Unexpected token '﻿'`), so DSH denied the plugin at profile startup.
- 0.1.1 is deprecated on npm; use 0.1.2.

## 0.1.1 — 2026-11-18

Docs-only release.

- The README no longer carries a machine-specific local path or the internal plugin row id.
- The release-tarball install line is now version-agnostic.

## 0.1.0 — 2026-11-18

Initial public release.

- A play/pause control and a speed menu in the action row of every finished reply, between copy and the feedback buttons.
- Voiced by Mandarin **Xiaoxiao** (`zh-CN-XiaoxiaoNeural`) through Microsoft Edge's read-aloud service; no API key and no model request.
- Speeds from **0.75× to 3× in 0.25× steps**, applied immediately and remembered per browser.
- Long replies are split into sentence-sized chunks, so audio starts after the first chunk while the next one is synthesized.
- Loopback-only, same-origin `/read-aloud` route with a dependency-free WebSocket client, a v2 `Sec-MS-GEC` token generator, an in-memory LRU synthesis cache, and single-flight de-duplication.
- Localized UI copy (zh/en) through the Client locale service, an original icon, and offline smoke plus host-route integration tests.
- Published to npm as [`dsh-read-aloud-ad`](https://www.npmjs.com/package/dsh-read-aloud-ad) (`dsh plugin add dsh-read-aloud-ad`) and as a GitHub release tarball.
