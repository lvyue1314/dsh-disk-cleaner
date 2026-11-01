# dsh-local-apps

A plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) that lets the agent drive
software already installed on the machine — **WizTree** first of all — and turn the result into
structured data it can reason about.

Windows only · Node >= 22 · DSH >= 0.2.1-rc.5 · MIT

---

## Why this plugin exists

On Windows the harness runs shell tools inside a sandbox, and on a typical desktop that means
**every child process fails with `0xC0000142` (STATUS_DLL_INIT_FAILED)** — `pwsh` and `bash` cannot
start `WizTree.exe`, `reg.exe` or an uninstaller at all.

Plugin host code runs inside the harness process instead, outside that sandbox. That is the whole
reason this is a plugin and not a shell script: it is the supported way to reach local software.

## Tools

| Tool | What it does |
| --- | --- |
| `wiztree_scan` | Runs `WizTree64.exe` in headless export mode, parses the CSV and returns the biggest folders, biggest files and known cache directories. A 200 GB drive with 1.8 M entries scans in ~45 s. |
| `local_apps_run` | Runs any local executable by absolute path, returns exit code, stdout, stderr and duration, bounded by a timeout. |
| `local_apps_list` | Reads the Uninstall registry keys (HKLM, WOW6432Node, HKCU) and returns name, version, publisher, install location and size. |
| `disk_free` | Per-volume capacity and free space. |
| `system_cleanup` | Whitelisted junk cleanup: update cache, WER reports, CBS logs, temp files, browser caches, recycle bin, WinSxS. **Dry-run by default**; deleting requires `confirm: true`. |
| `disk_migrate` | Moves a folder to another volume and leaves a directory junction behind, so the original path keeps working. Copies first, verifies size, deletes the source only afterwards. **Dry-run by default**. |

## Install

The plugin is a Cordis bundle: a package with a `dsh.bundle.patch` that inserts one plugin row.

```bash
# from your DSH profile directory
pnpm add link:/path/to/dsh-local-apps
```

Then either add it to the profile `package.json`:

```json
{
  "dependencies": { "dsh-local-apps": "link:/path/to/dsh-local-apps" },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-local-apps"]
    }
  }
}
```

or insert the row directly in the profile `cordis.patch.yml`:

```yaml
- insert:
    - id: dsh-local-apps
      name: dsh-local-apps
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
| `DSH_LOCAL_APPS_TMP` | Scratch directory for WizTree CSV exports. Defaults to `%TEMP%`, falling back to the volume with the most free space when the system drive is nearly full. |

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

## License

MIT
