import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, join } from "path"

const directory = mkdtempSync(join(tmpdir(), "notifier-gnome-test-"))
const log = join(directory, "calls.jsonl")
const windowID = "12345678-1234-1234-1234-123456789abc:42"
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.skipIf(process.platform !== "linux")("GNOME jump-back activates the captured window through the Shell bridge", async () => {
  const gdbus = join(directory, "gdbus")
  writeFileSync(gdbus, `#!${process.execPath}
import { appendFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args)+"\\n")
const method = args[args.indexOf("--method")+1]
if (method.endsWith(".CaptureWindow")) console.log("('${windowID}',)")
else if (method.endsWith(".ActivateWindow")) console.log("(true,)")
else process.exitCode = 1
`)
  chmodSync(gdbus, 0o755)
  const modulePath = join(import.meta.dir, "focus.ts")
  const child = Bun.spawn([process.execPath, "--eval", `const { focusTerminal } = await import(${JSON.stringify(modulePath)}); await focusTerminal()`], {
    env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, WAYLAND_DISPLAY: "wayland-test",
      XDG_CURRENT_DESKTOP: "GNOME", KDE_SESSION_VERSION: "", HYPRLAND_INSTANCE_SIGNATURE: "", SWAYSOCK: "", NIRI_SOCKET: "" },
    stdout: "pipe", stderr: "pipe",
  })
  const errors = await new Response(child.stderr).text()
  expect(await child.exited, errors).toBe(0)
  const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
  expect(calls.some(args => args.includes("org.gnome.Shell.Extensions.OpenCodeNotifier.ActivateWindow") && args.includes(windowID))).toBe(true)
})

test("the Shell extension selects the captured window and rejects IDs from an earlier enable cycle", () => {
  const source = readFileSync(join(import.meta.dir, "../gnome-shell-extension/extension.js"), "utf8")
    .replace(/^import .*\n/gm, "").replace("export default class", "return class")
  const first = { get_stable_sequence: () => 42 }
  const second = { get_stable_sequence: () => 43 }
  let focused = first
  const activated: object[] = []
  let generation = 0
  let exported = false
  const ExtensionClass = new Function("Gio", "GLib", "Main", "Extension", "global", source)(
    { DBus: { session: {} }, DBusExportedObject: { wrapJSObject: () => ({
      export: () => { exported = true }, unexport: () => { exported = false },
    }) } },
    { uuid_string_random: () => `generation-${++generation}` },
    { activateWindow: (window: object) => activated.push(window) }, class {},
    { display: { get_focus_window: () => focused }, get_window_actors: () => [first, second].map(meta_window => ({ meta_window })) },
  )
  const extension = new ExtensionClass()
  extension.enable()
  const captured = extension.CaptureWindow()
  focused = second
  expect(extension.ActivateWindow(captured)).toBe(true)
  expect(activated).toEqual([first])
  expect(extension.ActivateWindow("generation-1:999")).toBe(false)
  extension.disable()
  expect(exported).toBe(false)
  extension.enable()
  expect(extension.ActivateWindow(captured)).toBe(false)
  extension.disable()
})
