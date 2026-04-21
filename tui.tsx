/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { spawn } from "node:child_process"
import { createEffect, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"

type PluginOptions = {
  codexBinary?: string
  refreshMs?: number
}

type RateLimitWindow = {
  usedPercent?: number
  windowDurationMins?: number | null
  resetsAt?: number | null
}

type RateLimitCredits = {
  hasCredits?: boolean
  unlimited?: boolean
  balance?: string | null
}

type RateLimitSnapshot = {
  limitId?: string | null
  limitName?: string | null
  primary?: RateLimitWindow | null
  secondary?: RateLimitWindow | null
  credits?: RateLimitCredits | null
  planType?: string | null
}

type RateLimitResponse = {
  rateLimits?: RateLimitSnapshot | null
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot> | null
}

type RateLimitData = {
  fetchedAt: number
  snapshots: RateLimitSnapshot[]
}

type RateLimitState =
  | {
      status: "loading"
      data?: RateLimitData
    }
  | {
      status: "ready"
      data: RateLimitData
    }
  | {
      status: "error"
      message: string
      data?: RateLimitData
    }

const id = "opencode-plugin-codex-usage"
const BAR_WIDTH = 20
const MIN_REFRESH_MS = 15000
const DEFAULT_REFRESH_MS = 30000

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    if (error.message.includes("ENOENT")) return "codex CLI not found"
    return error.message
  }

  return String(error)
}

function getRefreshMs(options: PluginOptions | undefined) {
  if (typeof options?.refreshMs !== "number" || !Number.isFinite(options.refreshMs)) return DEFAULT_REFRESH_MS
  return Math.max(MIN_REFRESH_MS, Math.floor(options.refreshMs))
}

function durationLabel(window: RateLimitWindow | null | undefined, fallback: string) {
  const minutes = window?.windowDurationMins
  if (!minutes) return fallback
  if (minutes === 10080) return "Weekly"
  if (minutes === 43200) return "Monthly"
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function percentLeft(window: RateLimitWindow | null | undefined) {
  const used = window?.usedPercent ?? 0
  return Math.max(0, Math.min(100, Math.round(100 - used)))
}

function progressBar(remaining: number) {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round((remaining / 100) * BAR_WIDTH)))
  return `[${"#".repeat(filled)}${"-".repeat(BAR_WIDTH - filled)}]`
}

function resetLabel(timestamp: number | null | undefined) {
  if (!timestamp) return "reset time unavailable"

  const date = new Date(timestamp * 1000)
  if (Number.isNaN(date.getTime())) return "reset time unavailable"

  const time = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)
  const day = new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(date)

  return `resets ${time} on ${day}`
}

function titleCase(part: string) {
  if (!part) return part
  if (/^gpt$/i.test(part)) return "GPT"
  if (/^codex$/i.test(part)) return "Codex"
  if (/^[0-9.]+$/.test(part)) return part
  return part.charAt(0).toUpperCase() + part.slice(1)
}

function snapshotName(snapshot: RateLimitSnapshot) {
  const raw = snapshot.limitName?.trim() || snapshot.limitId?.trim() || "codex"
  return raw
    .replace(/_/g, "-")
    .split("-")
    .map(titleCase)
    .join("-")
}

function snapshotOrder(snapshot: RateLimitSnapshot) {
  if ((snapshot.limitId || "codex").toLowerCase() === "codex") return ""
  return snapshotName(snapshot).toLowerCase()
}

function normalizeSnapshots(result: RateLimitResponse) {
  const snapshots = Object.values(result.rateLimitsByLimitId || {})
  if (snapshots.length > 0) {
    return snapshots.sort((a, b) => snapshotOrder(a).localeCompare(snapshotOrder(b)))
  }

  return result.rateLimits ? [result.rateLimits] : []
}

