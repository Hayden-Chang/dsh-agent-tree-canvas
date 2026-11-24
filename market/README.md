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

索引只能由脚本生成，不要手写：

```sh
# 1. 先提交要发布的插件代码
git commit -am "Release my change"

# 2. 用该 commit 生成索引
pnpm run market:index -- --commit "$(git rev-parse HEAD)"

# 3. 提交索引
git add market/index.json && git commit -m "Update plugin index"
```

脚本从 `packages/agent-tree-canvas/package.json` 读取名称、版本、`engines.dsh` 和仓库地址，
从 `locale/en.json`、`locale/zh.json` 读取标题和描述，并校验 commit 是完整的 40 位 SHA。
`--timestamp` 可覆盖写入的发布时间，默认取当前时间。

## 限制

- `engines.dsh` 之外的 dsh 版本会在安装时被拒绝，需要发布新版本或使用 exact-version 豁免。
- 索引不提供图标：`icon` 字段省略时 dsh 使用面板默认图形。包本身也没有导出 `./icon`。
- 索引指向的 commit 一旦发布就应视为不可变；代码有变化时按上面的步骤重新生成索引。
