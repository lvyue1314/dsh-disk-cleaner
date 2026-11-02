# dsh-disk-cleaner

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4176E6.svg)](https://github.com/deepseek-ai/deepseek-harness)

**中文** | [English](#english)

给塞满的 Windows 系统盘腾空间：**定位 → 判断 → 清理 → 搬迁**，全程不动你的个人文件。

Windows · Node >= 22 · DSH >= 0.2.1-rc.5 · MIT

---

## 它解决什么问题

C 盘爆满时，真正占地方的往往不是文档，而是几类"可再生"的东西：Windows 更新下载缓存、临时文件、IDE 索引、
浏览器缓存、各种会话快照；另一大类则是**装错盘**的软件和缓存目录。

这个插件把这件事拆成四步，每步一个工具：

```text
1. 定位   wiztree_scan / disk_free      到底是谁在占空间
2. 判断   local_apps_list               装了什么、装在哪、多大
3. 清理   system_cleanup                可再生垃圾，默认 dry-run 先量
4. 搬迁   disk_migrate                  大目录搬到别的盘，原地留目录联接
5. 兜底   local_apps_run                界面上没覆盖的操作，比如调卸载器
```

### 为什么必须做成插件

Windows 上 DSH 的 `pwsh` / `bash` 跑在沙箱里，**任何子进程都会以 `0xC0000142`
（STATUS_DLL_INIT_FAILED）失败**——调不动 `WizTree.exe`、`robocopy`、`mklink`、卸载器。
插件代码运行在宿主进程内、沙箱之外，这是唯一受支持的方式。

---

## 前置：安装 WizTree

`wiztree_scan` 依赖本机的 [WizTree](https://www.diskanalyzer.com/)（免费，MFT 直读，比资源管理器快几个数量级）。
另外 5 个工具不依赖它，不装也能用。

| 方式 | 命令 / 地址 |
| --- | --- |
| 官网下载（推荐） | <https://www.diskanalyzer.com/download> |
| winget | `winget install AntibodySoftware.WizTree` |
| 便携版 | 官网下载页提供 portable 压缩包，解压即用，无需安装 |

安装后默认位置是 `C:\Program Files\WizTree\WizTree64.exe`；装在别的盘也没关系，插件会自动找。

**插件如何定位 WizTree**（按顺序尝试）：

1. 环境变量 `DSH_WIZTREE` 指向的绝对路径
2. 系统 `PATH` 里的 `WizTree64.exe` / `WizTree.exe`
3. WizTree 安装时写入的注册表项（Inno Setup 的 `InstallLocation`）
4. 各盘的 `Program Files\WizTree`、`Program Files (x86)\WizTree`、`Tools\WizTree`

都找不到时，`wiztree_scan` 会明确报错提示设置 `DSH_WIZTREE`，不会静默失败。

> `wiztree_scan` 调的是**无界面导出模式**，不需要你手动点界面。WizTree 只有拿到管理员权限才能用 MFT
> 直读整卷：插件以 DSH 进程的权限调用它——DSH 以管理员身份运行就走 MFT 快通道，否则退化为普通遍历
> （照样能扫，只是慢一些）。在界面里勾"以管理员身份运行"只影响 GUI 自身，不影响插件。

---

## 六个工具

| 工具 | 作用 |
| --- | --- |
| `wiztree_scan` | 调 WizTree 无界面导出 CSV 再解析，返回最大目录、最大文件和常见缓存体积；数百万条目的系统盘通常一分钟内完成 |
| `disk_free` | 各卷总容量与可用空间 |
| `system_cleanup` | 白名单清理：更新缓存 / WER 错误报告 / CBS 日志 / 临时文件 / 浏览器缓存 / 回收站 / WinSxS。**默认 dry-run 只统计**，执行需 `confirm: true` |
| `disk_migrate` | 把目录搬到另一个卷并在原地留目录联接（junction），程序无需改动。**默认 dry-run**；先复制、校验体积、再删源 |
| `local_apps_list` | 读注册表 Uninstall 项，列出已装软件、版本、发布者、安装路径与占用 |
| `local_apps_run` | 用绝对路径启动任意本地程序并回收退出码 / stdout / stderr / 耗时 |

---

## 安装插件

插件是一个 Cordis bundle：包内 `cordis.patch.yml` 负责插入一行插件配置。

```bash
cd <你的 DSH profile 目录>
pnpm add link:/path/to/dsh-disk-cleaner
```

二选一挂载：

**A. 写进 profile 的 `package.json`**

```json
{
  "dependencies": { "dsh-disk-cleaner": "link:/path/to/dsh-disk-cleaner" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-disk-cleaner"]
    }
  }
}
```

**B. 直接写进 profile 的 `cordis.patch.yml`**

```yaml
- insert:
    - id: dsh-disk-cleaner
      name: dsh-disk-cleaner
```

profile 若配置了 `patchReload: live`，下一次模型调用就能看到工具；否则重启 DSH。

---

## 配置

| 环境变量 | 说明 |
| --- | --- |
| `DSH_WIZTREE` | `WizTree64.exe` 的绝对路径。可选，不设就走上面的自动查找 |
| `DSH_DISK_CLEANER_TMP` | 扫描导出 CSV 的临时目录。默认 `%TEMP%`；系统盘快满时会自动改用空闲最大的卷 |

---

## 用法

```text
# 1. 看看谁在占空间
wiztree_scan({ target: "C:\\", depth: 2, top: 30 })

# 2. 先量一下能清多少（不会删任何东西）
system_cleanup({ dryRun: true })

# 3. 确认清单里都是缓存后，再真正执行
system_cleanup({ dryRun: false, confirm: true, items: ["user-temp", "update-cache"] })

# 4. 把大目录搬到别的盘，原地留联接
disk_migrate({ source: "C:\\Users\\me\\.m2", target: "D:\\moved\\m2", dryRun: true })
```

> **把 TEMP 迁到别的盘时，目标路径一定要用纯英文**（例如 `E:\Temp`）。conda 等工具的批处理激活脚本
> 处理不了含中文的 TEMP，`conda activate` 会直接报"系统找不到指定的路径"，而 `conda env list` 却一切正常——
> 这个坑排查起来很费时间。插件自己的 `DSH_DISK_CLEANER_TMP` 不受影响，但系统级 TEMP 要遵守这条。

常见可搬的目标：`.m2`、`.gradle`、`.nuget`、`.vscode`（扩展）、`%LOCALAPPDATA%\JetBrains`、
`%APPDATA%\Code`、`pnpm` / `npm-cache`、Docker 数据目录等**可重建的缓存**。

不建议直接搬：已安装程序的本体目录（会破坏卸载器与注册表记录），这类只能卸载后重装到目标盘。

---

## 安全设计

- 破坏性工具**默认 dry-run**，必须显式 `confirm: true` 才动手
- `disk_migrate` 在校验体积达标前绝不删除源目录；复制失败会保留源并报告原因，不留"搬了一半"的目录
- `system_cleanup` 只碰固定白名单，不遍历个人文档、聊天记录、已安装程序
- `local_apps_run` 拒绝相对路径，且要求文件真实存在

---

## 开发提示：改代码怎么生效

ESM 每个进程只有一份模块实例，改完 `lib/index.js` 再重载 profile，拿到的仍是**旧代码**。
`lib/entry.js` 就是为此存在：

```js
export * from './index.js?v=3'   // 每次改完递增版本号
```

把插件行指向 `entry.js` 而不是 `index.js`，重载时就会 import 一个新模块。
（实测：改 `config` 只会重建 fiber、复用缓存模块；必须换 specifier 才真正重新加载。）

---

## 配套脚本

`examples/` 里有两个实际用过的 PowerShell 脚本：

- `migrate-to-e.ps1` —— 批量迁移目录并建联接（`-DryRun`、`-Only`）
- `monthly-cleanup.ps1` —— 给计划任务用的无人值守清理，写小报告；S4U 任务（不加载用户配置文件）下也能跑

---

<a id="english"></a>

## English

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that frees space on a
full Windows system drive: find what is eating it, delete what is regenerable, and move what can live
on another volume — without touching a single user document.

On Windows the sandboxed shell tools cannot start child processes (`0xC0000142`), so calling
`WizTree.exe`, `robocopy` or `mklink` requires a plugin: host code runs in the harness process,
outside the sandbox.

### Prerequisite: WizTree

`wiztree_scan` needs [WizTree](https://www.diskanalyzer.com/) (free, MFT-based). The other five tools
work without it.

| Option | How |
| --- | --- |
| Official download (recommended) | <https://www.diskanalyzer.com/download> |
| winget | `winget install AntibodySoftware.WizTree` |
| Portable | portable archive on the download page, no install needed |

The plugin looks for it in this order: `DSH_WIZTREE` → `PATH` → WizTree's Inno Setup registry key →
`Program Files\WizTree` on each fixed drive. If nothing is found, `wiztree_scan` says so instead of
silently returning nothing.

### Tools

| Tool | What it does |
| --- | --- |
| `wiztree_scan` | headless WizTree export + CSV parsing: biggest folders, files and caches |
| `disk_free` | per-volume capacity and free space |
| `system_cleanup` | whitelisted junk cleanup, **dry-run by default**, needs `confirm: true` |
| `disk_migrate` | move a folder to another volume, junction behind, **dry-run by default** |
| `local_apps_list` | installed applications from the Uninstall registry keys |
| `local_apps_run` | run any executable by absolute path with bounded output and timeout |

### Install

```bash
cd <your DSH profile directory>
pnpm add link:/path/to/dsh-disk-cleaner
```

```yaml
- insert:
    - id: dsh-disk-cleaner
      name: dsh-disk-cleaner
```

### Configuration

| Variable | Meaning |
| --- | --- |
| `DSH_WIZTREE` | absolute path to `WizTree64.exe` (optional) |
| `DSH_DISK_CLEANER_TMP` | scratch dir for scan exports; defaults to `%TEMP%`, falls back to the emptiest volume |

### Safety

Destructive tools are dry-run by default and require `confirm: true`; `disk_migrate` never deletes the
source before the copy is verified; `system_cleanup` only touches a fixed whitelist of regenerable paths.

---

## License

MIT