async function fetchRateLimits(codexBinary: string) {
  return new Promise<RateLimitData>((resolve, reject) => {
    const child = spawn(codexBinary, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    let settled = false
    const timeout = setTimeout(() => finish(new Error("timed out while reading Codex usage")), 15000)

    const finish = (error?: Error, result?: RateLimitData) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      child.kill()
      if (error) {
        reject(error)
        return
      }
      if (result) {
        resolve(result)
        return
      }
      reject(new Error(stderr || "Codex returned no usage data"))
    }

    const send = (message: Record<string, unknown>) => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }

    child.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))))
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
      const lines = stdout.split(/\r?\n/)
      stdout = lines.pop() ?? ""

      for (const line of lines) {
        if (!line.trim()) continue

        try {
          const message = JSON.parse(line) as {
            id?: number
            result?: RateLimitResponse
            error?: { message?: string }
          }

          if (message.id === 1) {
            send({ method: "initialized", params: {} })
            send({ method: "account/rateLimits/read", id: 2 })
            continue
          }

          if (message.id !== 2) continue
          if (message.error?.message) {
            finish(new Error(message.error.message))
            return
          }

          finish(undefined, {
            fetchedAt: Date.now(),
            snapshots: normalizeSnapshots(message.result || {}),
          })
          return
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
          return
        }
      }
    })
    child.on("exit", (code) => {
      if (!settled && code !== 0) finish(new Error(stderr || `codex exited with code ${code}`))
    })

    send({
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "opencode_codex_usage",
          title: "OpenCode Codex Usage",
          version: "0.1.0",
        },
      },
    })
  })
}

function SnapshotView(props: {
  snapshot: RateLimitSnapshot
  theme: () => TuiThemeCurrent
}) {
  const rows = () =>
    [
      props.snapshot.primary
        ? {
            key: "primary",
            label: `${durationLabel(props.snapshot.primary, "5h")} limit`,
            window: props.snapshot.primary,
          }
        : undefined,
      props.snapshot.secondary
        ? {
            key: "secondary",
            label: `${durationLabel(props.snapshot.secondary, "Weekly")} limit`,
            window: props.snapshot.secondary,
          }
        : undefined,
    ].filter((item): item is { key: string; label: string; window: RateLimitWindow } => !!item)

  const isPrimaryBucket = () => (props.snapshot.limitId || "codex").toLowerCase() === "codex"

  return (
    <box flexDirection="column" gap={1}>
      <Show when={!isPrimaryBucket()}>
        <text fg={props.theme().text}>
          <b>{snapshotName(props.snapshot)}</b>
        </text>
      </Show>
      <For each={rows()}>
        {(row) => {
          const remaining = percentLeft(row.window)
          return (
            <box flexDirection="column">
              <text fg={props.theme().textMuted}>{row.label}</text>
              <text fg={props.theme().text}>
                {progressBar(remaining)} {remaining}% left
              </text>
              <text fg={props.theme().textMuted}>{resetLabel(row.window.resetsAt)}</text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function View(props: { api: Parameters<TuiPlugin>[0]; options: PluginOptions | undefined; sessionID: string }) {
  const [state, setState] = createSignal<RateLimitState>({ status: "loading" })
  const theme = () => props.api.theme.current
  const codexBinary = props.options?.codexBinary || "codex"
  const refreshMs = getRefreshMs(props.options)

  let disposed = false
  let running = false
  let queued = false

  const refresh = async () => {
    if (running) {
      queued = true
      return
    }

    running = true
    try {
      const data = await fetchRateLimits(codexBinary)
      if (!disposed) setState({ status: "ready", data })
    } catch (error) {
      if (!disposed) {
        const previous = state().data
        setState({
          status: "error",
          message: errorMessage(error),
          ...(previous ? { data: previous } : {}),
        })
      }
    } finally {
      running = false
      if (queued && !disposed) {
        queued = false
        void refresh()
      }
    }
  }

  createEffect(() => {
    props.sessionID
    void refresh()
  })

  const stopIdle = props.api.event.on("session.idle", (event) => {
    if (event.properties.sessionID === props.sessionID) void refresh()
  })
  const interval = setInterval(() => {
    void refresh()
  }, refreshMs)

  onCleanup(() => {
    disposed = true
    clearInterval(interval)
    stopIdle()
  })

  const snapshots = () => state().data?.snapshots || []

  return (
    <box flexDirection="column" gap={1}>
      <text fg={theme().text}>
        <b>Usage Limits</b>
      </text>
      <Switch>
        <Match when={state().status === "error" && !state().data}>
          <text fg={theme().warning}>{state().message}</text>
        </Match>
        <Match when={state().status === "loading" && !state().data}>
          <text fg={theme().textMuted}>Loading Codex usage...</text>
        </Match>
        <Match when={snapshots().length === 0}>
          <text fg={theme().textMuted}>No Codex usage data available.</text>
        </Match>
        <Match when={snapshots().length > 0}>
          <For each={snapshots()}>{(snapshot) => <SnapshotView snapshot={snapshot} theme={theme} />}</For>
        </Match>
      </Switch>
      <Show when={state().status === "error" && state().data}>
        <text fg={theme().warning}>refresh failed: {state().message}</text>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api, options) => {
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} options={options as PluginOptions | undefined} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id,
  tui,
}

export default plugin
