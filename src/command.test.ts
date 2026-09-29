import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runCommand } from "./command"
import { loadConfig } from "./config"

const directory = mkdtempSync(join(tmpdir(), "notifier-command-test-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function runAndRead(args: string[], sessionID?: string | null): Promise<string> {
  const output = join(directory, `${crypto.randomUUID()}.txt`)
  const config = {
    ...loadConfig(),
    command: {
      enabled: true,
      path: process.execPath,
      args: ["--eval", 'require("node:fs").writeFileSync(process.argv[1], process.argv.slice(2).join("|"))', output, ...args],
    },
  }
  runCommand(config, "permission", "done", "Fix bug", null, "project", null, null, sessionID)
  for (let attempts = 0; attempts < 100; attempts++) {
    if (existsSync(output) && readFileSync(output, "utf8").length > 0) break
    await Bun.sleep(10)
  }
  return readFileSync(output, "utf8")
}

test("runCommand substitutes {sessionID} in args", async () => {
  expect(await runAndRead(["{event}", "{sessionID}"], "ses_abc123")).toBe("permission|ses_abc123")
})

test("runCommand substitutes an empty {sessionID} when there is no session", async () => {
  expect(await runAndRead(["{event}", "{sessionID}"], null)).toBe("permission|")
})
