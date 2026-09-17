import { describe, test, expect } from "bun:test"
import { isLinuxTerminalFocused, isMacTerminalAppFocused, isTmuxPaneFocused, parseWezTermFocusedPaneId, isKDEJumpBackSupported, captureStartupWindowId, focusTerminal, getCachedWindowTitle, isWindowsTerminalFocused, buildOsascriptActivateAppArgs, findQdbusBinary, resolveQdbusBinary, isGnomeLikeSession, parseAtspiString, parseAtspiObjectRefs, parseAtspiStateActive, isAtspiTerminalWindow } from "./focus"

describe("isMacTerminalAppFocused", () => {
  test("matches Terminal when TERM_PROGRAM is Apple_Terminal", () => {
    const env = { TERM_PROGRAM: "Apple_Terminal" }
    expect(isMacTerminalAppFocused("Terminal", env)).toBe(true)
  })

  test("matches iTerm2 when TERM_PROGRAM is iTerm.app", () => {
    const env = { TERM_PROGRAM: "iTerm.app" }
    expect(isMacTerminalAppFocused("iTerm2", env)).toBe(true)
  })

  test("matches Ghostty by fallback allowlist", () => {
    const env = {}
    expect(isMacTerminalAppFocused("Ghostty", env)).toBe(true)
  })

  test("returns false for non-terminal app", () => {
    const env = { TERM_PROGRAM: "Apple_Terminal" }
    expect(isMacTerminalAppFocused("Safari", env)).toBe(false)
  })

  test("returns false when frontmost app is unavailable", () => {
    const env = { TERM_PROGRAM: "Apple_Terminal" }
    expect(isMacTerminalAppFocused(null, env)).toBe(false)
  })

  test("regression: no startup cache dependency for later frontmost terminal", () => {
    const env = { TERM_PROGRAM: "Apple_Terminal" }
    expect(isMacTerminalAppFocused("Safari", env)).toBe(false)
    expect(isMacTerminalAppFocused("Terminal", env)).toBe(true)
  })

  test("tmux on macOS falls back to terminal allowlist", () => {
    const env = { TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux-1000/default,1234,0" }
    expect(isMacTerminalAppFocused("Ghostty", env)).toBe(true)
    expect(isMacTerminalAppFocused("Terminal", env)).toBe(true)
  })

  test("tmux fallback still rejects non-terminal frontmost app", () => {
    const env = { TERM_PROGRAM: "tmux", TMUX: "/tmp/tmux-1000/default,1234,0" }
    expect(isMacTerminalAppFocused("Safari", env)).toBe(false)
  })

  test("wezterm TERM_PROGRAM matches WezTerm-GUI frontmost app", () => {
    const env = { TERM_PROGRAM: "wezterm" }
    expect(isMacTerminalAppFocused("WezTerm-GUI", env)).toBe(true)
  })

  test("wezterm TERM_PROGRAM still rejects non-terminal frontmost app", () => {
    const env = { TERM_PROGRAM: "wezterm" }
    expect(isMacTerminalAppFocused("Safari", env)).toBe(false)
  })
})

describe("isTmuxPaneFocused", () => {
  test("returns false when TMUX_PANE is missing", () => {
    expect(isTmuxPaneFocused(null, "1 1 1")).toBe(false)
  })

  test("returns false when probe result is unavailable", () => {
    expect(isTmuxPaneFocused("%1", null)).toBe(false)
  })

  test("returns true for active attached pane", () => {
    expect(isTmuxPaneFocused("%1", "1 1 1")).toBe(true)
  })

  test("returns false for inactive pane/window/session", () => {
    expect(isTmuxPaneFocused("%1", "1 1 0")).toBe(false)
    expect(isTmuxPaneFocused("%1", "1 0 1")).toBe(false)
    expect(isTmuxPaneFocused("%1", "0 1 1")).toBe(false)
  })

  test("returns true when session has multiple attached clients", () => {
    expect(isTmuxPaneFocused("%1", "2 1 1")).toBe(true)
    expect(isTmuxPaneFocused("%1", "5 1 1")).toBe(true)
  })
})

describe("isLinuxTerminalFocused", () => {
  test("falls back to tmux pane state when window id is unavailable", () => {
    expect(
      isLinuxTerminalFocused({
        cachedWindowId: null,
        currentWindowId: null,
        wezTermPaneActive: true,
        tmuxPaneActive: true,
      })
    ).toBe(true)
  })

  test("does not suppress without tmux when window id is unavailable", () => {
    expect(
      isLinuxTerminalFocused({
        cachedWindowId: null,
        currentWindowId: null,
        wezTermPaneActive: true,
        tmuxPaneActive: null,
      })
    ).toBe(false)
  })

  test("does not suppress when wezterm pane is inactive", () => {
    expect(
      isLinuxTerminalFocused({
        cachedWindowId: null,
        currentWindowId: null,
        wezTermPaneActive: false,
        tmuxPaneActive: true,
      })
    ).toBe(false)
  })

  test("keeps existing window-id check when available", () => {
    expect(
      isLinuxTerminalFocused({
        cachedWindowId: "123",
        currentWindowId: "456",
        wezTermPaneActive: true,
        tmuxPaneActive: true,
      })
    ).toBe(false)
  })
})

describe("isWindowsTerminalFocused", () => {
  test("matches Windows Terminal by class name", () => {
    expect(isWindowsTerminalFocused({ className: "CASCADIA_HOSTING_WINDOW_CLASS", processName: null })).toBe(true)
  })

  test("matches Windows Terminal by process name", () => {
    expect(isWindowsTerminalFocused({ className: null, processName: "WindowsTerminal" })).toBe(true)
  })

  test("matches conhost by class name", () => {
    expect(isWindowsTerminalFocused({ className: "ConsoleWindowClass", processName: null })).toBe(true)
  })

  test("matches conhost by process name", () => {
    expect(isWindowsTerminalFocused({ className: null, processName: "conhost" })).toBe(true)
  })

  test("matches Alacritty by process name", () => {
    expect(isWindowsTerminalFocused({ className: null, processName: "alacritty" })).toBe(true)
  })

  test("matches WezTerm by process name", () => {
    expect(isWindowsTerminalFocused({ className: null, processName: "wezterm" })).toBe(true)
  })

  test("matches VS Code by process name", () => {
    expect(isWindowsTerminalFocused({ className: null, processName: "Code" })).toBe(true)
  })

  test("matches cursor by process name", () => {
    expect(isWindowsTerminalFocused({ className: null, processName: "cursor" })).toBe(true)
  })

  test("returns false for non-terminal class and process", () => {
    expect(isWindowsTerminalFocused({ className: "Chrome_WidgetWin_1", processName: "chrome" })).toBe(false)
  })

  test("returns false when both are null", () => {
    expect(isWindowsTerminalFocused({ className: null, processName: null })).toBe(false)
  })

  test("is case insensitive", () => {
    expect(isWindowsTerminalFocused({ className: "CASCADIA_HOSTING_WINDOW_CLASS", processName: null })).toBe(true)
    expect(isWindowsTerminalFocused({ className: "cascadia_hosting_window_class", processName: null })).toBe(true)
    expect(isWindowsTerminalFocused({ className: null, processName: "WindowsTerminal" })).toBe(true)
    expect(isWindowsTerminalFocused({ className: null, processName: "windowsterminal" })).toBe(true)
  })

  test("matches when either class or process name matches", () => {
    expect(isWindowsTerminalFocused({ className: "CASCADIA_HOSTING_WINDOW_CLASS", processName: "chrome" })).toBe(true)
    expect(isWindowsTerminalFocused({ className: "Chrome_WidgetWin_1", processName: "WindowsTerminal" })).toBe(true)
  })
})

describe("getWindowsActiveWindowInfo on Windows", () => {
  test("PowerShell command produces valid 'class|process' output", () => {
    // Only run this test on Windows (the P/Invoke won't work elsewhere)
    // This is an integration test that verifies the actual PowerShell command
    // works correctly — catches Win32 API issues, CLIXML problems, etc.
    if (process.platform !== "win32") return
    const { execFileSync } = require("child_process")
    const script = `
$p=Add-Type -Name NFI_Test -Namespace OpenCodeNotifier -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();[DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetClassName(IntPtr h,System.Text.StringBuilder b,int n);[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p);' -PassThru;
$h=$p::GetForegroundWindow();
if(!$h){Write-Output 'null|null';return}
$sb=New-Object System.Text.StringBuilder 256;
$p::GetClassName($h,$sb,256)|Out-Null;
$c=$sb.ToString();
$procId=0;
$p::GetWindowThreadProcessId($h,[ref]$procId)|Out-Null;
try{$pn=(Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName}catch{}
if(!$pn){$pn=''}
Write-Output "$c|$pn"
`.trim().replace(/\n/g, "; ")

    const raw = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
      windowsHide: true,
    }).trim()

    // PowerShell may prepend a CLIXML marker/warning line; ignore it, same as
    // the production parser.
    const result = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#<")) ?? raw

    // The result must contain '|' and must have a non-empty process name
    expect(result).toContain("|")
    const [className, processName] = result.split("|")
    // In headless/service contexts GetForegroundWindow() can be null, which the
    // script reports as 'null|null'. Skip the content assertions in that case.
    if (className === "null" && processName === "null") return
    expect(className).toBeTruthy()
    expect(processName).toBeTruthy()
    // Class name should be a real Windows window class (at least 3 chars)
    expect(className.length).toBeGreaterThan(2)
  })
})

