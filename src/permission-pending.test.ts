import { describe, test, expect } from "bun:test"
import { getPermissionIDFromEvent, isPermissionStillPending } from "./index"

describe("getPermissionIDFromEvent", () => {
  test("reads properties.id", () => {
    expect(getPermissionIDFromEvent({ properties: { id: "per_123" } })).toBe("per_123")
  })

  test("falls back to properties.request.id", () => {
    expect(getPermissionIDFromEvent({ properties: { request: { id: "per_456" } } })).toBe("per_456")
  })

  test("returns null when no id is present", () => {
    expect(getPermissionIDFromEvent({ properties: {} })).toBe(null)
    expect(getPermissionIDFromEvent({})).toBe(null)
  })
})

describe("isPermissionStillPending", () => {
  const pendingClient = (ids: string[]) => ({ _client: { get: async () => ids.map((id) => ({ id })) } })

  test("true when the request is still pending", async () => {
    await expect(isPermissionStillPending(pendingClient(["per_1", "per_2"]), "per_2")).resolves.toBe(true)
  })

  test("false when the request was auto-approved (no longer pending)", async () => {
    await expect(isPermissionStillPending(pendingClient(["per_1"]), "per_2")).resolves.toBe(false)
    await expect(isPermissionStillPending(pendingClient([]), "per_2")).resolves.toBe(false)
  })

  test("reads the session-scoped raw client", async () => {
    const client = { session: { _client: { get: async () => [{ id: "per_9" }] } } }
    await expect(isPermissionStillPending(client, "per_9")).resolves.toBe(true)
  })

  test("fails open on every lookup failure", async () => {
    await expect(isPermissionStillPending(null, "per_1")).resolves.toBe(true)
    await expect(isPermissionStillPending({}, "per_1")).resolves.toBe(true)
    await expect(isPermissionStillPending({ _client: {} }, "per_1")).resolves.toBe(true)
    await expect(isPermissionStillPending({ _client: { get: async () => { throw new Error("down") } } }, "per_1")).resolves.toBe(true)
    await expect(isPermissionStillPending({ _client: { get: async () => ({ unexpected: "shape" }) } }, "per_1")).resolves.toBe(true)
  })

  test("handles the data-envelope response shape", async () => {
    const client = { _client: { get: async () => ({ data: [{ id: "per_3" }] }) } }
    await expect(isPermissionStillPending(client, "per_3")).resolves.toBe(true)
    await expect(isPermissionStillPending(client, "per_other")).resolves.toBe(false)
  })
})
