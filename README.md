# EasyCode 技能仓库

这是 EasyCode 技能商城当前已发布技能的源码备份仓库。仓库中的内容可审查、可回滚，并保留技能的说明、媒体资源和商城元数据。

> 事实源：`https://github.com/OrionStarAI/easycode-skills-workspace`（原 `OrionStarAI/easycode-skills` 已停止维护，商城后台同步源已于 2026-11-03 切换到本仓库）。

当前仓库只放生产商城范围内的技能（当前 34 个，其中 24 个声明了上游来源，10 个为内部维护技能）；个人、实验中、未上架和仅保存在本地的技能不放入这里。

## 目录结构

每个技能位于 `skills/<技能名>/`：

- `SKILL.md`：技能正文和 YAML frontmatter；
- `marketplace.json`：版本、使用示例、对象存储键等商城元数据（上架/下架状态由商城后台管理，不在仓库声明）；
- `assets/`：图标、详情预览图、缩略图和示例产出文件；
- 其他脚本和参考资料：技能运行时需要的资源。

运行缓存、依赖目录、环境文件和密钥不会提交到仓库。

## 上游同步

24 个技能在 `SKILL.md` 中声明了上游仓库、源码路径和已审核提交号。GitHub Actions 每天北京时间 10:00 检查上游，也可以手动运行 **Sync upstream skills**。发现更新后，Action 会在独立分支创建或更新 PR，供人工审核。

同步使用已审核提交号做三方合并：新增文件自动带入，未被本地修改的删除会同步，本地和上游同时修改的文本会保留冲突标记并等待处理。同步不会直接修改 EasyCode 后台，也不会直接写入 GCS。没有上游元数据的内部上传技能（当前 10 个）仍由普通 PR 手工维护。

上游元数据示例：

```yaml
---
name: docx
description: "..."
upstream: anthropics/skills
upstreamPath: skills/docx
upstreamSha: 53048666b05b4799081517d00e09e0a2dd688678
author: anthropics
---
```

## 技能门禁

每个 Pull Request 和推送到 `main` 都会运行 **Skill Gate**。门禁会用真实 YAML 解析器检查 `SKILL.md`，并校验 `marketplace.json`、媒体文件路径和数量、技能目录命名、上游提交号、常见凭据/私钥以及合并冲突标记。未加引号的 description 冒号等问题会在合并前失败。

管理员应在 `main` 的分支保护或 Ruleset 中要求通过 `Validate skills` 后才能合并，并禁止绕过规则。组织迁移后请重新确认这项设置。具体维护规则见 [docs/skill-sync.md](docs/skill-sync.md)。

## 技能分类

`SKILL.md` 的 `category` 是 Git 同步技能的分类事实源，必须使用下面的规范名称：

- `文档办公`
- `演示与设计`
- `视频创作`
- `社媒运营`
- `开发工具`
- `浏览器与测试`
- `阅读与知识`

分类按用户目标划分，不按实现技术划分。例如 Remotion、演讲视频工坊和涂鸦动画都属于 `视频创作`；抖音发布属于 `社媒运营`。

## 发布边界

目前 GitHub 仓库**没有**单独的 tag 发布 workflow。普通提交、上游同步 PR 和生产发布是三件事：

1. 合并通过门禁的技能源码到 `main`；
2. 生产环境的 EasyCode 服务按小时自动同步本仓库 `main`，打包技能 ZIP、更新 GCS 制品与商城元数据——合入后通常一小时内生效，不需要任何标签；
3. 只有服务端代码变更才需要在 GitLab `easycodeskills` 仓库的 `main` 提交上打 `release-online-*` tag；Open C3 会自动构建并部署，与本仓库的内容同步无关。

因此本仓库不需要为发布打 tag；未来若需要 GitHub tag 直接生成发布包或通知服务端，再单独增加发布 workflow。

## 本地检查

```shell
ruby scripts/validate_skills.rb --self-test
ruby scripts/sync_upstreams.rb --self-test
ruby scripts/validate_skills.rb
ruby scripts/sync_upstreams.rb
```

`scripts/sync_upstreams.rb` 只会修改当前工作树，适合在 PR 分支或 CI 临时分支运行；它不会上传对象存储。更多同步、冲突处理和分支保护说明见 [docs/skill-sync.md](docs/skill-sync.md)。

## 专家和 MCP 目录

`catalog/expert-templates.json` 和 `catalog/mcp-servers.json` 是 Easy Code 桌面端专家市场和 MCP 市场的数据源。改动走 Pull Request，通过 Skill Gate 合入 `main` 后，商城服务每小时自动同步，也可以在管理后台点「立即同步」。

所有市场专家的源码都放在 `experts/<id>/`：`expert.json` 声明版本、显示信息和技能依赖，`EXPERT.md` 与 `EXPERT.en.md` 分别维护中英文职责。不要直接修改索引里的专家内容：修改专家包后运行 `node scripts/build_expert_catalog.mjs`，将生成的 `catalog/expert-templates.json` 一并提交。Skill Gate 会拒绝缺少专家包或与索引不一致的专家，并检查技能依赖是否存在。专家团定义仍直接维护在同一个 GitHub 目录文件中。

支持新格式的桌面客户端会读取工作方式和技能依赖；支持自动准备依赖的版本会在保存或使用专家时安装或启用所需技能。旧版模板未显式指定 `promptProfile`，以保持旧客户端的可见性；新版客户端按专家类别选择原有默认工作方式。新增专家建议显式指定 `general` 或 `coding`，服务端会对不支持相应能力的旧客户端隐藏无法使用的专家与相关团队。已创建的本地专家不会自动跟随模板版本更新。

- 校验规则见 `scripts/validate_catalog.rb`，服务端同步时会再校验一次；不通过的文件会被整份拒绝，线上内容保持不变。
- 专家的 `instructions` 会成为模型的系统提示词，评审时请当作代码看待。
- 这是公开仓库，MCP 的 `preset` 只能写 `YOUR_` 开头的占位符，不能写真实密钥。
