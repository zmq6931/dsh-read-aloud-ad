# Changelog

## 0.1.0 — 2026-11-18

Initial public release.

- A play/pause control and a speed menu in the action row of every finished reply, between copy and the feedback buttons.
- Voiced by Mandarin **Xiaoxiao** (`zh-CN-XiaoxiaoNeural`) through Microsoft Edge's read-aloud service; no API key and no model request.
- Speeds from **0.75× to 3× in 0.25× steps**, applied immediately and remembered per browser.
- Long replies are split into sentence-sized chunks, so audio starts after the first chunk while the next one is synthesized.
- Loopback-only, same-origin `/read-aloud` route with a dependency-free WebSocket client, a v2 `Sec-MS-GEC` token generator, an in-memory LRU synthesis cache, and single-flight de-duplication.
- Localized UI copy (zh/en) through the Client locale service, an original icon, and offline smoke plus host-route integration tests.
