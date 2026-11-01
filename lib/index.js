/**
 * dsh-local-apps — host half of a DSH plugin that lets an agent drive local
 * software on this machine (WizTree first, then arbitrary executables).
 *
 * Tools:
 *   wiztree_scan    run WizTree64.exe in headless export mode, parse the CSV and
 *                   summarize the biggest folders / files / caches.
 *   local_apps_run  run any local executable with explicit argv and a timeout.
 *   local_apps_list installed applications from the Uninstall registry keys.
 *   disk_free       per-volume capacity and free space.
 *
 * Why a plugin: the sandboxed pwsh/bash tools cannot start child processes on
 * this host, while host plugin code runs in the harness process itself.
 *
 * Verification route: GET /dsh-local-apps/state
 */
import { execFileSync, spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import readline from 'node:readline'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-local-apps'
export const inject = ['tools']

const VERSION = '0.1.0'
const GB = 1024 ** 3
const MAX_SCAN_MS = 15 * 60 * 1000

const state = { version: VERSION, wizTree: null, lastScan: null, lastRun: null }

/* ------------------------------------------------------------------ helpers */

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?'
  if (bytes >= GB) return (bytes / GB).toFixed(2) + ' GB'
  if (bytes >= 1024 ** 2) return (bytes / 1024 ** 2).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return bytes + ' B'
}

/** Scratch directory: honour DSH_LOCAL_APPS_TMP, else the temp volume when it has
 * room, else the volume with the most free space (a full system drive must never
 * be the place where a 300 MB scan export lands). */
function tempDir() {
  const freeOf = (root) => {
    try {
      const raw = statfsSync(root)
      return raw.bavail * raw.bsize
    } catch {
      return -1
    }
  }
  const candidates = []
  if (process.env.DSH_LOCAL_APPS_TMP) candidates.push(process.env.DSH_LOCAL_APPS_TMP)
  candidates.push(path.join(os.tmpdir(), 'dsh-local-apps'))
  const volumes = []
  for (const letter of 'CDEFGH') {
    const root = letter + ':\\'
    const free = freeOf(root)
    if (free > 0) volumes.push({ root, free })
  }
  volumes.sort((a, b) => b.free - a.free)
  for (const volume of volumes) candidates.push(path.join(volume.root, 'dsh-local-apps-scratch'))
  let chosen = candidates[0]
  for (const candidate of candidates) {
    const root = path.parse(candidate).root
    if (freeOf(root) >= 20 * GB) { chosen = candidate; break }
  }
  try {
    mkdirSync(chosen, { recursive: true })
    return chosen
  } catch {
    mkdirSync(path.join(os.tmpdir(), 'dsh-local-apps'), { recursive: true })
    return path.join(os.tmpdir(), 'dsh-local-apps')
  }
}

/** Run a process, collect bounded output and resolve on exit or timeout. */
function runProcess(argv, { cwd, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const started = Date.now()
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ exitCode: null, stdout: '', stderr: String(error), durationMs: 0, spawnError: String(error) })
      return
    }
    let stdout = ''
    let stderr = ''
    let settled = false
    const cap = 4 * 1024 * 1024
    const finish = (exitCode, extra = {}) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started, ...extra })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch {}
      finish(null, { timedOut: true })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { if (stdout.length < cap) stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { if (stderr.length < cap) stderr += chunk.toString('utf8') })
    child.on('error', (error) => finish(null, { spawnError: String(error) }))
    child.on('exit', (code) => finish(code ?? -1))
  })
}

/** Install locations recorded by WizTree's Inno Setup uninstaller. */
function wizTreeRegistryDirs() {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WizTree_is1',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WizTree_is1',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\WizTree_is1',
  ]
  const found = []
  for (const key of keys) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'InstallLocation'], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      const match = /InstallLocation\s+REG_\w+\s+(.+)/.exec(out)
      if (match) found.push(match[1].trim())
    } catch {}
  }
  return found
}