describe("parseWezTermFocusedPaneId", () => {
  test("returns pane id from valid list-clients JSON", () => {
    const output = JSON.stringify([
      { focused_pane_id: 18, workspace: "main" },
      { focused_pane_id: 42, workspace: "dev" },
    ])
    expect(parseWezTermFocusedPaneId(output)).toBe("18")
  })

  test("returns null for non-array JSON", () => {
    expect(parseWezTermFocusedPaneId('{"focused_pane_id": 18}')).toBe(null)
  })

  test("returns null for malformed JSON", () => {
    expect(parseWezTermFocusedPaneId("not-json")).toBe(null)
  })

  test("returns null when no focused_pane_id exists", () => {
    const output = JSON.stringify([{ workspace: "main" }, { focused_pane_id: "18" }])
    expect(parseWezTermFocusedPaneId(output)).toBe(null)
  })
})

describe("isKDEJumpBackSupported", () => {
  test("returns false on non-linux platforms", () => {
    expect(isKDEJumpBackSupported()).toBe(false)
  })

  test("returns false when KDE_SESSION_VERSION is unset even on linux", () => {
    const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")
    Object.defineProperty(process, "platform", { value: "linux" })
    const originalKde = process.env.KDE_SESSION_VERSION
    delete process.env.KDE_SESSION_VERSION

    try {
      expect(isKDEJumpBackSupported()).toBe(false)
    } finally {
      if (originalPlatform) {
        Object.defineProperty(process, "platform", originalPlatform)
      }
      if (originalKde) {
        process.env.KDE_SESSION_VERSION = originalKde
      }
    }
  })
})

