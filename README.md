# dsh-workspace-tidy

把工作区里生成的过程文件（脚本、临时文件、渲染残留）统一收进一个隐藏目录
`.dsh\`，保持工作区根目录干净。只移动、不删除，每次移动都写日志，可回滚。

## 工作方式

插件是 Host-only bundle，没有界面，安装后自动运行：

| 时机 | 触发事件 | 收什么 |
|---|---|---|
| 每轮回复结束 | `agent/turn-stopping` | 临时残留：`*.tmp`、`*.log`、`*.bak`、`*.orig`、`~$*`、`.dsh-*`、`.dsh-office-*` |
| 会话结束 | `session/disposed` | 上面全部 + 生成的脚本（`*.py`、`*.ps1`、`*.sh`、`*.bat`、`*.cmd`），脚本需静置 30 秒 |
| 会话创建 / 插件启动 / 每 10 分钟 | `session/created`、apply、interval | 上面全部；脚本只收 12 小时前的旧文件 |
| 任意时机 | 目录 | `__pycache__\`、`.pytest_cache\` 整目录移入 `.dsh\tmp\cache\` |

收纳位置：

```
.dsh\
├─ office\           .dsh-office-* 渲染残留
├─ tmp\              临时文件、日志、日志备份
│  ├─ scripts\       生成的脚本
│  └─ cache\         __pycache__ 等缓存目录
└─ tidy-log.jsonl    每次移动的 JSONL 记录
```

保护措施：

- 只处理 120 秒内没有写入的文件，正在写的文件不会被搬走。
- 根目录的目录不会被碰（`.dsh-office-*`、`__pycache__` 除外）。
- 符号链接跳过；`AGENTS.md`、`README.md`、`清理DSH临时文件.ps1`、`修复-DSH插件更新.ps1` 永不移动。
- 工作区是 git 仓库时，被 git 跟踪的文件（`git ls-files`）永不移动——生成脚本常被提交，误搬会破坏仓库状态。
- 单条移动失败（文件被占用、权限不足）只记录到日志的 `failed`，同轮其它条目继续处理。
- 跨盘移动（`EXDEV`）自动退化为复制后删除。
- 目标重名自动加 `-2`、`-3`，不覆盖已有文件。
- 默认 `dryRun: false`；改成 `true` 只记日志不落盘。

## 安装

从 npm 安装（推荐，预构建、无需 git 构建授权）：

```powershell
pnpm dsh plugin --profile <profile> add dsh-workspace-tidy
```

或从 GitHub 安装（跟随 main 最新提交）：

```powershell
pnpm dsh plugin --profile <profile> add github:dengwei84/dsh-workspace-tidy
```

也可以在 dshmarket 里搜索「工作区自动整理」——本插件已收录（2026-11-14），
详情页 <https://awesome-dsh-plugin.com/p/dengwei84/dsh-workspace-tidy/>。
npm 页面：<https://www.npmjs.com/package/dsh-workspace-tidy>。

本地开发时用目录安装（链接形式，改完 `index.js` 在插件管理里关再开一次即可生效）：

```powershell
# 或在会话里让代理调用 plugin_manager install_bundle，target 传包目录的绝对路径
pnpm dsh plugin --profile <profile> add "D:\AI\DeepSeek\_过程\04-脚本工具\dsh-workspace-tidy"
```

卸载：

```powershell
pnpm dsh plugin --profile <profile> remove dsh-workspace-tidy
```

## 验证

```powershell
node --test "D:\AI\DeepSeek\_过程\04-脚本工具\dsh-workspace-tidy\test\"
```

6 个用例覆盖：每轮只收临时残留并保护脚本与 keep 名单、会话结束只搬静置 30 秒以上的脚本、
git 跟踪的脚本不动、单条失败不影响其余条目、`maxEntries` 先筛候选再截断、`dryRun` 只记日志。
`test\verify.mjs` 是更早的手工冒烟脚本，保留作参考。

包内文件：

- `package.json`：`dsh.bundle.patch` 指向 `cordis.patch.yml`
- `cordis.patch.yml`：insert 一个 id 为 `workspace-tidy` 的 row
- `index.js`：插件本体
- `locale\{en,zh}.json`、`icon.svg`：插件列表里的名称、说明与图标

## 配置

在 profile 的 `cordis.patch.yml` 里给这个 row 加 `config`，或安装时由调用方传入：

```yaml
- insert:
    - id: workspace-tidy
      name: dsh-workspace-tidy
      config:
        target: .dsh
        minAgeSeconds: 120
        scriptMinAgeSeconds: 30
        scriptMinAgeHours: 12
        skipGitTracked: true
        intervalMinutes: 10
        dryRun: false
```

| 键 | 默认 | 说明 |
|---|---|---|
| `target` | `.dsh` | 收纳目录，相对工作区根目录 |
| `junkPatterns` | 见上表 | 每轮收的临时文件 glob |
| `officeDirs` | `.dsh-office-*` | 整目录收的渲染残留 |
| `cacheDirs` | `__pycache__`、`.pytest_cache` | 整目录收的缓存 |
| `scriptPatterns` | `.py/.ps1/.sh/.bat/.cmd` | 会话结束才收的脚本 glob |
| `keep` | `AGENTS.md`、`README.md`、`清理DSH临时文件.ps1`、`修复-DSH插件更新.ps1` | 永不移动的文件名 |
| `minAgeSeconds` | `120` | 文件至少静置多久才收 |
| `scriptMinAgeSeconds` | `30` | 会话结束时脚本至少静置多久才收 |
| `scriptMinAgeHours` | `12` | 启动扫描时脚本至少多旧才收 |
| `skipGitTracked` | `true` | 跳过 git 跟踪的文件 |
| `dryRun` | `false` | 只记录不移动 |
| `maxEntries` | `500` | 每轮最多处理的候选条目 |
| `intervalMinutes` | `10` | 活跃会话的周期扫描间隔，0 关闭 |

## 回滚

`.dsh\tidy-log.jsonl` 每行是一次移动：

```json
{"at":"2026-11-13T06:00:00.000Z","mode":"turn","root":"D:\\AI\\DeepSeek","dryRun":false,
 "moves":[{"from":"D:\\AI\\DeepSeek\\out.tmp","to":"D:\\AI\\DeepSeek\\.dsh\\tmp\\out.tmp"}],
 "failed":[]}
```

把所有 `to` 移回 `from` 即可恢复；某一行只想撤销一部分时按 `moves` 逐条处理。

```powershell
$lines = Get-Content ".dsh\tidy-log.jsonl" | ForEach-Object { $_ | ConvertFrom-Json }
foreach ($line in $lines) {
  foreach ($m in $line.moves) {
    if (Test-Path -LiteralPath $m.to) { Move-Item -LiteralPath $m.to -Destination $m.from -Force }
  }
}
```

## 边界

- 不删除任何文件；清理 `.dsh\` 由用户或收尾脚本决定。
- 不处理工作区外的路径；只扫描会话工作区根目录第一层。
- 与 Windows 计划任务 `DSH-DeepSeek-Process-Tidy` 作用重叠，安装插件后应
  `-Unregister` 该任务，避免两边同时搬同一批文件。

## 发布

想进 DSH 插件市场（dshmarket）看 [PUBLISH.md](PUBLISH.md)：市场没有上传入口，
收录方式是公开仓库 + 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)
提一个 `data/plugins/<owner>__<repo>.yml`（模板见 [market-entry.yml](market-entry.yml)）。

## License

MIT，见 [LICENSE](LICENSE)。
