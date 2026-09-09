import { execFile, execFileSync, execSync } from "child_process"
import { readFileSync, unlinkSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import isWsl from "is-wsl"

const LINUX_TERMINAL_APPS = new Set<string>([
  "ghostty",
  "konsole",
  "gnome-terminal",
  "xterm",
  "urxvt",
  "alacritty",
  "kitty",
  "wezterm",
  "wezterm-gui",
  "tilix",
  "terminator",
  "xfce4-terminal",
  "lxterminal",
  "mate-terminal",
  "deepin-terminal",
  "foot",
  "footclient",
])

const MAC_TERMINAL_APP_NAMES = new Set<string>([
  "terminal",
  "iterm2",
  "ghostty",
  "wezterm-gui",
  "alacritty",
  "kitty",
  "hyper",
  "warp",
  "tabby",
  "cursor",
  "visual studio code",
  "code",
  "code insiders",
  "zed",
  "rio",
])

function execWithTimeout(command: string, timeoutMs: number = 500): string | null {
  try {
    return execSync(command, { timeout: timeoutMs, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()
  } catch {
    return null
  }
}

function execFileWithTimeout(command: string, args: readonly string[], timeoutMs: number = 500): string | null {
  try {
    return execFileSync(command, args, { timeout: timeoutMs, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim()
  } catch {
    return null
  }
}

function getHyprlandActiveWindowId(): string | null {
  const output = execWithTimeout("hyprctl activewindow -j")
  if (!output) return null
  try {
    const data = JSON.parse(output)
    return typeof data?.address === "string" ? data.address : null
  } catch {
    return null
  }
}

function findFocusedWindowId(node: any): string | null {
  if (node.focused === true && typeof node.id === "number") {
    return String(node.id)
  }

  if (Array.isArray(node.nodes)) {
    for (const child of node.nodes) {
      const id = findFocusedWindowId(child)
      if (id !== null) return id
    }
  }

  if (Array.isArray(node.floating_nodes)) {
    for (const child of node.floating_nodes) {
      const id = findFocusedWindowId(child)
      if (id !== null) return id
    }
  }

  return null
}

function getSwayActiveWindowId(): string | null {
  const output = execWithTimeout("swaymsg -t get_tree", 1000)
  if (!output) return null
  try {
    const tree = JSON.parse(output)
    return findFocusedWindowId(tree)
  } catch {
    return null
  }
}

function getNiriActiveWindowId(): string | null {
  const output = execWithTimeout("niri msg --json focused-window", 1000)
  if (!output) return null
  try {
    const data = JSON.parse(output)
    return typeof data?.id === "number" ? String(data.id) : null
  } catch {
    return null
  }
}

export function parseWezTermFocusedPaneId(output: string): string | null {
  try {
    const data = JSON.parse(output)
    if (!Array.isArray(data)) return null
    for (const client of data) {
      if (typeof client?.focused_pane_id === "number") {
        return String(client.focused_pane_id)
      }
    }
    return null
  } catch {
    return null
  }
}

function getLinuxWaylandActiveWindowId(): string | null {
  const env = process.env
  if (env.HYPRLAND_INSTANCE_SIGNATURE) return getHyprlandActiveWindowId()
  if (env.NIRI_SOCKET) return getNiriActiveWindowId()
  if (env.SWAYSOCK) return getSwayActiveWindowId()
  if (env.KDE_SESSION_VERSION) return execWithTimeout("kdotool getactivewindow")
  if (isGnomeLikeSession(env)) return getGnomeAtspiActiveWindowKey()
  return null
}

// --- GNOME Wayland focus detection via AT-SPI --------------------------------
// GNOME intentionally exposes no compositor API for the focused window
// (Introspect GetWindows/Eval are AccessDenied), and XWayland tools like
// xdotool cannot see native Wayland windows. The accessibility bus is the
// remaining out-of-band channel: every toolkit window (including Ghostty's
// /com/mitchellh/ghostty nodes) reports AT-SPI states, where bit 1 (ACTIVE)
// means "window is currently the active window". Verified on Ubuntu 26.04 /
// GNOME Shell 50 + Ghostty by sampling states across real focus switches
// (issues #83, #104).

const ATSPI_ACTIVE_BIT_INDEX = 1

const ATSPI_TERMINAL_PATH_MARKERS = ["mitchellh/ghostty"]

export function isGnomeLikeSession(env: NodeJS.ProcessEnv = process.env): boolean {
  const desktop = `${env.XDG_CURRENT_DESKTOP ?? ""} ${env.DESKTOP_SESSION ?? ""}`.toLowerCase()
  return desktop.includes("gnome") || desktop.includes("ubuntu") || desktop.includes("pop")
}

export function parseAtspiString(output: string | null): string | null {
  if (!output) return null
  const match = output.match(/'((?:[^'\\]|\\.)*)'/)
  if (!match) return null
  try {
    return JSON.parse(`"${match[1].replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
  } catch {
    return match[1]
  }
}

export interface AtspiObjectRef {
  bus: string
  path: string
}

export function parseAtspiObjectRefs(output: string | null): AtspiObjectRef[] {
  if (!output) return []
  const refs: AtspiObjectRef[] = []
  const re = /\('([^']+)',\s*(?:objectpath\s+)?'([^']+)'\)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(output)) !== null) {
    refs.push({ bus: match[1], path: match[2] })
  }
  return refs
}

export function parseAtspiStateActive(output: string | null): boolean | null {
  if (!output) return null
  const match = output.match(/uint32\s+(\d+)/)
  if (!match) return null
  const firstWord = Number(match[1]) >>> 0
  return ((firstWord >>> ATSPI_ACTIVE_BIT_INDEX) & 1) === 1
}

export function isAtspiTerminalWindow(appName: string | null, windowPath: string): boolean {
  if (ATSPI_TERMINAL_PATH_MARKERS.some((marker) => windowPath.toLowerCase().includes(marker))) {
    return true
  }
  if (!appName) return false
  return LINUX_TERMINAL_APPS.has(appName.trim().toLowerCase())
}

function getAtspiBusAddress(): string | null {
  const output = execFileWithTimeout("gdbus", [
    "call", "--session",
    "--dest", "org.a11y.Bus",
    "--object-path", "/org/a11y/bus",
    "--method", "org.a11y.Bus.GetAddress",
  ], 1000)
  return parseAtspiString(output)
}

function getAtspiWindowRole(address: string, appBus: string, windowPath: string): string | null {
  const output = execFileWithTimeout("gdbus", [
    "call", "--address", address,
    "--dest", appBus,
    "--object-path", windowPath,
    "--method", "org.a11y.atspi.Accessible.GetRoleName",
  ], 500)
  return parseAtspiString(output)
}

function isAtspiWindowActive(address: string, appBus: string, windowPath: string): boolean | null {
  const output = execFileWithTimeout("gdbus", [
    "call", "--address", address,
    "--dest", appBus,
    "--object-path", windowPath,
    "--method", "org.a11y.atspi.Accessible.GetState",
  ], 500)
  return parseAtspiStateActive(output)
}

function getAtspiTerminalWindowRefs(address: string): AtspiObjectRef[] {
  const refs: AtspiObjectRef[] = []
  const rootOutput = execFileWithTimeout("gdbus", [
    "call", "--address", address,
    "--dest", "org.a11y.atspi.Registry",
    "--object-path", "/org/a11y/atspi/accessible/root",
    "--method", "org.a11y.atspi.Accessible.GetChildren",
  ], 1000)
  for (const app of parseAtspiObjectRefs(rootOutput)) {
    const appName = parseAtspiString(execFileWithTimeout("gdbus", [
      "call", "--address", address,
      "--dest", app.bus,
      "--object-path", "/org/a11y/atspi/accessible/root",
      "--method", "org.freedesktop.DBus.Properties.Get",
      "org.a11y.atspi.Accessible", "Name",
    ], 500))
    const childrenOutput = execFileWithTimeout("gdbus", [
      "call", "--address", address,
      "--dest", app.bus,
      "--object-path", app.path,
      "--method", "org.a11y.atspi.Accessible.GetChildren",
    ], 500)
    for (const child of parseAtspiObjectRefs(childrenOutput)) {
      if (!isAtspiTerminalWindow(appName, child.path)) continue
      const role = getAtspiWindowRole(address, child.bus, child.path)?.toLowerCase()
      if (role === "window" || role === "frame" || role === "dialog" || role === null) {
        refs.push(child)
      }
    }
  }
  return refs
}

export function getGnomeAtspiActiveWindowKey(): string | null {
  try {
    const address = getAtspiBusAddress()
    if (!address) return null
    for (const ref of getAtspiTerminalWindowRefs(address)) {
      if (isAtspiWindowActive(address, ref.bus, ref.path) === true) {
        return `atspi:${ref.path}`
      }
    }
    return null
  } catch {
    return null
  }
}

export function debugFocusState(message: string): void {
  if (process.env.OPENCODE_NOTIFIER_DEBUG) {
    console.error(`[opencode-notifier] ${message}`)
  }
}

const WINDOWS_TERMINAL_WINDOW_CLASSES = new Set<string>([
  "cascadia_hosting_window_class",
  "consolewindowclass",
  "windowsterminalwindowclass",
])

const WINDOWS_TERMINAL_PROCESS_NAMES = new Set<string>([
  "windowsterminal",
  "windowsterminalpreview",
  "conhost",
  "alacritty",
  "wezterm",
  "wezterm-gui",
  "kitty",
  "hyper",
  "cursor",
  "code",
  "code - insiders",
])

interface WindowsWindowInfo {
  className: string | null
  processName: string | null
}

function getWindowsActiveWindowInfo(): WindowsWindowInfo | null {
  const script = `
$p=Add-Type -Name NFI -Namespace OpenCodeNotifier -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder b,int n);[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);' -PassThru;
$h=$p::GetForegroundWindow();
if(!$h){return}
$sb=New-Object System.Text.StringBuilder 256;
$p::GetClassName($h,$sb,256)|Out-Null;
$c=$sb.ToString();
$procId=0;
$p::GetWindowThreadProcessId($h,[ref]$procId)|Out-Null;
$pn='';
try{$pn=(Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName}catch{}
Write-Output "$c|$pn"
`.trim().replace(/\n/g, "; ")
  let output = execFileWithTimeout("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], 5000)
  if (!output)
    output = execFileWithTimeout("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], 1000)
  if (!output) return null
  // PowerShell may prepend a CLIXML marker/warning line to stdout; drop it so
  // the "class|process" parse stays correct.
  const line = output
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith("#<"))
  if (!line) return null
  const sep = line.indexOf("|")
  if (sep === -1) return null
  const className = line.substring(0, sep) || null
  const processName = line.substring(sep + 1) || null
  return { className, processName }
}

function getMacOSActiveWindowId(): string | null {
  return execWithTimeout(
    `osascript -e 'tell application "System Events" to return id of window 1 of (first application process whose frontmost is true)'`
  )
}

function getMacOSFrontmostAppName(): string | null {
  // Detect frontmost app regardless of activation policy
  // (apps excluded from Dock and App Switcher)
  const lsappinfo = execWithTimeout(
    `lsappinfo info -only name \`lsappinfo front\` | sed 's/.*="\\([^"]*\\)".*/\\1/'`
  )
  if (lsappinfo) return lsappinfo

  // Fallback to System Events if lsappinfo is unavailable
  return execWithTimeout(
    `osascript -e 'tell application "System Events" to return name of first application process whose frontmost is true'`
  )
}

function normalizeMacAppName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.app$/i, "")
    .replace(/\s+/g, " ")
}

function getExpectedMacTerminalAppNames(env: NodeJS.ProcessEnv): Set<string> {
  const expected = new Set<string>()
  const termProgram = typeof env.TERM_PROGRAM === "string" ? normalizeMacAppName(env.TERM_PROGRAM) : ""

  if (env.TMUX && (termProgram === "tmux" || termProgram === "screen" || termProgram.length === 0)) {
    return new Set(MAC_TERMINAL_APP_NAMES)
  }

  if (termProgram === "apple_terminal") {
    expected.add("terminal")
  } else if (termProgram === "iterm" || termProgram === "iterm2") {
    expected.add("iterm2")
  } else if (termProgram === "vscode") {
    expected.add("visual studio code")
    expected.add("code")
    expected.add("code insiders")
  } else if (termProgram === "warpterminal") {
    expected.add("warp")
  } else if (termProgram === "wezterm") {
    expected.add("wezterm-gui")
  } else if (termProgram.length > 0) {
    expected.add(termProgram)
  }

  if (expected.size > 0) {
    return expected
  }

  return new Set(MAC_TERMINAL_APP_NAMES)
}

export function buildOsascriptActivateAppArgs(appName: string): string[] {
  return [
    "-e",
    `tell application "${appName}" to activate`,
  ]
}

export function isMacTerminalAppFocused(frontmostAppName: string | null, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!frontmostAppName) {
    return false
  }

  const normalizedFrontmost = normalizeMacAppName(frontmostAppName)
  if (!normalizedFrontmost) {
    return false
  }

  const expectedApps = getExpectedMacTerminalAppNames(env)
  return expectedApps.has(normalizedFrontmost)
}

function getActiveWindowId(): string | null {
  const platform = process.platform
  if (platform === "darwin") return getMacOSActiveWindowId()
  if (platform === "linux") {
    if (process.env.WAYLAND_DISPLAY) return getLinuxWaylandActiveWindowId()
    if (process.env.DISPLAY) return execWithTimeout("xdotool getactivewindow")
    return null
  }
  if (platform === "win32") return null
  return null
}

const cachedWindowId: string | null = getActiveWindowId()

let cachedWindowTitleValue: string | null | undefined

export function getCachedWindowTitle(): string | null {
  if (cachedWindowTitleValue !== undefined) {
    return cachedWindowTitleValue
  }
  cachedWindowTitleValue =
    process.platform === "linux" && !!process.env.KDE_SESSION_VERSION && cachedWindowId
      ? getWindowTitleFromKdotool(cachedWindowId)
      : null
  return cachedWindowTitleValue
}

export function isTmuxPaneFocused(tmuxPane: string | null | undefined, probeResult: string | null): boolean {
  if (!tmuxPane) return false
  if (!probeResult) return false
  const [sessionAttached, windowActive, paneActive] = probeResult.split(" ")
  return Number(sessionAttached) > 0 && windowActive === "1" && paneActive === "1"
}

export function isLinuxTerminalFocused(params: {
  cachedWindowId: string | null
  currentWindowId: string | null
  wezTermPaneActive: boolean
  tmuxPaneActive: boolean | null
}): boolean {
  const { cachedWindowId, currentWindowId, wezTermPaneActive, tmuxPaneActive } = params

  if (!cachedWindowId) {
    if (!wezTermPaneActive) return false
    if (tmuxPaneActive !== null) return tmuxPaneActive
    return false
  }

  if (currentWindowId !== cachedWindowId) return false
  if (!wezTermPaneActive) return false
  if (tmuxPaneActive !== null) return tmuxPaneActive
  return true
}

export function isWindowsTerminalFocused(params: {
  className: string | null
  processName: string | null
}): boolean {
  const { className, processName } = params
  const classLower = className?.toLowerCase() ?? ""
  const processLower = processName?.toLowerCase() ?? ""
  return WINDOWS_TERMINAL_WINDOW_CLASSES.has(classLower) || WINDOWS_TERMINAL_PROCESS_NAMES.has(processLower)
}

function isTmuxPaneActive(): boolean {
  const tmuxPane = process.env.TMUX_PANE ?? null
  const result = execFileWithTimeout("tmux", ["display-message", "-t", tmuxPane ?? "", "-p", "#{session_attached} #{window_active} #{pane_active}"])
  return isTmuxPaneFocused(tmuxPane, result)
}

function isWezTermPaneActive(): boolean {
  const weztermPane = process.env.WEZTERM_PANE ?? null
  if (!weztermPane) return true
  const output = execFileWithTimeout("wezterm", ["cli", "list-clients", "--format", "json"], 1000)
  if (!output) return false
  const focusedPaneId = parseWezTermFocusedPaneId(output)
  if (!focusedPaneId) return false
  return focusedPaneId === weztermPane
}

export function isTerminalFocused(): boolean {
  try {
    if (process.platform === "darwin") {
      const frontmostAppName = getMacOSFrontmostAppName()
      if (!isMacTerminalAppFocused(frontmostAppName, process.env)) {
        return false
      }
      if (!isWezTermPaneActive()) {
        return false
      }
      if (process.env.TMUX) {
        return isTmuxPaneActive()
      }
      return true
    }

    if (process.platform === "win32") {
      const info = getWindowsActiveWindowInfo()
      return isWindowsTerminalFocused({
        className: info?.className ?? null,
        processName: info?.processName ?? null,
      })
    }

    const tmuxPaneActive = process.env.TMUX ? isTmuxPaneActive() : null
    const currentWindowId = getActiveWindowId()
    const focused = isLinuxTerminalFocused({
      cachedWindowId,
      currentWindowId,
      wezTermPaneActive: isWezTermPaneActive(),
      tmuxPaneActive,
    })
    debugFocusState(
      `linux focus: session=${process.env.XDG_SESSION_TYPE ?? "?"} desktop=${process.env.XDG_CURRENT_DESKTOP ?? process.env.DESKTOP_SESSION ?? "?"} cached=${cachedWindowId ?? "null"} current=${currentWindowId ?? "null"} tmux=${String(tmuxPaneActive)} focused=${focused}`
    )
    return focused
  } catch {
    return false
  }
}

function getWindowIdFromXdotool(searchTerm: string): string | null {
  return execWithTimeout(`xdotool search --classname "${searchTerm}" | head -1`)
}

function getWindowIdFromKdotool(searchTerm: string): string | null {
  return execWithTimeout(`kdotool search --classname "${searchTerm}" | head -1`)
}

function getWindowTitleFromKdotool(windowId: string): string | null {
  return execWithTimeout(`kdotool getwindowname ${windowId}`)
}

let cachedKDEJumpBackSupport: boolean | null = null

export function isKDEJumpBackSupported(): boolean {
  if (process.platform !== "linux" || !process.env.KDE_SESSION_VERSION) {
    return false
  }

  if (cachedKDEJumpBackSupport !== null) {
    return cachedKDEJumpBackSupport
  }

  cachedKDEJumpBackSupport = execFileWithTimeout("kdotool", ["--help"], 1000) !== null
  return cachedKDEJumpBackSupport
}

export function isLinuxJumpBackSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  if (process.platform !== "linux" || isWsl) {
    return false
  }

  if (isKDEJumpBackSupported()) {
    return true
  }

  // Best-effort on other Linux desktops (GNOME, Hyprland, Sway, Niri, X11):
  // notify-send --action implies --wait and surfaces a "Jump to terminal"
  // button whose click is routed back to focusTerminal(). Focus itself may
  // still fail on locked-down compositors (notably GNOME Wayland), but the
  // button must be shown so the user has a chance. Headless sessions without
  // any display server are excluded.
  return !!(env.WAYLAND_DISPLAY || env.DISPLAY)
}

