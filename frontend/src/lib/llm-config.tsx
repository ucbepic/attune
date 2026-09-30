"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"
import { toast } from "sonner"
import { getEndpoint } from "@/lib/api"

export interface LlmConfig {
  model: string
  env: Record<string, string>
}

export interface ServerLlmStatus {
  configured: boolean
  model: string | null
}

const EMPTY_CONFIG: LlmConfig = { model: "", env: {} }
const UNKNOWN_SERVER_STATUS: ServerLlmStatus = { configured: false, model: null }

let _store: LlmConfig = EMPTY_CONFIG
let _serverStatus: ServerLlmStatus = UNKNOWN_SERVER_STATUS
let _openSettings: (() => void) | null = null

function hasUsableConfig(config: LlmConfig): boolean {
  return (
    !!config.model.trim() &&
    Object.values(config.env).some((v) => v.trim() !== "")
  )
}

export function hasLlmConfig(): boolean {
  return hasUsableConfig(_store) || _serverStatus.configured
}

async function fetchServerStatus(): Promise<ServerLlmStatus> {
  try {
    const response = await fetch(getEndpoint("/llm-config"))
    if (!response.ok) return UNKNOWN_SERVER_STATUS
    const data = await response.json()
    return {
      configured: Boolean(data?.configured),
      model: typeof data?.model === "string" ? data.model : null,
    }
  } catch {
    return UNKNOWN_SERVER_STATUS
  }
}

export function getLlmConfigHeader(): string | null {
  if (!hasUsableConfig(_store)) return null
  const env = Object.fromEntries(
    Object.entries(_store.env).filter(([, v]) => v.trim() !== "")
  )
  return JSON.stringify({ model: _store.model.trim(), env })
}

export function openLlmSettings() {
  _openSettings?.()
}

export class MissingApiKeysError extends Error {
  constructor() {
    super("No API keys configured")
    this.name = "MissingApiKeysError"
  }
}

export function isMissingApiKeysError(error: unknown): boolean {
  return (
    error instanceof MissingApiKeysError ||
    (error instanceof Error && error.name === "MissingApiKeysError")
  )
}

export function notifyNoApiKeys() {
  toast.error("No API Keys Found", {
    id: "no-api-keys",
    duration: Infinity,
    description: "Add your API keys to begin scoring: Edit › Edit API Keys.",
    action: { label: "Add keys", onClick: () => _openSettings?.() },
    actionButtonStyle: { background: "#4baeae", color: "#fff" },
  })
}

interface LlmConfigContextValue {
  config: LlmConfig
  isConfigured: boolean
  serverStatus: ServerLlmStatus
  saveConfig: (config: LlmConfig) => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  openSettings: () => void
}

const LlmConfigContext = createContext<LlmConfigContextValue | null>(null)

export function LlmConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<LlmConfig>(_store)
  const [serverStatus, setServerStatus] = useState<ServerLlmStatus>(_serverStatus)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const openSettings = useCallback(() => setSettingsOpen(true), [])

  useEffect(() => {
    _openSettings = openSettings
    return () => {
      _openSettings = null
    }
  }, [openSettings])

  const saveConfig = useCallback((next: LlmConfig) => {
    _store = next
    setConfig(next)
    toast.dismiss("no-api-keys")
  }, [])

  useEffect(() => {
    let cancelled = false
    fetchServerStatus().then((status) => {
      if (cancelled) return
      _serverStatus = status
      setServerStatus(status)
      if (!hasLlmConfig()) notifyNoApiKeys()
    })
    return () => {
      cancelled = true
    }
  }, [])

  const value: LlmConfigContextValue = {
    config,
    isConfigured: hasUsableConfig(config) || serverStatus.configured,
    serverStatus,
    saveConfig,
    settingsOpen,
    setSettingsOpen,
    openSettings,
  }

  return (
    <LlmConfigContext.Provider value={value}>
      {children}
    </LlmConfigContext.Provider>
  )
}

export function useLlmConfig() {
  const ctx = useContext(LlmConfigContext)
  if (!ctx) {
    throw new Error("useLlmConfig must be used within an LlmConfigProvider")
  }
  return ctx
}
