![OpenCode Patch — session affinity, gateway headers and live Go quota](./media/hero.svg)

OpenCode's own CLI and this plugin make the same requests to the same gateway. The difference is what the gateway is told about them, and what the composer shows while they run: this patch restores the request identity the official CLI sends, keeps one session across turns, and puts the live Go quota beside the input box.

## What you get

| Surface | What it does |
| :-- | :-- |
| Gateway requests | Sends the official CLI's `User-Agent`, origin headers and workspace project tag, so Cloudflare's WAF checks pass |
| Sessions | One session id per conversation, derived and reused, so Zen and Go stop treating every turn as a stranger |
| Quota | The Go panel — 5-hour, weekly and monthly rings, the monthly allowance per model — and the Zen session spend |
| Routing | Models served on another protocol are routed to the endpoint that speaks it, instead of being refused |

## Where the rest lives

- The full reference — configuration, every control, the model tables — is in [README.md](https://github.com/viztor/dsh-opencode-patch#readme).
- The meter's numbers, and what each row means, are in [docs/quota-meter.md](https://github.com/viztor/dsh-opencode-patch/blob/main/docs/quota-meter.md).
- The endpoints, the headers and the measurements behind them are in [docs/redirect-planes.md](https://github.com/viztor/dsh-opencode-patch/blob/main/docs/redirect-planes.md).