function getWindowClassX11(windowId: string): string | null {
  return execWithTimeout(`xprop -id ${windowId} WM_CLASS 2>/dev/null | awk -F '"' '{print $4}'`)
}

function getWaylandAppId(windowId: string): string | null {
  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) {
    const output = execWithTimeout(`hyprctl clients -j`)
    if (!output) return null
    try {
      const clients = JSON.parse(output)
      for (const client of clients) {
        if (String(client.address) === windowId) {
          return client.class?.toLowerCase() || client.initialClass?.toLowerCase() || null
        }
      }
    } catch {
      return null
    }
  }

  if (process.env.SWAYSOCK) {
    const output = execWithTimeout(`swaymsg -t get_tree`, 1000)
    if (!output) return null
    try {
      const tree = JSON.parse(output)
      const findWindow = (node: any): string | null => {
        if (String(node.id) === windowId) {
          return node.app_id?.toLowerCase() || node.window_properties?.class?.toLowerCase() || null
        }
        if (Array.isArray(node.nodes)) {
          for (const child of node.nodes) {
            const result = findWindow(child)
            if (result) return result
          }
        }
        if (Array.isArray(node.floating_nodes)) {
          for (const child of node.floating_nodes) {
            const result = findWindow(child)
            if (result) return result
          }
        }
        return null
      }
      return findWindow(tree)
    } catch {
      return null
    }
  }

  if (process.env.NIRI_SOCKET) {
    const output = execWithTimeout(`niri msg --json windows`)
    if (!output) return null
    try {
      const windows = JSON.parse(output)
      for (const window of windows) {
        if (String(window.id) === windowId) {
          return window.app_id?.toLowerCase() || null
        }
      }
    } catch {
      return null
    }
  }

  return null
}