/** Locate WizTree64.exe: explicit setting, PATH, registry, then the usual folders. */
function findWizTree(explicit) {
  const usable = (candidate) => {
    try { return Boolean(candidate) && existsSync(candidate) } catch { return false }
  }
  if (usable(explicit)) return explicit

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue
    for (const name of ['WizTree64.exe', 'WizTree.exe']) {
      const candidate = path.join(dir, name)
      if (usable(candidate)) return candidate
    }
  }

  for (const dir of wizTreeRegistryDirs()) {
    for (const name of ['WizTree64.exe', 'WizTree.exe']) {
      const candidate = path.join(dir, name)
      if (usable(candidate)) return candidate
    }
  }

  // Portable copies: the default install folder under any fixed drive.
  for (const drive of ['C', 'D', 'E', 'F']) {
    for (const base of ['Program Files', 'Program Files (x86)', 'Tools']) {
      for (const name of ['WizTree64.exe', 'WizTree.exe']) {
        const candidate = path.join(drive + ':\\', base, 'WizTree', name)
        if (usable(candidate)) return candidate
      }
    }
  }
  return null
}

/** Installed applications from the three Uninstall registry views. */
async function installedApps() {
  const keys = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const apps = []
  for (const key of keys) {
    const result = await runProcess(['reg.exe', 'query', key, '/s'], { timeoutMs: 90000 })
    if (!result.stdout) continue
    let current = null
    for (const rawLine of result.stdout.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (line.startsWith('HKEY_')) {
        if (current?.DisplayName) apps.push(current)
        current = {}
        continue
      }
      const match = /^(DisplayName|DisplayVersion|InstallLocation|EstimatedSize|Publisher)\s+REG_\w+\s+(.*)$/.exec(line)
      if (!match || !current) continue
      if (match[1] === 'EstimatedSize') current.estimatedKb = Number(match[2])
      else current[match[1]] = match[2].trim()
    }
    if (current?.DisplayName) apps.push(current)
  }
  return apps
    .filter((app) => app.DisplayName)
    .map((app) => ({
      name: app.DisplayName,
      version: app.DisplayVersion || '',
      publisher: app.Publisher || '',
      installLocation: app.InstallLocation || '',
      sizeMB: Number.isFinite(app.estimatedKb) ? Math.round(app.estimatedKb / 1024) : null,
    }))
    .sort((a, b) => (b.sizeMB ?? 0) - (a.sizeMB ?? 0))
}

/** Run WizTree in export mode and wait until the CSV stops growing. */
async function wizTreeExport(exe, target, csvPath) {
  try { unlinkSync(csvPath) } catch {}
  const child = spawn(exe, [target, '/export=' + csvPath], { windowsHide: true, stdio: 'ignore' })
  let exited = null
  child.on('exit', (code) => { exited = code ?? -1 })
  child.on('error', () => { exited = -2 })

  const started = Date.now()
  let lastSize = -1
  let stableSince = Date.now()
  let size = 0
  while (Date.now() - started < MAX_SCAN_MS) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    try { size = statSync(csvPath).size } catch { size = 0 }
    if (size !== lastSize) { lastSize = size; stableSince = Date.now() }
    if (exited !== null && size > 0) break
    if (size > 1024 * 1024 && Date.now() - stableSince > 20000) break
  }
  if (exited === null) {
    try { child.kill('SIGKILL') } catch {}
    await runProcess(['taskkill.exe', '/PID', String(child.pid), '/T', '/F'], { timeoutMs: 20000 })
  }
  if (!size) throw new Error('WizTree 没有生成导出文件：' + csvPath)
  return { csvPath, elapsedMs: Date.now() - started, bytes: size }
}

