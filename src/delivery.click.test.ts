import { afterAll, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, join } from "path"

const fixtureRoot = mkdtempSync(join(tmpdir(), "notifier-click-command-test-"))
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }))

for (const scenario of [
  { name: "click commands retain session context and run once on an explicit action", enabled: true, actions: "focus-terminal\nfocus-terminal\nclose", runs: true },
  { name: "closing a notification does not run its click command", enabled: true, actions: "close", runs: false },
  { name: "disabled click commands do not run", enabled: false, actions: "focus-terminal", runs: false },
]) test.skipIf(process.platform !== "linux")(scenario.name, async () => {
  const directory = mkdtempSync(join(fixtureRoot, "case-"))
  const output = join(directory, "argv.json")
  const calls = join(directory, "notifications.jsonl")
  const configPath = join(directory, "config.json")
  const executable = join(directory, "notify-send")
  const recorder = join(directory, "record.mjs")
  writeFileSync(recorder, 'import { appendFileSync } from "node:fs"; appendFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)) + "\\n")')
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs"
appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+"\\n")
console.log("123")
setTimeout(() => { console.log(${JSON.stringify(scenario.actions)}) }, 50)
setTimeout(() => process.exit(), 100)
`)
  chmodSync(executable, 0o755)
  writeFileSync(configPath, JSON.stringify({
    sound: false, bell: false, suppressWhenFocused: false, focusOnClick: false,
    command: { enabled: false },
    messages: { question: "Question for {sessionTitle}" },
    showSessionTitle: false,
    onClickCommand: { enabled: scenario.enabled, path: process.execPath, args: [recorder, output, "{event}", "{sessionID}", "{sessionTitle}"] },
  }))
  const notifierModule = join(import.meta.dir, "notifier.ts")
  const script = `
    const { createNotifier } = await import(${JSON.stringify(notifierModule)})
    const notifier = createNotifier({
      info: async () => ({ isChild: false, title: "$(not-a-shell-command)" }),
      elapsed: async () => null, permissionPending: async () => true,
    }, "project", "terminal")
    await notifier.notify("question", "ses_click")
    if ((await import("node:fs")).existsSync(${JSON.stringify(output)})) throw new Error("command ran before click")
    await Bun.sleep(250)
    notifier.dispose()
  `
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, DBUS_SESSION_BUS_ADDRESS: "fixture",
      OPENCODE_NOTIFIER_CONFIG_PATH: configPath, KDE_SESSION_VERSION: "", XDG_CURRENT_DESKTOP: "", DESKTOP_SESSION: "" },
    stdout: "pipe", stderr: "pipe",
  })
  const errors = await new Response(child.stderr).text()
  expect(await child.exited, errors).toBe(0)
  expect(existsSync(output)).toBe(scenario.runs)
  if (scenario.runs) expect(readFileSync(output, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([["question", "ses_click", "$(not-a-shell-command)"]])
  const args: string[] = JSON.parse(readFileSync(calls, "utf8").trim())
  expect(args.includes("focus-terminal=Run command")).toBe(scenario.enabled)
})
