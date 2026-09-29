import { basename } from "path"
import { loadConfig } from "./config"
import type { EventType, NotifierConfig } from "./config"
import { extractAgentNameFromSessionTitle, handleEvent, shouldResolveAgentNameForEvent } from "./delivery"
import { shouldSuppressPermissionAlert, prunePermissionAlertState } from "./permission-dedupe"

// Allow immediate auto-approval to settle before checking the pending list.
export const PERMISSION_PENDING_GRACE_MS = 300
const IDLE_COMPLETE_DELAY_MS = 350

export interface SessionInfo {
  // A failed lookup must never turn a deleted child into a parent.
  isChild: boolean | null
  title: string | null
  agentName?: string | null
}

export interface SessionAccess {
  info(sessionID: string): Promise<SessionInfo>
  elapsed(sessionID: string, now: number): Promise<number | null>
  permissionPending(sessionID: string | null, permissionID: string): Promise<boolean>
}

export type Delivery = "all" | "terminal" | "command"

// Each host instance owns its timers and session state. The adapters only translate API data.
export function createNotifier(access: SessionAccess, directory: string, delivery: Delivery = "all") {
  const children = new Set<string>()
  const sequences = new Map<string, number>()
  const errors = new Set<string>()
  const touched = new Map<string, number>()
  const idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const parents = new Map<string, string>()
  const running = new Set<string>()
  const pending = new Map<string, { sequence: number; title: string | null; timer: ReturnType<typeof setTimeout> }>()
  let disposed = false

  function config(): NotifierConfig {
    const value = loadConfig()
    if (delivery === "all") return value
    const local = structuredClone(value)
    if (delivery === "command") {
      local.suppressWhenFocused = false
      for (const event of Object.values(local.events)) {
        event.notification = false
        event.sound = false
        event.bell = false
      }
    } else {
      local.command.enabled = false
    }
    return local
  }

  function invalidate(sessionID: string): number {
    touched.set(sessionID, Date.now())
    const sequence = (sequences.get(sessionID) ?? 0) + 1
    sequences.set(sessionID, sequence)
    clearTimeout(idleTimers.get(sessionID))
    idleTimers.delete(sessionID)
    const deferred = pending.get(sessionID)
    if (deferred) clearTimeout(deferred.timer)
    pending.delete(sessionID)
    return sequence
  }

  async function notify(event: EventType, sessionID: string | null = null, title?: string | null, now = Date.now()) {
    if (disposed) return
    const current = config()
    // Do not count a server event that has no command to deliver.
    if (delivery === "command" && (!current.command.enabled || !current.command.path || !current.events[event].command)) return
    const lifecycleEvent = event === "session_started" || event === "user_message"
    let elapsed: number | null = null
    if (!lifecycleEvent && sessionID && (current.minDuration > 0 || (current.command.enabled && (current.command.minDuration ?? 0) > 0))) {
      elapsed = await access.elapsed(sessionID, now)
    }
    let sessionTitle = title ?? null
    let agentName: string | null = null
    if (!lifecycleEvent && sessionID && ((!sessionTitle && current.showSessionTitle) || shouldResolveAgentNameForEvent(current, event))) {
      const info = await access.info(sessionID)
      sessionTitle ??= info.title
      agentName = info.agentName ?? null
    }
    if (disposed) return
    const project = directory ? (current.showFullPath ? directory : basename(directory)) : null
    await handleEvent(current, event, project, elapsed, sessionTitle, sessionID, agentName ?? extractAgentNameFromSessionTitle(sessionTitle))
  }

  function track(sessionID: string, parentID?: string | null) {
    touched.set(sessionID, Date.now())
    if (parentID) {
      children.add(sessionID)
      parents.set(sessionID, parentID)
    }
  }

  function hasRunningChildren(parentID: string): boolean {
    for (const id of running) {
      const seen = new Set<string>([id])
      let ancestor = parents.get(id)
      while (ancestor && !seen.has(ancestor)) {
        if (ancestor === parentID) return true
        seen.add(ancestor)
        ancestor = parents.get(ancestor)
      }
    }
    return false
  }

  async function flushPending(): Promise<void> {
    for (const [id, deferred] of pending) {
      if (hasRunningChildren(id)) continue
      pending.delete(id)
      clearTimeout(deferred.timer)
      if (!disposed && sequences.get(id) === deferred.sequence) {
        await notify("complete", id, deferred.title)
      }
    }
  }

  async function complete(sessionID: string, sequence: number, now: number) {
    if (disposed || sequences.get(sessionID) !== sequence) return
    if (errors.delete(sessionID)) return
    if (children.has(sessionID)) {
      await notify("subagent_complete", sessionID, null, now)
      return
    }
    const info = await access.info(sessionID)
    if (disposed || sequences.get(sessionID) !== sequence || errors.delete(sessionID)) return
    if (info.isChild === null) return
    if (info.isChild) children.add(sessionID)
    const current = config()
    if (!info.isChild && current.deferCompleteUntilChildrenIdle && hasRunningChildren(sessionID)) {
      // Expiry drops the pending alert; it must not claim completion while work is still active.
      const timer = setTimeout(() => pending.delete(sessionID), current.deferredCompleteTimeout)
      timer.unref()
      pending.set(sessionID, { sequence, title: info.title, timer })
      return
    }
    await notify(info.isChild ? "subagent_complete" : "complete", sessionID, info.title, now)
  }

  // Bound tombstones and run state without discarding a live lookup or pending idle.
  const cleanup = setInterval(() => {
    const cutoff = Date.now() - 5 * 60_000
    prunePermissionAlertState(cutoff)
    for (const [id, lastSeen] of touched) {
      if (lastSeen >= cutoff || idleTimers.has(id) || running.has(id) || pending.has(id) || hasRunningChildren(id)) continue
      touched.delete(id)
      children.delete(id)
      sequences.delete(id)
      errors.delete(id)
      parents.delete(id)
    }
  }, 5 * 60_000)
  cleanup.unref()

  return {
    notify,
    track,
    async created(id: string | null, parentID: string | null, title: string | null) {
      if (id) track(id, parentID)
      if (id && parentID) running.add(id)
      if (!parentID) await notify("session_started", id, title)
    },
    busy(id: string) {
      invalidate(id)
      errors.delete(id)
      running.add(id)
    },
    async idle(id: string | null, immediate = true) {
      if (disposed) return
      if (!id) return notify("complete")
      const sequence = invalidate(id)
      running.delete(id)
      const now = Date.now()
      if (immediate) {
        await complete(id, sequence, now)
        await flushPending()
        return
      }
      idleTimers.set(id, setTimeout(() => {
        idleTimers.delete(id)
        void complete(id, sequence, now).then(flushPending).catch(() => undefined)
      }, IDLE_COMPLETE_DELAY_MS))
    },
    async stopped(id: string) {
      invalidate(id)
      running.delete(id)
      await flushPending()
    },
    async failed(id: string | null, event: "error" | "user_cancelled") {
      if (id) {
        invalidate(id)
        errors.add(id)
        running.delete(id)
      }
      await notify(event, id)
      await flushPending()
    },
    async permission(id: string | null, requestID: string | null, legacyHook = false) {
      if (requestID) {
        await new Promise(resolve => setTimeout(resolve, PERMISSION_PENDING_GRACE_MS))
        if (disposed || !(await access.permissionPending(id, requestID))) return
      }
      if (disposed) return
      // V1 has two permission sources. V2 adapters dedupe by request identity.
      if (legacyHook && shouldSuppressPermissionAlert(id)) return
      await notify("permission", id)
    },
    async userMessage(id: string | null, verifyParent = false) {
      if (id && children.has(id)) return
      if (id && verifyParent) {
        const info = await access.info(id)
        if (info.isChild !== false) return
      }
      await notify("user_message", id)
    },
    dispose() {
      disposed = true
      clearInterval(cleanup)
      for (const timer of idleTimers.values()) clearTimeout(timer)
      idleTimers.clear()
      children.clear()
      sequences.clear()
      errors.clear()
      touched.clear()
      for (const deferred of pending.values()) clearTimeout(deferred.timer)
      pending.clear()
      parents.clear()
      running.clear()
    },
  }
}
