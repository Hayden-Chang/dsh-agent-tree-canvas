---
kind: upgrade-guide
description: 脑图生成显式返回新建节点标识，并允许成功但不创建节点。
---
# 脑图生成结果

## 变更

Session canvas 0.1.6 将 `sessionCanvas.mindmap` 的返回值从画布文档改为 `{ canvas, createdSessionIds }`。空列表表示选中文字无需进一步拆分。模型大纲允许零个或多个深度为零的节点；创建 Session 前会拒绝与祖先或同级节点重复的主题。

## 迁移

1. 将 0.1.6 插件包安装到相同的原版 DSH profile，重启 DSH 并刷新浏览器，让宿主和客户端使用一致的协议。
2. 外部调用方从 `result.canvas` 读取文档，将空的 `result.createdSessionIds` 视为成功，不触发跳转或重新布局。
3. 已有 Session、总结和脑图无需迁移，也不会被自动重新生成。验证简洁选区显示无需拆分提示，结构化选区可以创建子节点。
