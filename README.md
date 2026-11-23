# Session canvas

独立的 DeepSeek Harness 插件。安装到原版 **DSH 0.2.2-rc.1** 即可使用，不需要修改或重新编译 DSH。插件版本与 DSH 版本独立管理。

## 安装

需要 Node >=24.9，以及已安装的 DSH 0.2.2-rc.1。

```sh
dsh plugin --profile web add /absolute/path/deepseek-ai-dsh-session-canvas-0.1.8.tgz
dsh web
```

在侧边栏打开「会话画布」。模型和 API 凭据仍通过 DSH 的设置配置。`DSH_HOME` 决定使用哪份配置和数据；替换旧开发版本时保持原来的 `DSH_HOME` 和浏览器地址，才能继续使用原有会话、画布和本地草稿。

从 0.1.7 升级且自定义过脑图 token 额度时，请查看[脑图配置升级说明](docs/upgrade-guide/v0.1.7/mindmap-token-budget/guide.zh.md)。

## 功能

- Session 树、按已完成轮次快照分叉；子节点保留模型上下文，画布隐藏继承的对话。
- 节点右下角的复选框标记「已学完」并持久保存。所有子节点学完后才可勾选父节点；新增子节点或取消勾选会同步清除相关祖先的完成标记。
- 悬停节点时，右上角可删除整棵子树，确认后彻底删除节点及全部后代的会话历史、上下文、总结、版本与草稿，不可撤销。
- 总结正文和编辑状态都支持选区菜单：引用文本、在子会话中引用；引用不自动发送。
- 每个节点及整个画布切换对话／总结。全部总结简洁显示正文，悬停时显示右上角删除按钮，并按实际内容尺寸紧凑排列。
- Markdown 原地编辑、实时排版、自动保存、草稿恢复、冲突处理、版本历史和导出。
- 选区原样加入总结，或在子会话中引用。引用悬浮展示全文，点击定位父节点或自身的原消息。
- 彩色分支、节点样式、明暗主题、拖动、平移、快捷键、鼠标与触控板独立缩放增益、聚焦节点。

完整操作和限制见 [中文说明](packages/session-canvas/README.zh.md) / [English](packages/session-canvas/README.md)。

## 本地开发

```sh
git clone https://github.com/Hayden-Chang/dsh-session-canvas.git
cd dsh-session-canvas
pnpm install --frozen-lockfile
pnpm run build
pnpm run typecheck
pnpm test
pnpm run pack
```

构建只使用 npm 发布的依赖；不需要 DSH 源码、monorepo 构建脚本或工作区链接。产物位于 `dist/`，将生成的 `.tgz` 路径传给上面的 `dsh plugin` 安装命令。需要链接开发时，安装 `link:/absolute/path/to/this-repo/packages/session-canvas`，修改后重新构建插件并刷新页面。

浏览器回归使用一份未修改且已构建的 DSH 测试载体；这是测试依赖，不是插件运行或构建依赖。`CANVAS_PACKAGE_DIR` 指向通过上述安装命令安装的包。

```sh
DSH_STOCK_ROOT=/absolute/path/to/stock-dsh \
CANVAS_PACKAGE_DIR=/absolute/path/to/profile/node_modules/@deepseek-ai/dsh-session-canvas \
pnpm exec vitest run --config vitest.web.config.ts
```

### 使用原版 DSH 源码启动预览

使用固定数据目录（不要放在 `/tmp` 或 `/private/tmp`），保持现有 `DSH_HOME` 和端口，使用下面的启动脚本避免其他工程的 `pnpm` shim 将旧插件注入 `NODE_PATH`。脚本仍然通过原版 `dsh web` 启动；现有 profile 缺失时会停止，不会自动创建空环境。

```sh
DSH_STOCK_ROOT=/absolute/path/to/stock-dsh \
DSH_HOME=/absolute/path/to/existing-dsh-home \
node scripts/preview.mjs --host 127.0.0.1 --port 3085
```

安装包后需要在插件页面启用。核对该页的实际版本与安装包版本相同，并确认侧边栏可打开会话画布。

## 实现范围

Host 使用原版 DSH 的 Agent registry、Session controller、投影、存储域和 Remote 注册。Client 使用原版嵌入式会话、选区插槽和输入框 reference 扩展；继承消息隐藏、引用来源定位、引用预览及分支颜色全部由插件实现。没有 DSH 补丁、`patch-package`、安装后修改宿主文件或运行时替换 DSH 方法。

引用通过插件自己的 reference 编码保存来源，发送给模型时仅序列化引用文字。旧版草稿在载入前转换，转换前保存原始备份。会话和 `session_canvas` 存储格式保持兼容；卸载插件不会删除这些数据。

当前对 DSH 的兼容声明固定为 0.2.2-rc.1。原版 DOM 的 `data-*` 属性用于画布内展示适配；升级 DSH 前需重新运行浏览器回归。上游基线见 [UPSTREAM.md](UPSTREAM.md)。

Selected chat or summary text can generate a bounded tree of independent Sessions. Generated nodes retain their frozen selection, full path, and initial content for later conversation; editing their summaries does not rewrite that context. Delete buttons appear on node hover or keyboard focus. See the [plugin guide](packages/session-canvas/README.md) for limits and failure recovery.

删除语义变更见 [升级说明](docs/upgrade-guide/v0.1.4/permanent-subtree-deletion/guide.zh.md)。