function getTerminalWindowId(): string | null {
  if (process.platform !== "linux") return null

  const term = process.env.TERM_PROGRAM?.toLowerCase() || ""
  const desktopSession = process.env.DESKTOP_SESSION?.toLowerCase() || ""
  const isKDE = process.env.KDE_SESSION_VERSION || desktopSession.includes("plasma")

  if (process.env.WAYLAND_DISPLAY) {
    const cachedId = cachedWindowId
    if (cachedId) {
      const appId = getWaylandAppId(cachedId)
      if (appId && LINUX_TERMINAL_APPS.has(appId)) {
        return cachedId
      }
    }
    // On KDE Wayland, kdotool may not be available, so we rely on KWin scripts
    if (isKDE) {
      return cachedId || "kde-wayland"
    }
    return cachedId
  }

  if (process.env.DISPLAY) {
    const cachedId = cachedWindowId
    if (cachedId) {
      const windowClass = getWindowClassX11(cachedId)
      if (windowClass && LINUX_TERMINAL_APPS.has(windowClass.toLowerCase())) {
        return cachedId
      }
    }
    for (const app of LINUX_TERMINAL_APPS) {
      const id = isKDE ? getWindowIdFromKdotool(app) : getWindowIdFromXdotool(app)
      if (id) return id
    }
  }

  return null
}

