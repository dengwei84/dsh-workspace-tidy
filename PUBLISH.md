# 发布到 DSH 插件市场（dshmarket）

市场里的插件目录来自社区仓库 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：
`https://awesome-dsh-plugin.com/plugins.json`，dshmarket 每次打开都会重新拉取。
**没有「上传安装包」的入口**——收录 = 向该仓库提一个 PR，合并后自动出现在市场的「发现/搜索」里。
市场界面右上角的「申请收录插件 ↗」就是这份 contributing.md。

## 状态：已上架（2026-11-15）

| 项 | 值 |
|---|---|
| PR | [#14979](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/pull/14979) — 已合并，2026-11-14 17:16 UTC（北京时间 2026-11-15 01:16） |
| 收录门槛 | 通过（提交时仓库不满 1 天，CI 自动重跑，2026-11-14 12:58 UTC 转绿） |
| 目录条目 | `data/plugins/dengwei84__dsh-workspace-tidy.yml`，category `tools`，added 2026-11-14 |
| 公开目录 | `https://awesome-dsh-plugin.com/plugins.json` 已含 `dsh-workspace-tidy` |
| 详情页 | <https://awesome-dsh-plugin.com/p/dengwei84/dsh-workspace-tidy/>（中文页在 `/zh/` 下） |
| npm | `dsh-workspace-tidy@0.1.1` 已发布（2026-11-15），<https://www.npmjs.com/package/dsh-workspace-tidy> |

后续维护：

- **发新版**：仓库推新提交即可；目录条目不写版本号，安装走默认分支最新提交。要固定版本用 `github:dengwei84/dsh-workspace-tidy#<sha>`。
- **发 npm 新版**：`npm publish`（版本号需先 bump）；发布后安装可用 `pnpm dsh plugin --profile <profile> add dsh-workspace-tidy`。
- **改展示信息**（描述/分类/图标）：再向 awesome-dsh-plugin 提一次 PR 修改对应 YAML，合并后生效；若要市场优先用 npm，可在 YAML 里补 `npm: dsh-workspace-tidy`。
- **本机更新**：`pnpm dsh plugin --profile desktop add dsh-workspace-tidy`（npm 版）或 `github:dengwei84/dsh-workspace-tidy`（跟随 main）。

### npm 首次发布的两个坑

- **0.0.0-stage 占位**：新包第一次 `npm publish` 后，registry 先出现 `0.0.0-stage`（"Temporary package placeholder for staged publishing"），真实版本要等平台处理完才出现。本次实测约 20 分钟，属于正常中间态，不是发错包；用 `npm view <name> versions --prefer-online` 观察。
- **2FA**：账号开了 2FA 时，`npm publish` 只接受「6 位验证码」或「勾选 Bypass 2FA 的 granular token」。普通 granular token 会报 `E403 ... granular access token with bypass 2fa enabled is required`。npm 计划 2027 年起停用 bypass 2FA 的直接发布，长期方案是 trusted publishing（OIDC）。

## 一、先决条件（缺一不可）

| 条件 | 说明 |
|---|---|
| 公开 GitHub 仓库 | 插件代码必须在公开仓库里；目录条目按仓库 URL 收录 |
| `dsh.bundle` 清单 | `package.json` 里 `dsh.bundle.patch` 指向 `cordis.patch.yml`（本插件已有） |
| 仓库创建满 1 天 | CI 自动检查，按天算；当天建的仓库会被挡 |
| `dsh-plugin` topic | 给仓库加上这个 GitHub topic |
| 真实可用代码 | 不能是占位/纯 README；描述必须与代码一致 |

## 二、步骤

### 1. 把插件放进公开仓库

本插件已建在 <https://github.com/dengwei84/dsh-workspace-tidy>（包名 `dsh-workspace-tidy`，
`package.json` 的 `repository` 已指回该仓库）。仓库根至少包含：

```
package.json        # 含 dsh.bundle + repository
cordis.patch.yml
index.js
locale/en.json  locale/zh.json  icon.svg
README.md
```

```powershell
cd <仓库目录>
git init
git add .
git commit -m "feat: workspace tidy bundle"
git remote add origin https://github.com/<owner>/<repo>.git
git push -u origin main
# 然后在 GitHub 仓库页 → About → Topics 加 dsh-plugin
```

### 2. 给 awesome-dsh-plugin 提 PR

新增一个文件：`data/plugins/<owner>__<repo>.yml`（一个插件一个文件，文件名用 `__` 连接）。
模板见同目录 `market-entry.yml`。只有 `description.en` 必填，`zh` 可选（不写维护者会补）。

### 3. 等 CI 与评审

CI 检查：每个 PR 最多 3 条、`dsh.bundle`、仓库年龄、awesome-lint 与站点构建。
通过后由维护者读代码核对描述，合并后网站与市场目录自动更新（通常一个构建周期内）。

### 4. 可选增强

- **npm 发布**：预构建安装免 `allowBuilds` 构建授权；`repository` 必须指回被收录的仓库。
- **GitHub Release tarball**：不发 npm 时，可加 `tarball:` 指向 `https://github.com/<owner>/<repo>/releases/latest/download/<name>.tgz`。
- **截图**：仓库根放 `screenshots.json`（1–8 张图片相对路径），市场详情页会展示。
- **图标**：条目 `icon:` 只收 GitHub 托管的位图（png/jpg/webp），SVG 不行；不写则用作者头像。

## 三、不想走 PR：自建「自定义插件索引」

DSH 内置的官方市场（实验性）允许用户自己添加索引源，**不需要任何人审核**，适合只给自己/团队用：

1. 插件页 →「实验性插件」→ 启用「自定义插件索引」→ 出现「发现」标签页。
2. 把下面的 JSON 放到任意 https 静态地址（GitHub Pages、Gist raw、内网静态服务器）。
3. 「发现」→ 添加索引源 → 填该 URL。

`index.json`（format 1，最小可用）：

```json
{
  "format": 1,
  "title": "我的插件",
  "metadata": {
    "categories": { "tools": { "title": { "en": "Tools", "zh": "工具" } } }
  },
  "plugins": [
    {
      "name": "dsh-workspace-tidy",
      "title": { "en": "Workspace Tidy", "zh": "工作区自动整理" },
      "description": {
        "en": "Moves stray temp files, render output and generated scripts from the workspace root into a .dsh folder.",
        "zh": "工作区自动整理插件：把根目录的临时文件、渲染产物和脚本收进 .dsh 目录，让工作区保持整洁。"
      },
      "author": "<你的名字>",
      "homepage": "https://github.com/<owner>/<repo>",
      "repository": { "url": "https://github.com/<owner>/<repo>" },
      "metadata": { "category": "tools", "keywords": ["workspace", "tidy", "temp"] },
      "versions": [
        {
          "version": "0.1.0",
          "publishTimestamp": 1762992000,
          "source": {
            "type": "git",
            "url": "https://github.com/<owner>/<repo>",
            "commit": "<40 位小写 commit SHA>"
          },
          "engines": { "dsh": ">=0.2.0-0 <0.3.0" }
        }
      ]
    }
  ]
}
```

`source` 也可用 npm：`{ "type": "npm" }`（可带 `registry`）。
索引校验器在 `@deepseek-ai/dsh-plugin-market-index`，字段约束：`format` 必须为 1；
`versions` 非空且版本号是精确 SemVer；`publishTimestamp` 是 Unix 秒；git `commit` 必须是 40 位小写 SHA；
`icon` 相对路径只能解析到索引同源或 https。

## 四、市场展示文案

zh：**工作区自动整理插件：把根目录的临时文件、渲染产物和脚本收进 `.dsh` 目录，让工作区保持整洁。**
en：**Keeps the workspace tidy by moving stray temp files, render output and generated scripts into a hidden `.dsh` folder.**

## 五、安装（对使用者）

- 市场里搜到后点安装即可；安装目标由目录 URL 解析。
- 从 npm 装（推荐）：`pnpm dsh plugin --profile <profile> add dsh-workspace-tidy`
- 从 GitHub 装同一份代码：`pnpm dsh plugin --profile <profile> add github:dengwei84/dsh-workspace-tidy`
- 本地目录安装（开发用）：`plugin_manager` 的 `install_bundle`，target 为包目录绝对路径。
