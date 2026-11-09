# Upstream

This skill is based on [VikingMew/wechat-publisher-mcp](https://github.com/VikingMew/wechat-publisher-mcp/tree/4dc23ae4305ddd7fb7bdd941d1ddc542e3e69661/skills/wechat-official-account), commit `4dc23ae4305ddd7fb7bdd941d1ddc542e3e69661`. The upstream MIT license is reproduced in `LICENSE`.

Easy Code adds marketplace metadata, supports the existing project-local WeChat credential file, and uses WeChat's stable access-token endpoint in non-forced mode. The standalone Python skill requires no MCP service.

Daily article reads use WeChat's `getarticleread` API. The signed-in browser and report-analysis guidance are Easy Code additions for accounts without that API permission.
