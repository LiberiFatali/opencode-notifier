import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runCommand } from "./command"

const directory = mkdtempSync(join(tmpdir(), "notifier-command-test-"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))

async function runAndRead(args: string[], sessionID?: string | null): Promise<string> {
  const output = join(directory, `${crypto.randomUUID()}.txt`)
  const config = {
    command: {
      enabled: true,
      path: "/bin/sh",
      args: ["-c", 'printf "%s|%s" "$1" "$2" > "$0"', output, ...args],
    },
  } as never
  runCommand(config, "permission", "done", "Fix bug", null, "project", null, null, sessionID)
  for (let attempts = 0; attempts < 100 && !existsSync(output); attempts++) await Bun.sleep(10)
  await Bun.sleep(20)
  return readFileSync(output, "utf8")
}

test("runCommand substitutes {sessionID} in args", async () => {
  expect(await runAndRead(["{event}", "{sessionID}"], "ses_abc123")).toBe("permission|ses_abc123")
})

test("runCommand substitutes an empty {sessionID} when there is no session", async () => {
  expect(await runAndRead(["{event}", "{sessionID}"], null)).toBe("permission|")
})
