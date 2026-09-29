import { afterAll, afterEach, beforeEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { NotifierPlugin } from "./index"

const directory = mkdtempSync(join(tmpdir(), "notifier-v1-command-test-"))
const configPath = join(directory, "config.json")
let originalConfigPath: string | undefined
let originalClient: string | undefined

beforeEach(() => {
  originalConfigPath = process.env.OPENCODE_NOTIFIER_CONFIG_PATH
  originalClient = process.env.OPENCODE_CLIENT
  process.env.OPENCODE_NOTIFIER_CONFIG_PATH = configPath
  process.env.OPENCODE_CLIENT = "cli"
})

afterEach(() => {
  if (originalConfigPath === undefined) delete process.env.OPENCODE_NOTIFIER_CONFIG_PATH
  else process.env.OPENCODE_NOTIFIER_CONFIG_PATH = originalConfigPath
  if (originalClient === undefined) delete process.env.OPENCODE_CLIENT
  else process.env.OPENCODE_CLIENT = originalClient
})

afterAll(() => rmSync(directory, { recursive: true, force: true }))

test.each(["question", "plan_exit"])("V1 %s commands receive the triggering session ID", async (tool) => {
  const output = join(directory, `${tool}.json`)
  writeFileSync(configPath, JSON.stringify({
    suppressWhenFocused: false, notification: false, sound: false, bell: false,
    events: { client_connected: false },
    command: {
      enabled: true,
      path: process.execPath,
      args: ["--eval", 'require("node:fs").writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))', output, "{event}", "{sessionID}"],
    },
  }))
  // These hooks do not query the client when titles and duration filtering are disabled.
  const plugin = await NotifierPlugin({ client: {}, directory } as Parameters<typeof NotifierPlugin>[0])
  try {
    if (!plugin["tool.execute.before"]) throw new Error("missing tool hook")
    await plugin["tool.execute.before"]({ tool, sessionID: "ses_v1_command", callID: "call_1" }, { args: {} })
    for (let attempt = 0; attempt < 100 && !existsSync(output); attempt++) await Bun.sleep(10)
    expect(JSON.parse(readFileSync(output, "utf8"))).toEqual([tool, "ses_v1_command"])
  } finally {
    await plugin.dispose?.()
  }
})