describe("getCachedWindowTitle", () => {
  test("returns null when not on linux with kde", () => {
    expect(getCachedWindowTitle()).toBe(null)
  })
})

describe("captureStartupWindowId", () => {
  test("does not set env var when kde jump back is unsupported", () => {
    const original = process.env.OPENCODE_NOTIFIER_WINDOW_ID
    delete process.env.OPENCODE_NOTIFIER_WINDOW_ID

    try {
      captureStartupWindowId()
      expect(process.env.OPENCODE_NOTIFIER_WINDOW_ID).toBeUndefined()
    } finally {
      if (original) {
        process.env.OPENCODE_NOTIFIER_WINDOW_ID = original
      } else {
        delete process.env.OPENCODE_NOTIFIER_WINDOW_ID
      }
    }
  })
})

describe("findQdbusBinary", () => {
  test("prefers the first available candidate in order", () => {
    const available = new Set(["qdbus-qt6", "qdbus"])
    expect(findQdbusBinary(["qdbus-qt6", "qdbus6", "qdbus"], (name) => available.has(name))).toBe("qdbus-qt6")
  })

  test("falls through to plain qdbus when no versioned binary exists", () => {
    expect(findQdbusBinary(["qdbus-qt6", "qdbus"], (name) => name === "qdbus")).toBe("qdbus")
  })

  test("returns null when nothing is available", () => {
    expect(findQdbusBinary(["qdbus-qt6", "qdbus"], () => false)).toBe(null)
  })
})

