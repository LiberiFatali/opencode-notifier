import { afterAll, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { delimiter, join } from "path"

const directory = mkdtempSync(join(tmpdir(), "notifier-action-test-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.skipIf(process.platform !== "linux")("Linux delivery finishes before a click, and duplicate or close actions do not invoke it again", async () => {
  const log = join(directory, "order.txt")
  const executable = join(directory, "notify-send")
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync } from "node:fs"
console.log("123")
setTimeout(() => {
  appendFileSync(${JSON.stringify(log)}, "click\\n")
  console.log("focus-terminal\\nfocus-terminal\\nclose")
}, 50)
setTimeout(() => process.exit(), 150)
`)
  chmodSync(executable, 0o755)
  const modulePath = join(import.meta.dir, "notify.ts")
  const script = `
    import { appendFileSync } from "node:fs"
    const { sendNotification } = await import(${JSON.stringify(modulePath)})
    let clicks = 0
    await sendNotification("OpenCode", "action test", 1, undefined, "osascript", false, () => { clicks++; throw new Error("callback failure") })
    appendFileSync(${JSON.stringify(log)}, "delivered\\n")
    await Bun.sleep(250)
    console.log(clicks)
  `
  const child = Bun.spawn([process.execPath, "--eval", script], {
    env: { ...process.env, PATH: `${directory}${delimiter}${process.env.PATH}`, DBUS_SESSION_BUS_ADDRESS: "fixture" },
    stdout: "pipe", stderr: "pipe",
  })
  const stdout = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited, stderr).toBe(0)
  expect(stdout.trim()).toBe("1")
  expect(readFileSync(log, "utf8")).toBe("delivered\nclick\n")
})
