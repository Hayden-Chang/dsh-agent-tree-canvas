# 插件索引

`index.json` 是 dsh 的插件索引文件（格式 1）。把它托管在任意静态 https 地址后，用户在
**Plugins → Discover → Add index source** 添加地址即可浏览和安装本插件。

本仓库通过 GitHub raw 提供索引：

```
https://raw.githubusercontent.com/Hayden-Chang/dsh-agent-tree-canvas/main/market/index.json
```

添加索引前需要在 **Plugins → Experimental plugins** 打开 **Custom plugin indexes**（旧版本名为
Custom plugin markets），Discover 标签页才会出现。dsh 不跟随重定向，因此使用上面的 `raw.githubusercontent.com` 地址。

## 索引如何安装本插件

索引里每个版本都用 `source.type: git` 指向一个完整 commit 和包目录（`path`）。
dsh 通过 pnpm 从该 commit 安装，并在安装时运行包自己的 `prepare` 脚本构建产物，
因此索引指向的 commit 必须同时包含可构建的源码和兼容的 `engines.dsh`。

pnpm 默认不允许依赖运行构建脚本。第一次安装时 dsh 会提示允许，
在 **Plugins** 里选择 **Allow these scripts and retry** 即可（只批准一次，按该 commit 记录）。

## 生成与更新

索引只能由脚本生成，不要手写。**先推送到远端再生成**，否则索引会指向别人取不到的 commit：

```sh
# 1. 提交并推送要发布的插件代码（-A 才能带上新增文件）
git add -A && git commit -m "Release my change"
git push

# 2. 用该 commit 生成索引
pnpm run market:index -- --commit "$(git rev-parse HEAD)"

# 3. 提交索引
git add -A && git commit -m "Update plugin index"
```

脚本校验这个 commit 存在、包含 `prepare` 脚本和构建所需的
`scripts/build.mjs`、`tsconfig.base.json`、`tsconfig.host.json`、`tsconfig.client.json`，
再从该 commit（而不是工作区）读取 `package.json` 与**全部** `locale/*.json`，
所以工作区里未提交的改动不会进入索引。发布时间默认取该 commit 的提交时间，重新生成是幂等的。

生成前会先用 `@deepseek-ai/dsh-plugin-market-index`（与当前 dsh 相同的版本）解析一遍，
不合规会直接失败。

| 选项 | 含义 |
| --- | --- |
| `--commit <sha>` | 要发布的 commit，默认 `HEAD`，必须存在 |
| `--timestamp <秒>` | 发布时间，默认取该 commit 的提交时间 |
| `--url <url>` | 索引将要托管的地址，用于解析相对图标 |
| `--author <text>` | Discover 里显示的作者，默认 `Hayden-Chang` |
| `--title <text>` | Discover 里显示的索引名 |
| `--check` | 只校验：已提交的索引与生成结果不一致时失败；不带 `--commit` 时比对索引里已记录的 commit |
| `--help` | 打印用法 |

发版后确认索引没有过期：

```sh
pnpm run market:index -- --check
```

## 限制

- `engines.dsh` 之外的 dsh 版本会在安装时被拒绝，需要发布新版本或使用 exact-version 豁免。
- 索引不提供图标：`icon` 字段省略时 dsh 使用面板默认图形。包本身也没有导出 `./icon`。
- 索引指向的 commit 一旦发布就应视为不可变；代码有变化时按上面的步骤重新生成索引。
- 仓库没有 CI，`--check` 需要手动运行；接入流水线后应作为发布步骤执行。