describe("resolveQdbusBinary", () => {
  test("returns a binary name or null without throwing", () => {
    const result = resolveQdbusBinary()
    expect(result === null || typeof result === "string").toBe(true)
  })

  test("caches the resolved value", () => {
    expect(resolveQdbusBinary()).toBe(resolveQdbusBinary())
  })
})

describe("focusTerminal", () => {
  test("does not throw on unsupported platforms", async () => {
    await expect(focusTerminal()).resolves.toBeUndefined()
  })
})

describe("isGnomeLikeSession", () => {
  test("matches ubuntu/gnome desktops", () => {
    expect(isGnomeLikeSession({ XDG_CURRENT_DESKTOP: "ubuntu:GNOME" } as NodeJS.ProcessEnv)).toBe(true)
    expect(isGnomeLikeSession({ DESKTOP_SESSION: "gnome" } as NodeJS.ProcessEnv)).toBe(true)
    expect(isGnomeLikeSession({ XDG_CURRENT_DESKTOP: "pop:GNOME" } as NodeJS.ProcessEnv)).toBe(true)
  })

  test("rejects kde/hyprland/sway sessions", () => {
    expect(isGnomeLikeSession({ XDG_CURRENT_DESKTOP: "KDE", KDE_SESSION_VERSION: "6" } as NodeJS.ProcessEnv)).toBe(false)
    expect(isGnomeLikeSession({ XDG_CURRENT_DESKTOP: "Hyprland" } as NodeJS.ProcessEnv)).toBe(false)
    expect(isGnomeLikeSession({} as NodeJS.ProcessEnv)).toBe(false)
  })
})

describe("parseAtspiString", () => {
  test("extracts bus address from gdbus string tuple", () => {
    expect(parseAtspiString("('unix:path=/run/user/1000/at-spi/bus,guid=abc',)")).toBe("unix:path=/run/user/1000/at-spi/bus,guid=abc")
  })

  test("extracts role and app names", () => {
    expect(parseAtspiString("('window',)")).toBe("window")
    expect(parseAtspiString("(<'Ghostty'>,)")).toBe("Ghostty")
  })

  test("returns null for empty output", () => {
    expect(parseAtspiString(null)).toBe(null)
    expect(parseAtspiString("")).toBe(null)
    expect(parseAtspiString("Error: something failed")).toBe(null)
  })
})

describe("parseAtspiObjectRefs", () => {
  test("parses root children into bus/path refs", () => {
    const output = "([(':1.18', objectpath '/org/a11y/atspi/accessible/root'), (':1.17', '/org/a11y/atspi/accessible/root')],)"
    expect(parseAtspiObjectRefs(output)).toEqual([
      { bus: ":1.18", path: "/org/a11y/atspi/accessible/root" },
      { bus: ":1.17", path: "/org/a11y/atspi/accessible/root" },
    ])
  })

  test("parses ghostty window path", () => {
    const output = "([(':1.18', objectpath '/com/mitchellh/ghostty/a11y/99610c12')],)"
    expect(parseAtspiObjectRefs(output)).toEqual([
      { bus: ":1.18", path: "/com/mitchellh/ghostty/a11y/99610c12" },
    ])
  })

  test("returns empty for null output", () => {
    expect(parseAtspiObjectRefs(null)).toEqual([])
    expect(parseAtspiObjectRefs("")).toEqual([])
  })
})

