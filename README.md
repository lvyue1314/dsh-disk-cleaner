# dsh-disk-cleaner

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#)
[![DeepSeek Harness](https://img.shields.io/badge/DeepSeek%20Harness-plugin-4176E6.svg)](https://github.com/deepseek-ai/deepseek-harness)

**English** | [中文](#中文说明)

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that frees space on a
full Windows system drive: find what is eating it, delete what is regenerable, and move what can live
on another volume — without touching a single user document.

```
1. find     wiztree_scan / disk_free      what is eating the drive
2. judge    local_apps_list               what is installed, where, how big
3. delete   system_cleanup                regenerable junk, dry-run first
4. move     disk_migrate                  big folders to another volume, junction behind
5. escape   local_apps_run                anything else, e.g. an uninstaller
```

Windows only · Node >= 22 · DSH >= 0.2.1-rc.5 · MIT

---

## Why this is a plugin

On Windows the harness runs shell tools inside a sandbox, and on a typical desktop that means
**every child process fails with `0xC0000142` (STATUS_DLL_INIT_FAILED)** — `pwsh` and `bash` cannot
start `WizTree.exe`, `robocopy`, `mklink` or an uninstaller at all.

Plugin host code runs inside the harness process instead, outside that sandbox. That is the whole
reason this is a plugin: it is the supported way to reach the tools a disk cleanup needs.

## Tools

| Tool | What it does |
| --- | --- |
| `wiztree_scan` | Runs `WizTree64.exe` in headless export mode, parses the CSV and returns the biggest folders, biggest files and known cache directories. A full system drive with millions of entries scans in about a minute. |
| `local_apps_run` | Runs any local executable by absolute path, returns exit code, stdout, stderr and duration, bounded by a timeout. |
| `local_apps_list` | Reads the Uninstall registry keys (HKLM, WOW6432Node, HKCU) and returns name, version, publisher, install location and size. |
| `disk_free` | Per-volume capacity and free space. |
| `system_cleanup` | Whitelisted junk cleanup: update cache, WER reports, CBS logs, temp files, browser caches, recycle bin, WinSxS. **Dry-run by default**; deleting requires `confirm: true`. |
| `disk_migrate` | Moves a folder to another volume and leaves a directory junction behind, so the original path keeps working. Copies first, verifies size, deletes the source only afterwards. **Dry-run by default**. |

## Install

The plugin is a Cordis bundle: a package with a `dsh.bundle.patch` that inserts one plugin row.

```bash
# from your DSH profile directory
pnpm add link:/path/to/dsh-disk-cleaner
```

Then either add it to the profile `package.json`:

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

or insert the row directly in the profile `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-disk-cleaner
      name: dsh-disk-cleaner
```

With `patchReload: live` in the profile manifest the tools appear on the next model call; otherwise
restart the application.

### Hot reload while developing

ESM keeps one module instance per process, so editing `lib/index.js` and reloading the profile still
gives you the **old** code. `lib/entry.js` solves that:

```js
export * from './index.js?v=3'   // bump the version on every change
```

Point the loader row at `entry.js` instead of `index.js` and a profile reload imports a fresh module.

## Configuration

| Variable | Meaning |
| --- | --- |
| `DSH_WIZTREE` | Absolute path to `WizTree64.exe`. Optional — the plugin also looks it up on `PATH`, in the Inno Setup registry key and under `Program Files\WizTree`. |
| `DSH_DISK_CLEANER_TMP` | Scratch directory for WizTree CSV exports. Defaults to `%TEMP%`, falling back to the volume with the most free space when the system drive is nearly full. |

## Usage

```text
wiztree_scan({ target: "C:\\", depth: 2, top: 30 })
system_cleanup({ dryRun: true })                                    # measure first
system_cleanup({ dryRun: false, confirm: true, items: ["user-temp", "update-cache"] })
disk_migrate({ source: "C:\\Users\\me\\.m2", target: "D:\\moved\\m2", dryRun: true })
```

`wiztree_scan` returns bytes, folder paths and a junk summary; `disk_migrate` returns whether the
junction was created and the reason when it was not.

## Safety model

- Destructive tools are **dry-run by default** and require `confirm: true`.
- `disk_migrate` never deletes the source before the copy is verified by size, and reports the error
  instead of leaving a half-moved folder.
- `system_cleanup` only touches a fixed whitelist of regenerable locations. It never walks user
  documents, chat history or installed programs.
- `local_apps_run` refuses relative paths and requires the file to exist.

## Examples

`examples/` ships two PowerShell scripts used in practice:

- `migrate-to-e.ps1` — batch folder migration with junctions (`-DryRun`, `-Only`).
- `monthly-cleanup.ps1` — unattended cleanup for a scheduled task; writes a small report and runs
  fine as an S4U task without a loaded user profile.

---

<a id="中文说明"></a>

## 中文说明

**给塞满的 Windows 系统盘腾空间**：定位、清理、搬迁三步走。

在 Windows 上，DSH 的 `pwsh` / `bash` 工具跑在沙箱里，**任何子进程都会以 `0xC0000142`
（STATUS_DLL_INIT_FAILED）失败**，调不动 `WizTree.exe`、`reg.exe` 或卸载器。插件代码运行在宿主进程内、
沙箱之外——这正是磁盘清理这类活必须做成插件的原因。

### 六个工具

| 工具 | 作用 |
| --- | --- |
| `wiztree_scan` | 调 WizTree 无界面导出 CSV 再解析，返回最大目录、最大文件和常见缓存体积；数百万条目的系统盘通常一分钟内完成 |
| `local_apps_run` | 用绝对路径启动任意程序，回收退出码、stdout、stderr 和耗时 |
| `local_apps_list` | 读注册表 Uninstall 项，列出已安装软件、版本、发布者、安装路径与大小 |
| `disk_free` | 各卷总容量与可用空间 |
| `system_cleanup` | 白名单清理（更新缓存 / WER / CBS 日志 / 临时文件 / 浏览器缓存 / 回收站 / WinSxS），**默认 dry-run**，执行需 `confirm: true` |
| `disk_migrate` | 把目录搬到另一个卷并留下目录联接（junction），**默认 dry-run**；先复制、校验体积、再删源 |

### 安装

```bash
cd <你的 DSH profile 目录>
pnpm add link:/path/to/dsh-disk-cleaner
```

在 profile 的 `cordis.patch.yml` 里插入一行：

```yaml
- insert:
    - id: dsh-disk-cleaner
      name: dsh-disk-cleaner
```

profile 若是 `patchReload: live`，下一次模型调用就能看到工具；否则重启应用。

> 开发时改 `lib/index.js` 不会生效——ESM 每进程只有一份模块实例。把入口指向 `lib/entry.js`
> 并递增里面的 `?v=N`，重载时才会 import 新模块。

### 配置

| 环境变量 | 说明 |
| --- | --- |
| `DSH_WIZTREE` | `WizTree64.exe` 的绝对路径（可选：也会查 PATH、Inno Setup 注册表键、`Program Files\\WizTree`） |
| `DSH_DISK_CLEANER_TMP` | 扫描 CSV 的临时目录；默认 `%TEMP%`，系统盘快满时自动改用空闲最大的卷 |

### 用法

```text
wiztree_scan({ target: "C:\\", depth: 2, top: 30 })
system_cleanup({ dryRun: true })                     # 先量，不动手
system_cleanup({ dryRun: false, confirm: true, items: ["user-temp", "update-cache"] })
disk_migrate({ source: "C:\\Users\\me\\.m2", target: "D:\\moved\\m2", dryRun: true })
```

### 安全设计

破坏性工具默认 dry-run，必须显式 `confirm: true`；`disk_migrate` 在校验体积前绝不删除源目录，
失败会报告原因而不是留个搬了一半的目录；`system_cleanup` 只碰固定白名单，不遍历个人文档或聊天记录。

## License

MIT
