"use client"

import { useEffect, useRef, useState } from "react"
import { toast } from "sonner"
import { Plus, Eye, EyeOff } from "lucide-react"

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { useLlmConfig, type LlmConfig } from "@/lib/llm-config"

const DEFAULT_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AZURE_API_KEY",
  "AZURE_API_BASE",
  "AZURE_API_VERSION",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
]

interface EnvRow {
  id: number
  name: string
  value: string
}

function isSecret(name: string): boolean {
  return /key|token|secret/i.test(name) && !/base|version|endpoint|url|host|region|deployment/i.test(name)
}

function buildInitialRows(config: LlmConfig, nextId: () => number): EnvRow[] {
  const rows: EnvRow[] = DEFAULT_ENV_KEYS.map((name) => ({
    id: nextId(),
    name,
    value: config.env[name] ?? "",
  }))
  for (const [name, value] of Object.entries(config.env)) {
    if (!DEFAULT_ENV_KEYS.includes(name)) {
      rows.push({ id: nextId(), name, value })
    }
  }
  return rows
}

export default function EditSettingsDialog() {
  const { config, saveConfig, settingsOpen, setSettingsOpen, serverStatus } = useLlmConfig()
  const idRef = useRef(0)
  const nextId = () => ++idRef.current

  const [model, setModel] = useState("")
  const [rows, setRows] = useState<EnvRow[]>([])
  const [showValues, setShowValues] = useState(false)

  useEffect(() => {
    if (settingsOpen) {
      setModel(config.model)
      setRows(buildInitialRows(config, nextId))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsOpen])

  useEffect(() => {
    if (!settingsOpen) {
      document.body.style.pointerEvents = ""
    }
  }, [settingsOpen])

  const updateRow = (id: number, patch: Partial<EnvRow>) =>
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const removeRow = (id: number) =>
    setRows((prev) => prev.filter((r) => r.id !== id))

  const addRow = () =>
    setRows((prev) => [...prev, { id: nextId(), name: "", value: "" }])

  const handleSave = () => {
    const trimmedModel = model.trim()
    if (!trimmedModel) {
      toast.error("Please enter a model name (e.g. openai/gpt-4o).")
      return
    }
    const env: Record<string, string> = {}
    for (const row of rows) {
      const name = row.name.trim()
      const value = row.value.trim()
      if (name && value) env[name] = value
    }
    if (Object.keys(env).length === 0) {
      toast.error("Please enter at least one API key.")
      return
    }
    saveConfig({ model: trimmedModel, env })
    setSettingsOpen(false)
    toast.success("API keys saved for this session.")
  }

  return (
    <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto p-5">
        <DialogTitle className="text-base text-[#003953]">Edit API Keys</DialogTitle>
        <DialogDescription className="text-xs">
          Set the model and API keys for your LLM provider. If you need a different provider or model, you can see {" "}
          <a
            href="https://docs.litellm.ai/docs/providers"
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 text-[#0c5c84] hover:text-[#003953]"
          >
            LiteLLM's provider list
          </a>
          .
        </DialogDescription>
        {serverStatus.configured && (
          <p className="text-xs text-pink-700" style={{ marginTop: "1rem" }}>
            The backend is already configured with {serverStatus.model ?? "a model"} using your local .env file. Keys entered here override it for this browser session only.
          </p>
        )}

        <div className="mt-3 space-y-1">
          <Label htmlFor="llm-model" className="text-xs text-[#003953]">Model</Label>
          <Input
            id="llm-model"
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder="openai/gpt-4o, anthropic/claude-sonnet-4-6, ..."
            autoComplete="on"
            className="h-8 text-xs"
          />
        </div>

        <div className="mt-3 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs text-[#003953]">API Keys</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 px-2 text-xs text-muted-foreground"
              onClick={() => setShowValues((v) => !v)}
            >
              {showValues ? (
                <EyeOff className="h-3.5 w-3.5 mr-1" />
              ) : (
                <Eye className="h-3.5 w-3.5 mr-1" />
              )}
              {showValues ? "Hide" : "Show"}
            </Button>
          </div>
          {rows.map((row) => (
            <div key={row.id} className="grid grid-cols-2 gap-2">
              <Input
                value={row.name}
                onChange={(e) => updateRow(row.id, { name: e.target.value })}
                placeholder="VARIABLE_NAME"
                autoComplete="off"
                spellCheck={false}
                className="h-8 font-mono text-xs"
              />
              <Input
                value={row.value}
                onChange={(e) => updateRow(row.id, { value: e.target.value })}
                placeholder="Enter value"
                type={showValues || !isSecret(row.name) ? "text" : "password"}
                autoComplete="off"
                spellCheck={false}
                className="h-8 text-xs"
              />
            </div>
          ))}

          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={addRow}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Custom Key
          </Button>
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            className="border-[#fccddd] bg-[#fccddd] text-[#003953] hover:bg-[#f9b8ce] hover:text-[#003953]"
            onClick={() => setSettingsOpen(false)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            className="bg-[#4baeae] text-white hover:bg-[#3d9999]"
            onClick={handleSave}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