function focusLinuxWindowX11(windowId: string): void {
  try {
    execSync(`xdotool windowactivate ${windowId} 2>/dev/null`, { timeout: 1000 })
  } catch {
  }
}

function focusLinuxWindowKDE(windowId: string): void {
  try {
    const result = execWithTimeout(`kdotool getactivewindow`)
    if (result === windowId) return
    execSync(`kdotool windowactivate ${windowId} 2>/dev/null`, { timeout: 1000 })
  } catch {
    // kdotool not available, try KWin script approach
    focusKDEWithKWinScript()
  }
}

// Walk up the process tree to find the terminal PID dynamically
function findTerminalPid(): number {
  try {
    let currentPid = process.pid

    // Walk up the process tree
    while (currentPid > 1) {
      try {
        // Read the parent PID from /proc
        const statContent = readFileSync(`/proc/${currentPid}/stat`, "utf-8")
        // Extract parent PID from stat file (field 4)
        const match = statContent.match(/^\d+\s+\([^)]+\)\s+\S\s+(\d+)/)
        if (!match) break

        const ppid = parseInt(match[1], 10)

        // Read the command name
        const cmdline = readFileSync(`/proc/${ppid}/comm`, "utf-8").trim()

        // Check if this looks like a terminal
        if (cmdline.match(/ghostty|konsole|gnome-terminal|xterm|alacritty|kitty|wezterm|terminator|tilix|foot/i)) {
          return ppid
        }

        currentPid = ppid
      } catch {
        break
      }
    }

    // Fallback to PPID if no terminal found
    return process.ppid
  } catch {
    return process.ppid
  }
}