/** Stream-parse a WizTree CSV export. */
async function parseWizTreeCsv(csvPath, { target = '', depth = 3, top = 25, junk = [] } = {}) {
  const targetKey = target.replace(/[\\/]+$/, '')
  const baseDepth = targetKey.split('\\').filter(Boolean).length
  const dirs = new Map()
  let files = []
  let total = 0
  let free = 0
  let rowCount = 0

  const rl = readline.createInterface({ input: createReadStream(csvPath, { encoding: 'utf8' }), crlfDelay: Infinity })
  let headerSeen = false
  for await (const line of rl) {
    if (!headerSeen) {
      if (line.includes('DRIVECAPACITY')) headerSeen = true
      continue
    }
    if (line.charCodeAt(0) !== 34) continue
    const close = line.indexOf('",')
    if (close < 0) continue
    const filePath = line.slice(1, close)
    const rest = line.slice(close + 2)
    const bytes = Number(rest.slice(0, rest.indexOf(',')))
    if (!Number.isFinite(bytes)) continue
    rowCount++
    if (filePath.endsWith('\\')) {
      const key = filePath.slice(0, -1)
      if (key === targetKey || (baseDepth === 1 && key.split('\\').filter(Boolean).length === 1)) {
        total = Math.max(total, bytes)
        const maybeFree = Number(rest.split(',')[7]) // path,size,alloc,mtime,attr,files,folders,capacity,free,used,reserved
        if (Number.isFinite(maybeFree)) free = Math.max(free, maybeFree)
      }
      if (bytes > (dirs.get(key) ?? -1)) dirs.set(key, bytes)
    } else if (bytes > 0) {
      files.push({ path: filePath, bytes })
      if (files.length > 4000) {
        files.sort((a, b) => b.bytes - a.bytes)
        files.length = 2000
      }
    }
  }
  files.sort((a, b) => b.bytes - a.bytes)

  const topDirectories = [...dirs.entries()]
    .filter(([key]) => key.split('\\').filter(Boolean).length - baseDepth <= depth)
    .map(([key, bytes]) => ({ path: key, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, top)

  const junkFound = []
  for (const entry of junk) {
    const hit = dirs.get(entry.path.replace(/[\\/]+$/, ''))
    if (hit) junkFound.push({ label: entry.label, path: entry.path, bytes: hit })
  }
  junkFound.sort((a, b) => b.bytes - a.bytes)

  return {
    totalBytes: total,
    freeBytes: free,
    rowCount,
    topDirectories,
    topFiles: files.slice(0, top).map((file) => ({ path: file.path, bytes: file.bytes })),
    junk: junkFound,
  }
}

function junkCandidates() {
  const local = process.env.LOCALAPPDATA || 'C:\\Users\\Default\\AppData\\Local'
  const roaming = process.env.APPDATA || 'C:\\Users\\Default\\AppData\\Roaming'
  const profile = process.env.USERPROFILE || 'C:\\Users\\Default'
  return [
    { path: path.join(local, 'Temp'), label: '用户临时文件 Temp' },
    { path: 'C:\\Windows\\Temp', label: '系统临时文件 Windows\\Temp' },
    { path: 'C:\\Windows\\SoftwareDistribution\\Download', label: 'Windows 更新缓存' },
    { path: 'C:\\Windows\\Installer', label: 'Windows Installer 缓存' },
    { path: 'C:\\Windows\\Prefetch', label: 'Prefetch' },
    { path: 'C:\\Windows\\Logs', label: '系统日志' },
    { path: 'C:\\$Recycle.Bin', label: '回收站' },
    { path: 'C:\\ProgramData\\Package Cache', label: '安装包缓存' },
    { path: path.join(local, 'CrashDumps'), label: '崩溃转储' },
    { path: path.join(local, 'pnpm-cache'), label: 'pnpm 缓存' },
    { path: path.join(local, 'npm-cache'), label: 'npm 缓存' },
    { path: path.join(local, 'pip', 'cache'), label: 'pip 缓存' },
    { path: path.join(profile, '.gradle'), label: 'Gradle 缓存' },
    { path: path.join(profile, '.m2'), label: 'Maven 本地仓库' },
    { path: path.join(profile, '.nuget'), label: 'NuGet 缓存' },
    { path: path.join(profile, '.conda'), label: 'conda 缓存' },
    { path: path.join(profile, '.cargo'), label: 'Cargo 缓存' },
    { path: path.join(roaming, 'Code', 'Cache'), label: 'VS Code 缓存' },
  ]
}

function textRender(value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
}

const OBJECT_OUTPUT = { schema: { type: 'object' }, render: (_args, value) => textRender(value) }

/* -------------------------------------------------------------------- tools */

const wiztreeScan = {
  name: 'wiztree_scan',
  description:
    '用本机 WizTree（MFT 扫描，200GB 盘约 40-60 秒）扫描某个磁盘或目录，返回最大目录、最大文件和常见垃圾缓存体积。',
  parameters: {
    type: 'object',
    properties: {
      target: { type: 'string', description: '扫描根路径，默认 C:\\' },
      depth: { type: 'integer', description: '汇总目录层数，默认 3' },
      top: { type: 'integer', description: '返回目录/文件条数，默认 25' },
    },
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object' },
    render(_args, value) {
      const lines = [
        '扫描 ' + value.target + '：共 ' + fmtBytes(value.totalBytes) + '，剩余 ' + fmtBytes(value.freeBytes) +
          '（耗时 ' + Math.round(value.elapsedMs / 1000) + 's）',
        '',
        '== 最大目录 ==',
        ...value.topDirectories.slice(0, 20).map((entry) => fmtBytes(entry.bytes).padStart(10) + '  ' + entry.path),
        '',
        '== 最大文件 ==',
        ...value.topFiles.slice(0, 15).map((entry) => fmtBytes(entry.bytes).padStart(10) + '  ' + entry.path),
      ]
      if (value.junk?.length) {
        lines.push('', '== 可清理缓存 ==')
        for (const entry of value.junk.slice(0, 12)) lines.push(fmtBytes(entry.bytes).padStart(10) + '  ' + entry.label + '  ' + entry.path)
      }
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args, exec) {
    const target = (args.target || 'C:\\').trim()
    const depth = Math.max(1, Math.min(6, args.depth ?? 3))
    const top = Math.max(5, Math.min(200, args.top ?? 25))
    const exe = state.wizTree || findWizTree(process.env.DSH_WIZTREE)
    if (!exe) throw new Error('未找到 WizTree64.exe，请设置环境变量 DSH_WIZTREE 指向它')
    state.wizTree = exe
    const csvPath = path.join(tempDir(), target.replace(/[^A-Za-z0-9]/g, '_') + '-' + Date.now() + '.csv')
    const exported = await wizTreeExport(exe, target, csvPath)
    if (exec?.signal?.aborted) throw new Error('扫描已取消')
    const parsed = await parseWizTreeCsv(csvPath, { target, depth, top, junk: junkCandidates() })
    state.lastScan = { target, at: new Date().toISOString(), totalBytes: parsed.totalBytes, csvPath }
    return {
      target,
      wizTree: exe,
      csvPath,
      elapsedMs: exported.elapsedMs,
      totalBytes: parsed.totalBytes,
      freeBytes: parsed.freeBytes,
      topDirectories: parsed.topDirectories,
      topFiles: parsed.topFiles,
      junk: parsed.junk,
    }
  },
}

const localAppsRun = {
  name: 'local_apps_run',
  description:
    '在宿主进程直接运行任意本地可执行文件并回收输出（不经过 shell、不经过文件沙箱）。用于调用 WizTree、PowerShell、卸载器等，必须给绝对路径。',
  parameters: {
    type: 'object',
    properties: {
      exe: { type: 'string', description: '可执行文件绝对路径' },
      args: { type: 'array', items: { type: 'string' }, description: '参数数组' },
      cwd: { type: 'string', description: '工作目录' },
      timeoutMs: { type: 'integer', description: '超时毫秒，默认 60000' },
    },
    required: ['exe'],
    additionalProperties: false,
  },
  output: OBJECT_OUTPUT,
  async execute(args) {
    if (!path.isAbsolute(args.exe)) throw new Error('exe 必须是绝对路径：' + args.exe)
    if (!existsSync(args.exe)) throw new Error('文件不存在：' + args.exe)
    const timeoutMs = Math.max(1000, Math.min(30 * 60 * 1000, args.timeoutMs ?? 60000))
    const result = await runProcess([args.exe, ...(args.args ?? [])], {
      cwd: args.cwd && existsSync(args.cwd) ? args.cwd : undefined,
      timeoutMs,
    })
    state.lastRun = { exe: args.exe, at: new Date().toISOString(), exitCode: result.exitCode }
    return result
  },
}

const localAppsList = {
  name: 'local_apps_list',
  description: '列出本机已安装软件（注册表 Uninstall 项），含安装路径与占用大小，可用来挑选能搬到其他盘的软件。',
  parameters: {
    type: 'object',
    properties: { top: { type: 'integer', description: '返回条数，默认 60' } },
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object' },
    render(_args, value) {
      const lines = value.apps.map((app) =>
        String(app.sizeMB ?? '?').padStart(6) + ' MB  ' + app.name + (app.version ? ' ' + app.version : '') +
          (app.installLocation ? '  [' + app.installLocation + ']' : ''))
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args) {
    const apps = await installedApps()
    return { count: apps.length, apps: apps.slice(0, Math.max(5, Math.min(400, args.top ?? 60))) }
  },
}

const diskFree = {
  name: 'disk_free',
  description: '读取各磁盘卷的总容量、已用和可用空间。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  output: {
    schema: { type: 'object' },
    render(_args, value) {
      const lines = value.volumes.map((volume) =>
        volume.drive.padEnd(4) + ' total ' + fmtBytes(volume.totalBytes).padStart(9) +
          '  free ' + fmtBytes(volume.freeBytes).padStart(9) + '  (' + volume.freePercent + '% free)')
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute() {
    const volumes = []
    for (const letter of 'CDEFGHIJ') {
      const drive = letter + ':\\'
      try {
        const raw = statfsSync(drive)
        const total = raw.blocks * raw.bsize
        const free = raw.bavail * raw.bsize
        volumes.push({
          drive,
          totalBytes: total,
          freeBytes: free,
          usedBytes: total - free,
          freePercent: total ? Math.round((free / total) * 1000) / 10 : 0,
        })
      } catch {}
    }
    return { volumes }
  },
}

/* ------------------------------------------------- cleanup / migration tools */

/** Recursive byte size; returns 0 for a missing path. */
async function folderBytes(root) {
  let total = 0
  let stack = [root]
  while (stack.length) {
    const dir = stack.pop()
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile()) {
        try { total += (await stat(full)).size } catch {}
      }
    }
  }
  return total
}

/** Delete every child of a directory, optionally keeping names that match. */
async function emptyDir(dir, { keep, dryRun } = {}) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return { bytes: 0, removed: 0 } }
  let bytes = 0
  let removed = 0
  for (const entry of entries) {
    if (keep && keep.test(entry.name)) continue
    const full = path.join(dir, entry.name)
    const size = entry.isDirectory() ? await folderBytes(full) : (() => { try { return statSync(full).size } catch { return 0 } })()
    if (dryRun) { bytes += size; removed += 1; continue }
    try {
      await rm(full, { recursive: true, force: true, maxRetries: 2 })
      bytes += size
      removed += 1
    } catch {}
  }
  return { bytes, removed }
}

const CLEAN_ITEMS = {
  'user-temp': { label: '用户临时文件', dir: () => os.tmpdir(), keep: /^dsh-/i },
  'windows-temp': { label: '系统临时文件', dir: () => 'C:\\Windows\\Temp' },
  'wer': { label: 'Windows 错误报告', dir: () => 'C:\\ProgramData\\Microsoft\\Windows\\WER' },
  'cbs-logs': { label: 'CBS 组件日志', dir: () => 'C:\\Windows\\Logs\\CBS' },
  'recycle-bin': { label: '回收站', shell: async (dryRun) => {
    const before = await folderBytes('C:\\$Recycle.Bin')
    if (!dryRun) await runProcess(['cmd.exe', '/c', 'rd', '/s', '/q', 'C:\\$Recycle.Bin'], { timeoutMs: 120000 })
    return { bytes: dryRun ? before : before, removed: 0 }
  } },
  'update-cache': { label: 'Windows 更新缓存', shell: async (dryRun) => {
    const dir = 'C:\\Windows\\SoftwareDistribution\\Download'
    const bytes = await folderBytes(dir)
    if (dryRun) return { bytes, removed: 0 }
    await runProcess(['sc.exe', 'stop', 'wuauserv'], { timeoutMs: 60000 })
    await runProcess(['sc.exe', 'stop', 'bits'], { timeoutMs: 60000 })
    const result = await emptyDir(dir)
    await runProcess(['sc.exe', 'start', 'wuauserv'], { timeoutMs: 60000 })
    await runProcess(['sc.exe', 'start', 'bits'], { timeoutMs: 60000 })
    return result
  } },
  'browser-cache': { label: '浏览器缓存', shell: async (dryRun) => {
    const roots = [
      path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'User Data'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data'),
    ]
    let bytes = 0
    let removed = 0
    for (const root of roots) {
      let profiles
      try { profiles = await readdir(root, { withFileTypes: true }) } catch { continue }
      for (const profile of profiles) {
        if (!profile.isDirectory()) continue
        if (profile.name !== 'Default' && !profile.name.startsWith('Profile ')) continue
        for (const cache of ['Cache', 'Code Cache', 'GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache']) {
          const result = await emptyDir(path.join(root, profile.name, cache), { dryRun })
          bytes += result.bytes
          removed += result.removed
        }
      }
    }
    return { bytes, removed }
  } },
  'winsxs': { label: 'WinSxS 组件清理（DISM）', shell: async (dryRun) => {
    if (dryRun) return { bytes: 0, removed: 0, note: 'DISM 不提供预览，实际耗时 5-15 分钟' }
    const before = statfsSync('C:\\')
    const result = await runProcess(['Dism.exe', '/Online', '/Cleanup-Image', '/StartComponentCleanup'], { timeoutMs: 30 * 60 * 1000 })
    const after = statfsSync('C:\\')
    return { bytes: Math.max(0, (after.bavail - before.bavail) * after.bsize), removed: 0, exitCode: result.exitCode }
  } },
}

const systemCleanup = {
  name: 'system_cleanup',
  description: '清理 Windows 垃圾文件（临时文件、更新缓存、错误报告、浏览器缓存、回收站、WinSxS）。默认 dry-run 只统计不删除；真正执行需 confirm=true。',
  parameters: {
    type: 'object',
    properties: {
      items: { type: 'array', items: { type: 'string', enum: Object.keys(CLEAN_ITEMS) }, description: '要清理的项目，缺省为除 winsxs 外的全部' },
      dryRun: { type: 'boolean', description: '只统计不删除，默认 true' },
      confirm: { type: 'boolean', description: '真正执行时必须为 true' },
    },
    additionalProperties: false,
  },
  output: {
    schema: { type: 'object' },
    render(_args, value) {
      const lines = value.results.map((item) =>
        (item.dryRun ? '(dry) ' : '') + fmtBytes(item.bytes).padStart(10) + '  ' + item.label + (item.note ? '  — ' + item.note : ''))
      lines.push('', '合计 ' + fmtBytes(value.totalBytes) + (value.dryRun ? '（未删除，dry-run）' : ' 已释放'))
      return [{ type: 'text', text: lines.join('\n') }]
    },
  },
  async execute(args) {
    const dryRun = args.dryRun !== false
    if (!dryRun && args.confirm !== true) throw new Error('真正执行清理需要 confirm: true')
    const names = args.items?.length ? args.items : Object.keys(CLEAN_ITEMS).filter((key) => key !== 'winsxs')
    const results = []
    let totalBytes = 0
    for (const name of names) {
      const item = CLEAN_ITEMS[name]
      if (!item) continue
      let outcome = { bytes: 0, removed: 0 }
      try {
        outcome = item.shell ? await item.shell(dryRun) : await emptyDir(item.dir(), { keep: item.keep, dryRun })
      } catch (error) {
        outcome = { bytes: 0, removed: 0, note: String(error) }
      }
      totalBytes += outcome.bytes
      results.push({ name, label: item.label, dryRun, ...outcome })
    }
    return { dryRun, totalBytes, results }
  },
}

const diskMigrate = {
  name: 'disk_migrate',
  description: '把某个目录整体搬到另一个卷，并在原路径留下目录联接（junction），程序无需改动。默认 dry-run 只报告大小。',
  parameters: {
    type: 'object',
    properties: {
      source: { type: 'string', description: '要搬走的目录，C 盘绝对路径' },
      target: { type: 'string', description: '目标目录（另一块盘上的完整路径）' },
      dryRun: { type: 'boolean', description: '只报告，不搬，默认 true' },
      confirm: { type: 'boolean', description: '真正搬移时必须为 true' },
    },
    required: ['source', 'target'],
    additionalProperties: false,
  },
  output: { schema: { type: 'object' }, render: (_args, value) => textRender(value) },
  async execute(args) {
    const dryRun = args.dryRun !== false
    if (!dryRun && args.confirm !== true) throw new Error('真正搬移需要 confirm: true')
    const source = args.source.replace(/[\\/]+$/, '')
    const target = args.target.replace(/[\\/]+$/, '')
    if (!path.isAbsolute(source) || !path.isAbsolute(target)) throw new Error('source/target 必须是绝对路径')
    if (path.parse(source).root.toLowerCase() === path.parse(target).root.toLowerCase()) throw new Error('源和目标必须在不同卷')
    if (!existsSync(source)) throw new Error('源目录不存在：' + source)
    if (existsSync(target)) throw new Error('目标已存在，拒绝覆盖：' + target)
    const bytes = await folderBytes(source)
    if (dryRun) return { dryRun, source, target, bytes, linked: false }
    mkdirSync(path.dirname(target), { recursive: true })
    // Copy first, delete only after a clean copy: /MOVE would leave a half-moved
    // folder behind when a single file is locked.
    const copy = await runProcess(['robocopy.exe', source, target, '/E', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NP'], { timeoutMs: 60 * 60 * 1000 })
    if (copy.exitCode >= 8) {
      return { dryRun, source, target, bytes, linked: false, error: 'robocopy exit ' + copy.exitCode + '（源目录保持原样，目标可能有部分副本）' }
    }
    const copiedBytes = await folderBytes(target)
    if (copiedBytes < bytes * 0.98) {
      return { dryRun, source, target, bytes, copiedBytes, linked: false, error: '复制体积不符（' + copiedBytes + ' < ' + bytes + '），源目录保持原样' }
    }
    await rm(source, { recursive: true, force: true }).catch(() => {})
    if (existsSync(source)) {
      return { dryRun, source, target, bytes, copiedBytes, linked: false, error: '源目录仍有文件被占用，无法删除；数据已在 ' + target }
    }
    const link = await runProcess(['cmd.exe', '/c', 'mklink', '/J', source, target], { timeoutMs: 60000 })
    return {
      dryRun, source, target, bytes, copiedBytes,
      linked: link.exitCode === 0 || existsSync(source),
      linkOutput: (link.stdout + link.stderr).trim(),
    }
  },
}

export function apply(ctx) {
  try {
    writeFileSync(
      path.join(tempDir(), 'plugin-loaded.json'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, version: VERSION, wizTree: findWizTree(process.env.DSH_WIZTREE) }),
    )
  } catch {}
  ctx.tools.register(wiztreeScan)
  ctx.tools.register(localAppsRun)
  ctx.tools.register(localAppsList)
  ctx.tools.register(diskFree)
  ctx.tools.register(systemCleanup)
  ctx.tools.register(diskMigrate)

  state.wizTree = findWizTree(process.env.DSH_WIZTREE)

  const webServer = ctx.get('webServer')
  if (webServer?.get) {
    webServer.get('/dsh-local-apps/state', async (req, res) => {
      const body = JSON.stringify({
        version: VERSION,
        wizTree: state.wizTree || findWizTree(process.env.DSH_WIZTREE),
        lastScan: state.lastScan,
        lastRun: state.lastRun,
      })
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(body)
    })
  }
}
