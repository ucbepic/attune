"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react"
import { toast } from "sonner"

export interface LlmConfig {
  model: string
  env: Record<string, string>
}

const EMPTY_CONFIG: LlmConfig = { model: "", env: {} }

let _store: LlmConfig = EMPTY_CONFIG
let _openSettings: (() => void) | null = null

function hasUsableConfig(config: LlmConfig): boolean {
  return (
    !!config.model.trim() &&
    Object.values(config.env).some((v) => v.trim() !== "")
  )
}

export function hasLlmConfig(): boolean {
  return hasUsableConfig(_store)
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
  saveConfig: (config: LlmConfig) => void
  settingsOpen: boolean
  setSettingsOpen: (open: boolean) => void
  openSettings: () => void
}

const LlmConfigContext = createContext<LlmConfigContextValue | null>(null)

export function LlmConfigProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState<LlmConfig>(_store)
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
    const timer = setTimeout(() => {
      if (!hasLlmConfig()) notifyNoApiKeys()
    }, 0)
    return () => clearTimeout(timer)
  }, [])

  const value: LlmConfigContextValue = {
    config,
    isConfigured: hasUsableConfig(config),
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