function focusKDEWithKWinScript(): void {
  try {
    const pinnedWindowId = process.env.OPENCODE_NOTIFIER_WINDOW_ID?.trim() || null
    if (pinnedWindowId) {
      try {
        execSync(`kdotool windowactivate ${pinnedWindowId} 2>/dev/null`, { timeout: 1500 })
        return
      } catch {
      }
    }

    if (cachedWindowId) {
      try {
        execSync(`kdotool windowactivate ${cachedWindowId} 2>/dev/null`, { timeout: 1500 })
        return
      } catch {
      }
    }

    // Find terminal PID dynamically (OpenCode might be a daemon)
    const terminalPid = findTerminalPid()
    const currentPid = process.pid
    const termProgram = (process.env.TERM_PROGRAM || "terminal").toLowerCase()
    const cwd = process.cwd().toLowerCase()
    const cwdBase = cwd.split("/").filter(Boolean).pop() || ""
    const cachedTitle = (getCachedWindowTitle() || "").toLowerCase()

    // Create a temporary KWin script
    const scriptContent = `
function activateTargetWindow(window) {
    // Jump to the window's desktop/activity first, then activate.
    // This works more reliably on Plasma than moving windows between desktops.
    try {
        if (window.desktops && window.desktops.length > 0) {
            workspace.currentDesktop = window.desktops[0];
        } else if (typeof window.desktop === "number" && window.desktop > 0) {
            workspace.currentDesktop = window.desktop;
        }
    } catch (e) {}

    try {
        if (window.activities && window.activities.length > 0 && typeof workspace.currentActivity !== "undefined") {
            workspace.currentActivity = window.activities[0];
        }
    } catch (e) {}

    try { window.minimized = false; } catch (e) {}

    try { workspace.activeWindow = window; } catch (e) {}
    try {
        if (typeof workspace.activateWindow === "function") {
            workspace.activateWindow(window);
        }
    } catch (e) {}
    try { window.active = true; } catch (e) {}

    // Nudge stacking so KWin treats this like an explicit user jump.
    try {
        window.keepAbove = true;
        window.keepAbove = false;
    } catch (e) {}
}

function isLikelyTerminal(window) {
    var resourceClass = (window.resourceClass || "").toLowerCase();
    var resourceName = (window.resourceName || "").toLowerCase();
    var caption = (window.caption || "").toLowerCase();

    return resourceClass.indexOf("ghostty") !== -1 ||
           resourceName.indexOf("ghostty") !== -1 ||
           caption.indexOf("ghostty") !== -1 ||
           resourceClass.indexOf("konsole") !== -1 ||
           resourceName.indexOf("konsole") !== -1 ||
           caption.indexOf("konsole") !== -1 ||
           resourceClass.indexOf("terminal") !== -1 ||
           resourceName.indexOf("terminal") !== -1;
}

function findAndActivateTerminal() {
    var allWindows = workspace.windowList();
    var terminalPid = ${terminalPid};
    var termProgramHint = ${JSON.stringify(termProgram)};
    var cwdHint = ${JSON.stringify(cwd)};
    var cwdBaseHint = ${JSON.stringify(cwdBase)};
    var cachedTitleHint = ${JSON.stringify(cachedTitle)};

    function contains(haystack, needle) {
        return !!needle && needle.length > 0 && haystack.indexOf(needle) !== -1;
    }

    function windowScore(window) {
        var resourceClass = (window.resourceClass || "").toLowerCase();
        var resourceName = (window.resourceName || "").toLowerCase();
        var caption = (window.caption || "").toLowerCase();
        var score = 0;

        if (window.pid === terminalPid) score += 30;
        if (contains(caption, "opencode")) score += 60;
        if (contains(caption, cachedTitleHint)) score += 50;
        if (contains(caption, cwdBaseHint)) score += 35;
        if (contains(caption, cwdHint)) score += 20;
        if (contains(resourceClass, termProgramHint) || contains(resourceName, termProgramHint) || contains(caption, termProgramHint)) score += 20;
        if (isLikelyTerminal(window)) score += 10;
        if (window.minimized === true) score -= 5;

        return score;
    }

    var bestWindow = null;
    var bestScore = -1;

    for (var i = 0; i < allWindows.length; i++) {
        var candidate = allWindows[i];
        var score = windowScore(candidate);
        if (score > bestScore) {
            bestWindow = candidate;
            bestScore = score;
        }
    }

    // Require enough confidence to avoid jumping to unrelated terminals.
    if (bestWindow && bestScore >= 30) {
        activateTargetWindow(bestWindow);
        return true;
    }

    return false;
}

findAndActivateTerminal();
`;
    
    const scriptPath = join(tmpdir(), `opencode-focus-${currentPid}.kwinscript`)
    const pluginName = `opencode-focus-${currentPid}`
    writeFileSync(scriptPath, scriptContent)

    // Load the script
    execSync(
      `qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.loadScript "${scriptPath}" "${pluginName}"`,
      { encoding: "utf-8", timeout: 2000 }
    )

    // Start the script
    execSync(
      `qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.start`,
      { timeout: 2000 }
    )

    // Clean up
    try {
      unlinkSync(scriptPath)
    } catch {}

    // Unload the script after a short delay
    setTimeout(() => {
      try {
        execSync(
          `qdbus org.kde.KWin /Scripting org.kde.kwin.Scripting.unloadScript "${pluginName}"`,
          { timeout: 500 }
        )
      } catch {}
    }, 1000)
    
  } catch {
    // Fall back to xdotool
    try {
      const cachedId = cachedWindowId;
      if (cachedId) {
        execSync(`xdotool windowactivate ${cachedId} 2>/dev/null`, { timeout: 1000 });
      }
    } catch {}
  }
}

