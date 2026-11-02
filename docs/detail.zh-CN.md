![OpenCode 补丁——会话保持、网关请求头与实时 Go 额度](./media/hero.svg)

OpenCode 自己的 CLI 和这个插件向同一个网关发的是同一批请求，差别在于网关被告知了什么、以及运行的时候输入框旁边显示了什么：本补丁恢复官方 CLI 的请求身份、让同一段对话共用一个会话、并把实时 Go 额度放在输入框旁。

## 你能得到什么

| 界面 | 作用 |
| :-- | :-- |
| 网关请求 | 发送官方 CLI 的 `User-Agent`、来源请求头和工作区项目标识，使 Cloudflare WAF 校验通过 |
| 会话 | 每段对话一个会话 id，推导并复用，Zen 与 Go 不再把每一轮都当成陌生人 |
| 额度 | Go 面板——5 小时、每周、每月三个环，以及按模型的月度额度——和 Zen 的会话消耗 |
| 路由 | 走另一种协议的模型会被送到说那种协议的端点，而不是被拒绝 |

## 其余内容在哪儿

- 完整参考——配置、每个控件、模型表——在 [README.zh-CN.md](https://github.com/viztor/dsh-opencode-patch/blob/main/README.zh-CN.md)。
- 计量表上每个数字、每一行在说什么，在 [docs/quota-meter.zh-CN.md](https://github.com/viztor/dsh-opencode-patch/blob/main/docs/quota-meter.zh-CN.md)。
- 端点、请求头以及它们背后的实测，在 [docs/redirect-planes.md](https://github.com/viztor/dsh-opencode-patch/blob/main/docs/redirect-planes.md)。
