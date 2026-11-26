---
description: "Agent tree canvas 0.1.10 画布对话改用 Web profile 的 standard Agent 预设。"
---

# 使用 standard Agent 预设

[English](guide.md) | 中文

## 变更

Agent tree canvas 0.1.10 创建的新画布 Session 使用 Web profile 的 `standard` Agent 预设。记录为 `agent-tree-canvas` 或 `session-canvas` 的 Session 在恢复或分叉时也会挂载 `standard`。对话 persona 和 profile 启用的工具由该预设提供。现有 Session 日志不会改写。

## 迁移

1. 从 Web profile overlay 的 `agent-tree-canvas` 条目中删除插件级 `persona` 字段。对话现在使用 profile 的 `standard` 预设配置的 persona；需要自定义指令时请修改该预设。
2. 保留 Web profile 中的 `standard` 预设。原版 Web profile 已提供此预设；自定义组合必须自行声明。
3. 安装新版插件并重启 `dsh web`。现有画布文档和 Session 数据无需迁移。