function focusLinuxWindowHyprland(windowId: string): void {
  try {
    execSync(`hyprctl dispatch focuswindow address:${windowId} 2>/dev/null`, { timeout: 1000 })
  } catch {
  }
}

function focusLinuxWindowSway(windowId: string): void {
  try {
    execSync(`swaymsg "[con_id=${windowId}] focus" 2>/dev/null`, { timeout: 1000 })
  } catch {
  }
}

function focusLinuxWindowNiri(windowId: string): void {
  try {
    execSync(`niri msg action focus-window --id ${windowId} 2>/dev/null`, { timeout: 1000 })
  } catch {
  }
}

function focusLinuxWindowGnome(): void {
  // GNOME Wayland exposes no compositor focus API and blocks Shell Eval, so
  // this is intentionally best-effort: numeric XIDs (XWayland or manual pin)
  // via xdotool, then a classname search, then wmctrl, then a Shell Eval
  // attempt that succeeds only with extensions/unsafe-mode. Never throws.
  const tryXdotoolActivate = (windowId: string): boolean => {
    if (!/^\d+$/.test(windowId)) return false
    try {
      execSync(`xdotool windowactivate ${windowId} 2>/dev/null`, { timeout: 1000 })
      debugFocusState(`gnome focus: xdotool windowactivate ${windowId}`)
      return true
    } catch {
      return false
    }
  }

  const pinned = process.env.OPENCODE_NOTIFIER_WINDOW_ID?.trim()
  if (pinned && tryXdotoolActivate(pinned)) return

  if (cachedWindowId && tryXdotoolActivate(cachedWindowId)) return

  for (const app of LINUX_TERMINAL_APPS) {
    const id = getWindowIdFromXdotool(app)
    if (id && tryXdotoolActivate(id)) return
  }

  const wmctrl = execFileWithTimeout("wmctrl", ["-l"], 1000)
  if (wmctrl) {
    for (const line of wmctrl.split("\n")) {
      const lower = line.toLowerCase()
      for (const app of LINUX_TERMINAL_APPS) {
        if (lower.includes(app)) {
          const id = line.split(/\s+/)[0]
          if (id && tryXdotoolActivate(id)) return
        }
      }
    }
  }

  try {
    execSync(
      `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval 'global.display.focus_window()' 2>/dev/null`,
      { timeout: 1000 }
    )
  } catch {
  }
  debugFocusState("gnome focus: no activator succeeded (compositor likely blocked focus)")
}