describe("parseAtspiStateActive", () => {
  test("detects ACTIVE bit on focused ghostty window (#83/#104 probe)", () => {
    expect(parseAtspiStateActive("([uint32 1124073474, 0],)")).toBe(true)
  })

  test("detects missing ACTIVE bit on unfocused ghostty window", () => {
    expect(parseAtspiStateActive("([uint32 1124073472, 0],)")).toBe(false)
  })

  test("returns null when state is unavailable", () => {
    expect(parseAtspiStateActive(null)).toBe(null)
    expect(parseAtspiStateActive("")).toBe(null)
  })
})

describe("isAtspiTerminalWindow", () => {
  test("matches ghostty by path marker even with unnamed app", () => {
    expect(isAtspiTerminalWindow("Unnamed", "/com/mitchellh/ghostty/a11y/99610c12")).toBe(true)
  })

  test("matches known terminals by app name", () => {
    expect(isAtspiTerminalWindow("konsole", "/org/a11y/atspi/accessible/1")).toBe(true)
    expect(isAtspiTerminalWindow("Ghostty", "/org/a11y/atspi/accessible/1")).toBe(true)
  })

  test("matches gnome-terminal-server AT-SPI alias", () => {
    expect(isAtspiTerminalWindow("gnome-terminal-server", "/org/a11y/atspi/accessible/1")).toBe(true)
    expect(isAtspiTerminalWindow("GNOME-Terminal-Server", "/org/a11y/atspi/accessible/1")).toBe(true)
  })

  test("rejects browsers and other apps", () => {
    expect(isAtspiTerminalWindow("Google Chrome", "/org/a11y/atspi/accessible/1")).toBe(false)
    expect(isAtspiTerminalWindow("Unnamed", "/org/a11y/atspi/accessible/1")).toBe(false)
    expect(isAtspiTerminalWindow(null, "/org/a11y/atspi/accessible/1")).toBe(false)
  })
})

describe("isLinuxTerminalFocused with atspi keys", () => {
  test("suppresses when cached and current atspi keys match", () => {
    expect(
      isLinuxTerminalFocused({
        cachedWindowId: "atspi::1.10@/com/mitchellh/ghostty/a11y/99610c12",
        currentWindowId: "atspi::1.10@/com/mitchellh/ghostty/a11y/99610c12",
        wezTermPaneActive: true,
        tmuxPaneActive: null,
      })
    ).toBe(true)
  })

  test("notifies when a different ghostty window is focused", () => {
    expect(
      isLinuxTerminalFocused({
        cachedWindowId: "atspi::1.10@/com/mitchellh/ghostty/a11y/aaaa",
        currentWindowId: "atspi::1.10@/com/mitchellh/ghostty/a11y/bbbb",
        wezTermPaneActive: true,
        tmuxPaneActive: null,
      })
    ).toBe(false)
  })

  test("notifies when same generic path comes from a different bus (identity collision)", () => {
    expect(
      isLinuxTerminalFocused({
        cachedWindowId: "atspi::1.45@/org/a11y/atspi/accessible/1",
        currentWindowId: "atspi::1.2626@/org/a11y/atspi/accessible/1",
        wezTermPaneActive: true,
        tmuxPaneActive: null,
      })
    ).toBe(false)
  })
})

describe("buildOsascriptActivateAppArgs", () => {
  test("escapes app names before putting them in AppleScript source", () => {
    const appName = 'App"bad'
    const args = buildOsascriptActivateAppArgs(appName)
    expect(args[0]).toBe("-e")
    expect(args[1]).toBe('tell application "App\\"bad" to activate')
  })

  test("removes control characters from app names", () => {
    const args = buildOsascriptActivateAppArgs("Terminal\n; do shell script \"touch pwned\"")
    expect(args[1]).toBe('tell application "Terminal; do shell script \\"touch pwned\\"" to activate')
  })
})
