# Changelog

All notable changes to `dsh-opencode` are documented in this file.

This project is an evolution of [**`nobu121/dsh-opencode-session`**](https://github.com/nobu121/dsh-opencode-session) by [@nobu121](https://github.com/nobu121).

---

## [1.1.1](https://github.com/viztor/dsh-opencode-patch/compare/v1.1.0...v1.1.1) (2026-10-09)


### Bug Fixes

* **peer:** the host range excluded the host line we build against ([8862587](https://github.com/viztor/dsh-opencode-patch/commit/8862587ea80f4bfb0544538a0e40577f72223ba3))

## [1.1.0](https://github.com/viztor/dsh-opencode-patch/compare/v1.0.0...v1.1.0) (2026-10-09)


### Features

* **routing:** route and mount per (plane, protocol), closing the Go gap ([0c86082](https://github.com/viztor/dsh-opencode-patch/commit/0c86082a345912add8fc22926aa0ec4dabf8b30a))
* **routing:** route and mount per (plane, protocol), closing the Go gap ([5982408](https://github.com/viztor/dsh-opencode-patch/commit/5982408426b15a2b07eb6afef6dff5357a4bf3ef))


### Bug Fixes

* **test:** toSorted, so the lint gate passes ([9679462](https://github.com/viztor/dsh-opencode-patch/commit/9679462b4738c932205ad39d3eaafe87e2657177))
* the redundant guard that kept the coverage ratchet red ([eb0a7f7](https://github.com/viztor/dsh-opencode-patch/commit/eb0a7f78ee4c293ea27e407d0db0f36ffd57a9cb))

## [1.0.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.15.3...v1.0.0) (2026-10-09)


### Features

* **routing:** serve mistral-conversations, so mistral-large-4 is reachable ([95184cf](https://github.com/viztor/dsh-opencode-patch/commit/95184cf93abe8362f9dd00b5aae9fa289e0d5cf3))


### Bug Fixes

* **routing:** make the unserved SDKs a decision, not an omission ([a014b91](https://github.com/viztor/dsh-opencode-patch/commit/a014b91a20a959e5f502cd837ffca295b1daefb1))


### Miscellaneous Chores

* release 1.0.0 ([577cc8b](https://github.com/viztor/dsh-opencode-patch/commit/577cc8b654ff2ce33568bd9960c19f701db46579))

## [0.15.1](https://github.com/viztor/dsh-opencode-patch/compare/v0.15.0...v0.15.1) (2026-10-09)


### Bug Fixes

* **project:** split both separators, so a Windows cwd cannot leak a path


### Documentation

* no local path in an example, and a rule so it stays that way


## [0.15.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.14.0...v0.15.0) (2026-10-09)


### Features

* **session:** the id carries the session's real createdAt ([a6ec19e](https://github.com/viztor/dsh-opencode-patch/commit/a6ec19e02730c04f1bee80a35ad68878c3fb8bb3))
* the meter shows the 5-HOUR window, and the hover lists all three ([218562a](https://github.com/viztor/dsh-opencode-patch/commit/218562adc62930babfc41da4286ad91335b43afa))
* the ring is a Go gauge, so Zen does not draw one ([c7a0b54](https://github.com/viztor/dsh-opencode-patch/commit/c7a0b54307f8d45294d7b60824e077377bc0c1a2))


### Bug Fixes

* one weight for values, no second line under the Zen credit, one spelling of the model ([07a1d25](https://github.com/viztor/dsh-opencode-patch/commit/07a1d25ce46fa6a65a31206764b2229c6ab61897))
* **session:** derive a ULID-shaped session id, not base62 ([ed96127](https://github.com/viztor/dsh-opencode-patch/commit/ed961279f0da6ac885aed80e745782fbb1f84b40))
* **session:** restore the vendor's id shape, with a real timestamp ([2fc40c2](https://github.com/viztor/dsh-opencode-patch/commit/2fc40c2f52987cd61b78585d148a95fe32bb814d))
* the info tooltips portal out of their container, and the docs catch up ([c2a35a5](https://github.com/viztor/dsh-opencode-patch/commit/c2a35a5b0a44cd251f1c559444168713ed8d6bb5))
* the trigger hugs its content, with a thinner edge ([0857c92](https://github.com/viztor/dsh-opencode-patch/commit/0857c923acf7a34fd35700d80fda35a0e648fdbc))
* the trigger sits closer to the model selector ([40117a6](https://github.com/viztor/dsh-opencode-patch/commit/40117a6678754af4e1c1eb34dfa567d2a79c4e67))
* the trigger's radius steps one rung down, to the host's own ratio ([05bf6f1](https://github.com/viztor/dsh-opencode-patch/commit/05bf6f17f9fb590350b24384776849490afb98e7))
* the window bar spans its row, and the state dot sits with its label ([aa47d4a](https://github.com/viztor/dsh-opencode-patch/commit/aa47d4a2bd46736ce0cc2496920324475eb1b923))

## [0.14.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.13.0...v0.14.0) (2026-10-08)


### Features

* a rejected Go credential says so, instead of 'unavailable' ([b7cbc86](https://github.com/viztor/dsh-opencode-patch/commit/b7cbc864c7c0a3fa92d8965c442b12796dd60281))
* mount the host's own llm-pi-ai below an isolated auth scope ([fb12d8d](https://github.com/viztor/dsh-opencode-patch/commit/fb12d8dddd3824d989051ebcfe822cfc8f29497f))
* route each OpenCode Zen model to the API its own SDK names ([20c8afc](https://github.com/viztor/dsh-opencode-patch/commit/20c8afc5a8410885725a2bab420271dbddb78143))
* say when the Go plan is what ran out ([3f6da6c](https://github.com/viztor/dsh-opencode-patch/commit/3f6da6cc56c3c3b82c773213125969d43d3b14f0))
* seat the meter beside the model selector ([61680cc](https://github.com/viztor/dsh-opencode-patch/commit/61680ccb62b261df4bcc022728474819951264e0))
* show session spend in the Zen trigger instead of the title ([5e7b4eb](https://github.com/viztor/dsh-opencode-patch/commit/5e7b4eb0854e60fbaaedd521a3e23ddbbb116388))
* the free model's ring goes hollow, and the windows get their bars back ([3d01323](https://github.com/viztor/dsh-opencode-patch/commit/3d013239b9727ff39ecf5062ef4d6f8be5e442a1))
* the Go panel says what the percentage is a percentage OF ([1b3f906](https://github.com/viztor/dsh-opencode-patch/commit/1b3f906e9b9f833d2ea6bddcfa5b1883041a5252))
* the meter's footer, and a rate that follows the picker ([438682e](https://github.com/viztor/dsh-opencode-patch/commit/438682eff4029ee671a6a2637d4adde841246ade))
* the overflow card carries a billing note, not estimates ([1f92c46](https://github.com/viztor/dsh-opencode-patch/commit/1f92c46af8126c54d4889abb3a490c13a64d58dc))
* the plugin card shows Go usage and status, with what is left on the side ([362f8fd](https://github.com/viztor/dsh-opencode-patch/commit/362f8fd32788119ed7bea7300e29371991e17549))
* the spend row always renders, the Zen hover carries the price, and the meter has a Chinese behaviour doc ([75f6d47](https://github.com/viztor/dsh-opencode-patch/commit/75f6d47bbc82f35ef99be98366c4eff523bc1cbb))
* the Zen tooltip answers "how much is left" ([23a8bbb](https://github.com/viztor/dsh-opencode-patch/commit/23a8bbbf4ef0fc3898c58d526a16312d97848a5c))


### Bug Fixes

* a custom gateway gets catalog enrichment, not just headers ([44ce711](https://github.com/viztor/dsh-opencode-patch/commit/44ce711cffbcd1edad830c2f06de76a0c69ecdcf))
* a model or provider switch re-reads immediately, not on the next tick ([5aea039](https://github.com/viztor/dsh-opencode-patch/commit/5aea0395805b6d91dd5b5bbd595c7825e9650600))
* a refresh click completes a full spin, however fast the read is ([f602aee](https://github.com/viztor/dsh-opencode-patch/commit/f602aeea1a918026f91b95c607baf8766b3b5b0f))
* call the Host's listing with its own service as the receiver ([51ff423](https://github.com/viztor/dsh-opencode-patch/commit/51ff423e9ee3937a7e33d7777430921ed67055e7))
* declare remote.opencodeGoUsage now that the host registers it ([fed3fdc](https://github.com/viztor/dsh-opencode-patch/commit/fed3fdc8a23bb037cd88d000a6ba64c121eb6a06))
* declare remote.opencodeGoUsage, the meter's own remote ([7fa623a](https://github.com/viztor/dsh-opencode-patch/commit/7fa623a8e4a53ae65aca247a4a7a8fb69e8de169))
* declare remote.session, which is its own inject key ([5c15384](https://github.com/viztor/dsh-opencode-patch/commit/5c15384c5821a9e6db662b18ad3a6f66a06c500d))
* declare the quota method as Remote instead of hand-rolling a contribution ([37c265f](https://github.com/viztor/dsh-opencode-patch/commit/37c265fccd5757b77612a86aa9e0eaa905f25760))
* declare the remote service the model directory reaches through ([289e28b](https://github.com/viztor/dsh-opencode-patch/commit/289e28b3c2bb5bfb5dacf820555e564aa47831aa))
* drop the pnpm allowBuilds placeholder an aborted install left behind ([754683f](https://github.com/viztor/dsh-opencode-patch/commit/754683f8a1f8b2047918e01511c8c74e2daaab95))
* **e2e:** the free-tier gate now fires on every endpoint ([d0da181](https://github.com/viztor/dsh-opencode-patch/commit/d0da1817f17473baa122afe980919d33f5aad473))
* each panel answers for its OWN balance's spend ([67dde64](https://github.com/viztor/dsh-opencode-patch/commit/67dde648c67d91cdd46e49dc91a9b6c2d24047fa))
* fail the gate when lib/ is missing or older than src/ ([bc2820c](https://github.com/viztor/dsh-opencode-patch/commit/bc2820cdc0c762f5958e96162e6c484eb845ecd5))
* give the pill's fallback store a stable snapshot ([78afd36](https://github.com/viztor/dsh-opencode-patch/commit/78afd3695453410089eade5ed2e6262dd00ec7e1))
* let the effect own the mount's withdrawal, not the mount ([76cc32f](https://github.com/viztor/dsh-opencode-patch/commit/76cc32f90c7be454051592fc2124d79811da0043))
* localise the reset countdown, which was hardcoded English ([0efc2cb](https://github.com/viztor/dsh-opencode-patch/commit/0efc2cbaed461bd68701877d14bd28b20925dcbe))
* mount the usage contribution from the client ([e416621](https://github.com/viztor/dsh-opencode-patch/commit/e416621649f08b8253644a5bf7e735d4921ce905))
* never hand the Host a null inject face ([cc4a4f9](https://github.com/viztor/dsh-opencode-patch/commit/cc4a4f9b98cd1258439e7838451160ea5ff88c21))
* no loading state, no ellipsis — empty is stable ([0956621](https://github.com/viztor/dsh-opencode-patch/commit/095662155baed1d0c9178e127d668dcc1ac369f2))
* regenerate the catalog shim after models.dev moved, and re-pin the counts ([ee0622b](https://github.com/viztor/dsh-opencode-patch/commit/ee0622b18352526d27221172a62a9b420a21d58b))
* regenerate the go-limits shim after the vendor renamed an id ([2e9b5ad](https://github.com/viztor/dsh-opencode-patch/commit/2e9b5ad30ed4ad00309805245c2a14c040951d70))
* session spend always reads two decimals ([4ca13b6](https://github.com/viztor/dsh-opencode-patch/commit/4ca13b6679a429d98195d0fbf3a334a348ef4c0e))
* take effect from the plugin context, not the injected scope ([c60bff9](https://github.com/viztor/dsh-opencode-patch/commit/c60bff9316192315e9e990065080b520432d942d))
* take typert from the plugin context too ([f0e27c7](https://github.com/viztor/dsh-opencode-patch/commit/f0e27c7876ba40168886d5851f858c1b6d5c649e))
* the bundle ceiling is a tripwire, so stop trimming prose for it ([c2c294d](https://github.com/viztor/dsh-opencode-patch/commit/c2c294d52cd9b331056cc35f2d7392deca8779f4))
* the free-model row names the model, and stops repeating its own value ([056d2a1](https://github.com/viztor/dsh-opencode-patch/commit/056d2a18fd077bb28eef1ab16137d3159f0cff7e))
* the Go meter threw away the one credential that worked ([9ecef63](https://github.com/viztor/dsh-opencode-patch/commit/9ecef639ec8589c03e19e995163e0b0b9bf332ac))
* the Go quota window no longer leaks into the Zen route ([1a05d1a](https://github.com/viztor/dsh-opencode-patch/commit/1a05d1a67da445fb76e7c388dbb9ded56b1369c5))
* the meter showed no tooltip and ran its three actions together ([b0680db](https://github.com/viztor/dsh-opencode-patch/commit/b0680db47a9bc82fcb968931997abec800322299))
* the meter's Intl locale was never wired, and the billing note moves into a tooltip ([54ebb34](https://github.com/viztor/dsh-opencode-patch/commit/54ebb34aaa405d7f45bae86402c22a93ff4cc189))
* the meter's translator follows a live language switch ([66b18d8](https://github.com/viztor/dsh-opencode-patch/commit/66b18d8cd6c3217ec1497132154b5f9a186aee90))
* the panel header names the account, not its state ([89e25fc](https://github.com/viztor/dsh-opencode-patch/commit/89e25fcdb7849e28f57b805976d474a3c531f01e))
* the panel is translucent again, and one name for the bundle ([6663c36](https://github.com/viztor/dsh-opencode-patch/commit/6663c36f622f3560249e89193808bb963b2c9204))
* the panel names the model you picked, even with no price for it ([3f92037](https://github.com/viztor/dsh-opencode-patch/commit/3f9203753e0c102ab04b118e0cda90a63fd1fbf4))
* the panel no longer draws three invented 0% windows ([4a9e92c](https://github.com/viztor/dsh-opencode-patch/commit/4a9e92c488c6bab57b37de8ba260ae4084d0ef4b))
* the panel opts into the menu material instead of declaring its stroke ([91ded65](https://github.com/viztor/dsh-opencode-patch/commit/91ded6517b8a8bafcc20aab3febeb54ead2cf542))
* the panel's stroke is border-l2, and the elevation goes back ([1b75062](https://github.com/viztor/dsh-opencode-patch/commit/1b7506224a9976474bd77de78e731f131d5e4e83))
* the reset countdown floors, and composes with its own grammar ([00f4a13](https://github.com/viztor/dsh-opencode-patch/commit/00f4a13879d8c39bcec2c5dc95ac99414e27908d))
* the reset line is a sentence, so its word order is per-language ([5dab110](https://github.com/viztor/dsh-opencode-patch/commit/5dab11002fb40fb6c2dbc34bd8d7ec209efb55a4))
* the usage note hides behind a tooltip, not a paragraph ([43e634b](https://github.com/viztor/dsh-opencode-patch/commit/43e634b03a7aa610a2cef1e89d1bd48aee48d5c1))
* the Zen tooltip explains the spend instead of naming the account ([9e33279](https://github.com/viztor/dsh-opencode-patch/commit/9e33279714d086ee595a0d1b52877ce1099409dd))
* wait for the usage namespace in the scoped inject, not the top-level one ([5d78e58](https://github.com/viztor/dsh-opencode-patch/commit/5d78e58605e0d4ef610b3999d0961100bf4c7f0a))


### Reverts

* do not declare remote.opencodeGoUsage ([7714f7e](https://github.com/viztor/dsh-opencode-patch/commit/7714f7e4c960c1e66f825f9c02896f39af54157e))
* never declare remote.opencodeGoUsage as an inject key ([fb79c56](https://github.com/viztor/dsh-opencode-patch/commit/fb79c569faf7838d19ca2a74399322a34d3127ec))
* radius and stroke back to the menu's own values ([ff475ab](https://github.com/viztor/dsh-opencode-patch/commit/ff475abb0da29123d89c4ef3c04d28f684bb8e38))

## [0.13.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.12.0...v0.13.0) (2026-10-05)


### Features

* cover the Anthropic plane too, keyed off the vendor's SDK ([3c23f86](https://github.com/viztor/dsh-opencode-patch/commit/3c23f86c454855b524e0697077f0e4e892859a88))
* own the Responses route from the plugin, so the user changes nothing ([05184bc](https://github.com/viztor/dsh-opencode-patch/commit/05184bc6db34d085c390705be220c7296657bb2d))
* serve OpenCode's Responses-only model by re-dispatching, not translating ([b03c0cf](https://github.com/viztor/dsh-opencode-patch/commit/b03c0cff0e7fe9ee09a9b510740231fc417ed8bf))


### Bug Fixes

* describe a live model neither the catalog nor the shim knows ([5758d01](https://github.com/viztor/dsh-opencode-patch/commit/5758d01ad7c0e8e0a1496ce0fee3d7cdfa9ebe13))
* never offer a model whose protocol has no route ([a870842](https://github.com/viztor/dsh-opencode-patch/commit/a870842d5454d12990001657a47b40db417bef2b))
* read the Responses split from the vendor's SDK, not a model list ([2980ae9](https://github.com/viztor/dsh-opencode-patch/commit/2980ae9ffdfc0f50afae9949462bbad77f40eeb0))

## [0.12.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.11.0...v0.12.0) (2026-10-03)


### Features

* auto-enrich gateway /models responses with canonical 33-model catalog ([2f9e9e7](https://github.com/viztor/dsh-opencode-patch/commit/2f9e9e7e0f6e7cfb344044c20ec19d55896d5e32))
* dual-catalog SWR updates (Go + Zen free models) and routed key resolution ([4124479](https://github.com/viztor/dsh-opencode-patch/commit/41244790fe63f1497f58f3b36f82803cd7e780fb))
* dynamically attribute x-opencode-project to workspace directory ([9adfb9a](https://github.com/viztor/dsh-opencode-patch/commit/9adfb9a0837f40bc8b3edf23b3d2669eee71c9c6))
* inject x-session-affinity and x-parent-session-id for proxy and gateway compatibility ([9883251](https://github.com/viztor/dsh-opencode-patch/commit/9883251e5188412731858b7bc46d5876cc35088b))
* make quota meter provider-based, remove UI debug fields, and enhance provider discovery ([979e9ed](https://github.com/viztor/dsh-opencode-patch/commit/979e9ed4e438a645c7d08f19fe92811e18842a0b))
* real-time Stale-While-Revalidate (SWR) model catalog updating with local shim ([19fe3e1](https://github.com/viztor/dsh-opencode-patch/commit/19fe3e173a05903bb14099d0245967c3576d4c57))
* refine Go and Zen usage display and attach available Zen credit ([4e2c01d](https://github.com/viztor/dsh-opencode-patch/commit/4e2c01d56959319c0445abef741d837eb9414120))
* replace boolean text inputs with Switch toggles in settings card ([857b4d7](https://github.com/viztor/dsh-opencode-patch/commit/857b4d7e86b458b26edbd2c4e4a7bbe38c06b5bf))
* replace originProject text override with natural language injectProject toggle ([b34fabe](https://github.com/viztor/dsh-opencode-patch/commit/b34fabe87c02a3906a9599233c2958c52ab63e5a))
* session spend tracking, catalog/price toggles, and split test suite ([a5fa579](https://github.com/viztor/dsh-opencode-patch/commit/a5fa579289659f888e1ef0d94a51aa8f87bc4030))
* support x-opencode-parent-session-id for DSH subagents and child sessions ([58354e4](https://github.com/viztor/dsh-opencode-patch/commit/58354e498a80ac843e1d9bfe607f0f6a71f8a993))


### Bug Fixes

* apply request patch to auto-review calls and inject session-id headers ([b6e492a](https://github.com/viztor/dsh-opencode-patch/commit/b6e492a077f3c6adc55dd079b03593faf8fb7bd5))
* isolate Go usage queries to Go keys and ignore Zen keys for quota endpoint ([cfecac0](https://github.com/viztor/dsh-opencode-patch/commit/cfecac03091638fc6d33eacf982a7e7e351503c1))
* keep deprecated models out of the refresh, and correct the README model lists ([5ca3c4f](https://github.com/viztor/dsh-opencode-patch/commit/5ca3c4f6933d983d15df63f2c96393c073cf1b16))
* remove default export so cordis unwrapExports exposes Config ([80c7af1](https://github.com/viztor/dsh-opencode-patch/commit/80c7af152ff37f9d8de8b54e6e39135f0dbfa9a0))
* scope the spend reading to the conversation and route that asked for it ([dc5e1b1](https://github.com/viztor/dsh-opencode-patch/commit/dc5e1b129e6354674b26dfb8fecd9f2174e0e250))
* ship only active catalog models with rates, and cover the new surface ([73a9d0f](https://github.com/viztor/dsh-opencode-patch/commit/73a9d0f53ac9022bc5911312666ec29d3b3a6a16))

## [0.11.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.10.1...v0.11.0) (2026-10-02)


### Features

* make gateway, origin, session, and quota-meter behavior configurable ([6937f56](https://github.com/viztor/dsh-opencode-patch/commit/6937f56eef9651fd92a46ea7037b13735988f520))

## [0.10.1](https://github.com/viztor/dsh-opencode-patch/compare/v0.10.0...v0.10.1) (2026-10-02)


### Bug Fixes

* **settings:** export volatile Config schema and decouple bundle slot registration ([41db32b](https://github.com/viztor/dsh-opencode-patch/commit/41db32b8edacb9726a157200fc2e9f7a5dab8ab0))

## [0.10.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.9.2...v0.10.0) (2026-10-01)


### Features

* link the console, and document why balance cannot be shown ([e5a3684](https://github.com/viztor/dsh-opencode-patch/commit/e5a3684ed8e9eb238eef7c44c80f8ca1f5b4213f))

## [0.9.2](https://github.com/viztor/dsh-opencode-patch/compare/v0.9.1...v0.9.2) (2026-10-01)


### Bug Fixes

* draw the quota meter once, and only when Go is configured ([215149e](https://github.com/viztor/dsh-opencode-patch/commit/215149e968354930972706ccd8d6e0999a3bdf0d))
* publish safely, thin the wrapper's client half, and ship plugin metadata ([0c95202](https://github.com/viztor/dsh-opencode-patch/commit/0c95202c6aa5fd8dfdd30a3ae812fbc24484c1b6))

## [0.9.1](https://github.com/viztor/dsh-opencode-patch/compare/v0.9.0...v0.9.1) (2026-10-01)


### Bug Fixes

* add publish error recovery and non-blocking scoped publishing ([4baea6f](https://github.com/viztor/dsh-opencode-patch/commit/4baea6fc737ae046fa33c5e8840ca8eeeb35c7fe))
* rewrite cordis.patch.yml name for scoped package ([a164f98](https://github.com/viztor/dsh-opencode-patch/commit/a164f9845348bbdd2371971168f2371b808972e2))

## [0.9.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.8.0...v0.9.0) (2026-10-01)


### Features

* expose usage monitor settings in Web UI and mount in composer dock ([9a28f25](https://github.com/viztor/dsh-opencode-patch/commit/9a28f25e121ed08d831e70e48f0558091c185162))

## [0.8.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.7.0...v0.8.0) (2026-10-01)


### Features

* implement thin wrapper pattern for legacy @viztor/dsh-opencode package ([8ad0d94](https://github.com/viztor/dsh-opencode-patch/commit/8ad0d94c6097904380dc85a7411d9b51ed0e84db))

## [0.7.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.6.0...v0.7.0) (2026-10-01)


### Features

* add manifest deprecation, redirect README, and runtime notice for legacy package ([f2b779a](https://github.com/viztor/dsh-opencode-patch/commit/f2b779a7ffbb2a87bd89a651b2d41d575a30ef62))
* alias legacy dsh-opencode across loader, settings, and publishing ([c344067](https://github.com/viztor/dsh-opencode-patch/commit/c3440672cde3072ff74321e4cb64a8cb365b3a1b))
* auto-discover opencode-go apiKeyEnv, apiKey, and baseURL from user config ([5e4b169](https://github.com/viztor/dsh-opencode-patch/commit/5e4b1695bca6eca60323bec451038ecae6bd9c7c))
* render circular meter trigger and rich hover modal for quota breakdown ([b3f74a4](https://github.com/viztor/dsh-opencode-patch/commit/b3f74a4a35452b2ad260fba3416efb91fdfa5703))

## [0.6.0](https://github.com/viztor/dsh-opencode-patch/compare/v0.5.1...v0.6.0) (2026-10-01)


### Features

* rename to dsh-opencode-patch and add live OpenCode Go quota pill ([e3eb48d](https://github.com/viztor/dsh-opencode-patch/commit/e3eb48d5b716bfa7fd8184ead823232a8ce4aa01))
* restyle the icon into the Harness icon family ([eeb1fd8](https://github.com/viztor/dsh-opencode-patch/commit/eeb1fd8a21babdb273969cf82e9f91db0a1a380a))

## [0.5.1](https://github.com/viztor/dsh-opencode/compare/v0.5.0...v0.5.1) (2026-10-01)


### Bug Fixes

* remove session mode option, always derive gateway IDs ([5ef6fca](https://github.com/viztor/dsh-opencode/commit/5ef6fca60cefda0c768059d73185d44f24d404dd))

## [0.5.0](https://github.com/viztor/dsh-opencode/compare/v0.4.0...v0.5.0) (2026-09-30)


### Features

* complete settings UI coverage and drop session cache table ([7ac8b3c](https://github.com/viztor/dsh-opencode/commit/7ac8b3c2cf32148d80a593d638489432ca931249))

## [0.4.0](https://github.com/viztor/dsh-opencode/compare/v0.3.4...v0.4.0) (2026-09-30)


### Features

* bundle icon for plugin display surfaces ([9882c0e](https://github.com/viztor/dsh-opencode/commit/9882c0edf03665d753f783ac2a47c303c40f030b))

## [0.3.4](https://github.com/viztor/dsh-opencode/compare/v0.3.3...v0.3.4) (2026-09-30)


### Bug Fixes

* register client bundle under npm package name ([d052c84](https://github.com/viztor/dsh-opencode/commit/d052c84f840c6af662deede084439cc699a1058b))

## [0.3.3](https://github.com/viztor/dsh-opencode/compare/v0.3.2...v0.3.3) (2026-09-30)


### Bug Fixes

* cordis row name must equal npm package name ([4907117](https://github.com/viztor/dsh-opencode/commit/49071171703f0a7e025beb5319b6ebac37077240))

## [0.3.2](https://github.com/viztor/dsh-opencode/compare/v0.3.1...v0.3.2) (2026-09-30)


### Bug Fixes

* register settings card on plugins.bundle.config keyed by package name ([9409a30](https://github.com/viztor/dsh-opencode/commit/9409a30917f3408f345a260375396d95182426fb))

## [0.3.1](https://github.com/viztor/dsh-opencode/compare/v0.3.0...v0.3.1) (2026-09-30)


### Bug Fixes

* surface effective defaults in settings UI labels and hints ([76d768d](https://github.com/viztor/dsh-opencode/commit/76d768d2755ce24c8367e6103f05d067bc3f4c43))

## [0.3.0](https://github.com/viztor/dsh-opencode/compare/v0.2.1...v0.3.0) (2026-09-30)


### Features

* auto releases, GitHub Packages mirror, and verified-compat docs ([e42b427](https://github.com/viztor/dsh-opencode/commit/e42b427365c63a35c5ed1c419c71a55d76c3b72f))

## [0.2.1] - 2026-10-01

### Changed

- **Published to npm as `@viztor/dsh-opencode`** (unscoped name is squatted; scopes need no org).
- **OIDC trusted publishing**: tag-triggered `release` workflow publishes with provenance, no tokens.
- **Continuous integration**: `ci.yml` runs check + tests + build on every push to `main` and every PR.
- **Docs restructure**: consumer-friendly README titled "OpenCode on DeepSeek Harness" with badges and troubleshooting; contributor guide split into `CONTRIBUTING.md`; project-specific `AGENTS.md`.

### Fixed

- Debug-file race in the session-affinity test: waits for the expected line count instead of first non-empty read.

---

## [0.2.0] - 2026-10-01

### Added

- **OpenCode Zen Free-Tier Gateway Support (`403 FreeTierError` fix)**:
  - OpenCode's gateway (`https://opencode.ai/zen/v1`) enforces client origin and tool validation on free community models (such as `muse-spark-1.3-contributor-free` and `space-bunny-free`).
  - DSH's internal LLM adapter (`dsh-llm-pi-ai`) classifies `user-agent` as a reserved header and strips it from outgoing requests.
  - `dsh-opencode` restores `User-Agent: opencode/1.18.33 ...`, `x-opencode-client: cli`, and `x-opencode-project: global` at the network fetch layer.
- **Configurable Header Controls & User-Agent Override**:
  - `injectUserAgent` (boolean, default `true`): Toggle User-Agent restoration on/off.
  - `userAgent` (string, default empty): Allows specifying a custom User-Agent override string. When left empty, uses the canonical OpenCode CLI User-Agent.
  - `injectOriginHeaders` (boolean, default `true`): Toggle injection of `x-opencode-client: cli` and `x-opencode-project: global`.
  - `injectCoreTools` (boolean, default `true`): Toggle fallback injection of standard `read` (`filePath`) and `bash` (`command`) tool schemas on free-tier `/responses` requests when tools are empty.
- **Strict Request Differentiation**:
  - Differentiates OpenCode API requests (`opencode.ai/zen` and configured provider routes) from all other network traffic.
  - Non-OpenCode requests (e.g. `api.deepseek.com`, Anthropic, OpenAI, GitHub, arbitrary tool calls) pass through completely untouched.
- **Deterministic Session ID Hashing**:
  - OpenCode Zen's gateway requires session IDs matching `^ses_[0-9a-f]{12}[A-Za-z0-9]{14}$` (30 characters).
  - Raw DSH conversation UUIDs are deterministically hashed via SHA-256 into compliant `ses_...` IDs, preserving conversation turn affinity and prompt cache warmth without triggering gateway format validation errors.
- **DSH Web Client Settings UI (`src/settings-page.tsx`)**:
  - Ships a client bundle (`lib/client.js`) registering an OpenCode configuration card under **DSH Settings -> Plugins**.
  - Provides reactive UI controls for toggling User-Agent injection, editing User-Agent overrides, toggling origin headers, and managing provider lists.
  - Full English (`en`) and Simplified Chinese (`zh`) localization.
- **100% TypeScript & Node 24+ Target**:
  - Re-implemented the entire codebase in strict TypeScript (`src/index.ts`, `src/settings-page.tsx`, `test/plugin.test.ts`, `scripts/name-client-bundle.ts`).
  - Runtime targeted to **Node 24+** (`engines: { node: ">=24" }`, `target: "node24"`, `ES2024`).
- **Vite+ (`vp`) Toolchain Integration**:
  - Dual library bundling with tsdown (`vp pack`): Host ESM bundle + DTS emit (`lib/index.mjs`, `lib/index.d.mts`) and browser client bundle (`lib/client.js`).
  - Oxlint linting extending Ultracite (`vp lint`).
  - Oxfmt formatting (`vp fmt`).
  - Parallel Vitest testing suite (`vp test`).
- **Comprehensive Unit Testing**:
  - 44 deterministic tests covering hashing, config, session caching, stream context, request differentiation, header injection, tool injection, and plugin lifecycle.
- **Proper Attribution & MIT Licensing**:
  - Dual copyright attribution acknowledging original author `@nobu121` and maintainer `@viztor`.

### Changed

- Renamed package to `dsh-opencode` to reflect full OpenCode platform integration beyond session headers.
- Safe environment fallback: `OPENCODE_SESSION_ID` can be supplied via environment; never hardcodes private session IDs in source or git history.

---

## Upstream Comparison (vs `nobu121/dsh-opencode-session` v0.1.1)

| Capability | Upstream (`v0.1.1`) | `dsh-opencode` (`v0.2.0`) |
| :-- | :-- | :-- |
| **Primary Goal** | Fix `400 MissingSessionID` on OpenCode Go | Fix `400 MissingSessionID` + `403 FreeTierError` on OpenCode Zen |
| **Header Injection** | `x-opencode-session` only | `x-opencode-session`, `User-Agent`, `x-opencode-client`, `x-opencode-project` |
| **Session ID Format** | Raw DSH UUID (triggers 403 on Zen) | Deterministic SHA-256 mapping to `ses_<hex12><base62>` |
| **User-Agent Handling** | None (stripped by DSH adapter) | Restored & configurable with custom override |
| **Free-Tier Gateway Tools** | None | Fallback injection of `read` & `bash` schemas |
| **Request Differentiation** | Provider filter on `llm/stream` | Provider filter + URL validation guard in `patchFetch` |
| **Settings UI** | None | DSH Web Client Settings Card (`src/settings-page.tsx`) |
| **Language** | Plain JavaScript (untyped `.js` / `.mjs`) | 100% Strict TypeScript |
| **Runtime Target** | Node 20+ | Node 24+ (`ES2024`) |
| **Toolchain** | Bare Node scripts | Vite+ (`vp pack`, `vp check`, `vp test`, Oxlint, Oxfmt) |