export function captureStartupWindowId(): void {
  if (!isLinuxJumpBackSupported()) {
    return
  }

  const existing = process.env.OPENCODE_NOTIFIER_WINDOW_ID?.trim()
  if (existing) {
    return
  }

  if (isKDEJumpBackSupported()) {
    const detected = execWithTimeout("kdotool getactivewindow", 1000)
    if (detected && /^\d+$/.test(detected)) {
      process.env.OPENCODE_NOTIFIER_WINDOW_ID = detected
    }
    return
  }

  // X11 / XWayland sessions: pin the numeric window ID for deterministic
  // jump-back. On native Wayland (e.g. GNOME + Ghostty) xdotool sees nothing
  // and we leave it unset so focus falls back to classname search.
  if (process.env.DISPLAY) {
    const detected = execWithTimeout("xdotool getactivewindow", 1000)
    if (detected && /^\d+$/.test(detected)) {
      process.env.OPENCODE_NOTIFIER_WINDOW_ID = detected
    }
  }
}

export async function focusTerminal(): Promise<void> {
  if (process.platform === "darwin") {
    try {
      const frontmostAppName = getMacOSFrontmostAppName()
      if (frontmostAppName && isMacTerminalAppFocused(frontmostAppName, process.env)) {
        return
      }
      const expectedApps = getExpectedMacTerminalAppNames(process.env)
      for (const app of expectedApps) {
        try {
          execFileSync("osascript", buildOsascriptActivateAppArgs(app), { timeout: 1000, stdio: "ignore" })
          return
        } catch {
        }
      }
      execFileSync("osascript", buildOsascriptActivateAppArgs("Terminal"), { timeout: 1000, stdio: "ignore" })
    } catch {
    }
    return
  }

  if (process.platform === "linux") {
    const env = process.env
    
    // For KDE Plasma, use KWin script approach which works on both X11 and Wayland
    if (env.KDE_SESSION_VERSION) {
      focusKDEWithKWinScript()
      return
    }

    // GNOME Wayland has no compositor focus API; use the best-effort chain
    // (pinned/XID via xdotool, classname search, wmctrl, Shell Eval).
    if (isGnomeLikeSession(env)) {
      focusLinuxWindowGnome()
      return
    }
    
    const windowId = getTerminalWindowId()
    if (!windowId) return

    if (env.HYPRLAND_INSTANCE_SIGNATURE) {
      focusLinuxWindowHyprland(windowId)
    } else if (env.SWAYSOCK) {
      focusLinuxWindowSway(windowId)
    } else if (env.NIRI_SOCKET) {
      focusLinuxWindowNiri(windowId)
    } else if (env.DISPLAY) {
      focusLinuxWindowX11(windowId)
    }
  }
}
