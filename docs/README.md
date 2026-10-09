Screenshots of the plugin UI, referenced from the README.

Regenerate with:

    scripts/capture-ui.sh "<dsh url with ?token=...>"

The token is generated at runtime by `dsh web` and is not stored on disk, so it has to be passed in. Files land here as `composer-dock.png` and `meter-panel.png`.

## 说明文档

- [`quota-meter.md`](./quota-meter.md) — the meter's per-state behaviour: the trigger's three states, both panels, what every row answers, where the numbers come from, and the three different kinds of "no number".
- [`quota-meter.zh-CN.md`](./quota-meter.zh-CN.md) — 同一份说明的中文版。
- [`protocol-routing-and-merge.md`](./protocol-routing-and-merge.md) — protocol routing, the catalog merge and the UI, at the technical level (English).
- [`protocol-routing-and-merge.md`](./protocol-routing-and-merge.md) — 同一份内容的中文版：协议路由、目录合并与界面的技术说明。
- [`deep-dive.md`](./deep-dive.md) — the protocol internals moved out of the README: header-injection matrix, session lineage, workspace attribution, API tiers, catalog shims (English).
- [`deep-dive.md`](./deep-dive.md) — 同一份内容的中文版。
