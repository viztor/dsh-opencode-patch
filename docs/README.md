# Documentation

One document per subject. Everything here is engineering material and written in English, except the meter's guide — that one is user-facing, so it exists in both languages, the same rule the READMEs follow.

| Document | Subject | Language |
| :-- | :-- | :-- |
| [`deep-dive.md`](./deep-dive.md) | the wire protocol: the header matrix, session lineage, workspace attribution, API tiers, and the catalog shims | English |
| [`redirect-planes.md`](./redirect-planes.md) | the routing **specification**: planes, shapes, routes, the invariants a correct implementation satisfies, and the full path from the picker to the meter | English |
| [`protocol-routing-and-merge.md`](./protocol-routing-and-merge.md) | the routing **implementation**: why routing exists, how the route is chosen, the catalog merge, and where the code lives | English |
| [`engineering-notes.md`](./engineering-notes.md) | vendor findings, and the rules that came out of real failures | English |
| [`quota-meter.md`](./quota-meter.md) | the composer meter, state by state: what it shows, what each row answers, and where the numbers come from | English |
| [`quota-meter.zh-CN.md`](./quota-meter.zh-CN.md) | 同一份说明的中文版 | 中文 |

**Specification versus implementation is the one split worth knowing.** `redirect-planes.md` says what the code **must** do; `protocol-routing-and-merge.md` says what it **does**; the guards in the former are what holds the two together. When they disagree, one of them is wrong — that is the point of keeping both.

Screenshots of the plugin UI land in this directory as `composer-dock.png` and `meter-panel.png`. [quota-meter.md §7](./quota-meter.md#7-screenshots) covers how to regenerate them.
