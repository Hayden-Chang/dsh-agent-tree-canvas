---
kind: upgrade-guide
description: "会话画布 0.1.8 的脑图请求改用 maxMindmapOutputTokens，不再使用 maxOutputTokens。"
---

# 独立配置脑图输出额度

[English](guide.md) | 中文

## 变更

独立会话画布插件从 0.1.7 升级到 0.1.8 后，`maxOutputTokens` 继续控制总结，但不再控制脑图。脑图使用 `maxMindmapOutputTokens`，每次请求默认 16384 token；若提供商将推理计入输出额度，此值也包含推理。生成和原文检查通常各请求一次。`mindmapAttempts` 默认允许每阶段最多 2 次尝试，只重试无效或 token 截断的输出；插件不自动重试传输错误或取消。

## 迁移

1. 若此前自定义 `maxOutputTokens` 限制脑图，请在 Web profile overlay（`$DSH_HOME/profiles/web/cordis.patch.yml`）的 `session-canvas` 条目 `config` 中，将相同值填写到 `maxMindmapOutputTokens`。`maxOutputTokens` 保留所需的总结额度。如果不允许自动重试输出，可在同一位置设置 `mindmapAttempts: 1`。默认安装无需修改配置。
2. 安装 0.1.8 插件归档后重启 `dsh web`。DSH 本体仍为 0.2.2-rc.1，已有画布和会话数据无需迁移。
3. 生成一次脑图，查看日志中的 `plugin:session-canvas/mindmap-request` 记录，确认 `config.maxTokens` 等于配置的脑图额度。每次完成的尝试都会保存 `plugin:session-canvas/mindmap-response` 记录，包含阶段及尝试编号。
