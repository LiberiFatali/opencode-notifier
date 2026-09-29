import type { Plugin } from "@opencode/plugin"
import type { LocationRef, OpenCodeEvent } from "@opencode/client"
import { createNotifier } from "./notifier"
import type { Delivery } from "./notifier"

type Client = {
  session: Pick<Plugin.Context["session"], "get" | "context">
  permission: Pick<Plugin.Context["permission"], "list">
}

export function createV2Notifier(client: Client, location: LocationRef, delivery: Delivery) {
  const notifier = createNotifier({
    async info(sessionID) {
      try {
        const session = await client.session.get({ sessionID })
        return { isChild: !!session.parentID, title: session.title ?? null, agentName: session.parentID ? session.agent ?? null : null }
      } catch {
        return { isChild: null, title: null }
      }
    },
    async elapsed(sessionID, now) {
      try {
        const messages = await client.session.context({ sessionID })
        const times = messages.flatMap(message => message.type === "user" ? [message.time.created] : [])
        return times.length ? (now - Math.max(...times)) / 1000 : null
      } catch {
        return null
      }
    },
    async permissionPending(sessionID, permissionID) {
      if (!sessionID) return true
      try {
        return (await client.permission.list({ sessionID })).some(request => request.id === permissionID)
      } catch {
        return true
      }
    },
  }, location.directory, delivery)
  const seen = new Set<string>()
  let disposed = false

  function first(key: string) {
    if (seen.has(key)) return false
    seen.add(key)
    // Event identities bound replay dedupe without retaining whole event payloads.
    if (seen.size > 2048) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
    return true
  }

  return {
    connected: () => notifier.notify("client_connected"),
    async event(event: OpenCodeEvent) {
      try {
        if (disposed) return
        if (event.location) {
          const workspaceID = "workspaceID" in event.location ? event.location.workspaceID : undefined
          if (event.location.directory !== location.directory || workspaceID !== location.workspaceID) return
        }
        switch (event.type) {
          case "session.created":
            if (first(`created:${event.data.sessionID}`)) {
              await notifier.created(event.data.sessionID, event.data.parentID ?? null, event.data.title ?? null)
            }
            break
          case "session.execution.started":
            notifier.busy(event.data.sessionID)
            break
          case "session.execution.succeeded":
            if (first(`complete:${event.id}`)) await notifier.idle(event.data.sessionID)
            break
          case "session.execution.failed":
            if (first(`failed:${event.id}`)) await notifier.failed(event.data.sessionID, "error")
            break
          case "session.execution.interrupted":
            // Shutdown, supersession and inactivity are not user cancellations or failures.
            if (event.data.reason === "user" && first(`cancelled:${event.id}`)) {
              await notifier.failed(event.data.sessionID, "user_cancelled")
            } else if (event.data.reason !== "user" && first(`stopped:${event.id}`)) {
              await notifier.stopped(event.data.sessionID)
            }
            break
          case "session.deleted":
            await notifier.stopped(event.data.sessionID)
            break
          case "permission.asked":
            if (first(`permission:${event.data.id}`)) await notifier.permission(event.data.sessionID, event.data.id)
            break
          case "session.inbox.enqueued":
            if (event.data.item.type === "user" && first(`message:${event.data.inboxID}`)) {
              await notifier.userMessage(event.data.sessionID, true)
            }
            break
          case "form.created":
            if (event.data.form.metadata?.kind === "question" && first(`form:${event.data.form.id}`)) {
              await notifier.notify("question", event.data.form.sessionID)
            }
            break
          // V2 has no plan_exit tool; changing agents is not a plan-ready signal.
        }
      } catch {
        // Notification failures must not interrupt the host or event stream.
      }
    },
    dispose() {
      disposed = true
      notifier.dispose()
      seen.clear()
    },
  }
}

export const setupV2: Plugin.Plugin["setup"] = (ctx) => {
  const notifier = createV2Notifier(ctx, ctx.location, "command")
  void notifier.connected().catch(() => undefined)
  const controller = new AbortController()
  // This subscription also serves headless clients. Terminal delivery lives in ./tui.
  const task = (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        await notifier.event(event)
      }
    } catch {
      // Aborting or losing a subscription must not cause an unhandled rejection.
    }
  })()
  return async () => {
    notifier.dispose()
    controller.abort()
    await task
  }
}
