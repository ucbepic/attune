"use client"

import { useState, useRef, useEffect, useCallback } from "react"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
} from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Send, LoaderCircle, Settings2, ChevronDown, ChevronUp, X, MessageSquare, Check, Pin, Fence, BarChart3, ListPlus, RotateCw, ArrowRightLeft } from "lucide-react"
import { toast } from "sonner"
import { apiFetch } from "@/hooks/use-scoring"
import { isMissingApiKeysError } from "@/lib/llm-config"


export interface FeedbackAction {
  type: "pin_examples" | "move_to_score" | "set_bounds" | "set_distribution" | "add_criteria"
  explanation: string
  items?: { id: string; score: number }[]
  bounds?: { id: string; min?: number | null; max?: number | null }[]
  criteria_filter?: { criterion: string; match?: boolean; operator?: string; value?: number | null; min?: number | null; max?: number | null }
  target_score?: number
  template?: string
  criteria?: { name: string; type: string; definition: string }[]
}

export interface ChatMessage {
  id: string
  role: "user" | "assistant" | "system"
  content: string
  timestamp: Date
  metadata?: {
    action?: "initial_score" | "refine" | "info"
    scoresUpdated?: boolean
    cost?: number
    contextIds?: (string | number)[]
    pendingActions?: FeedbackAction[]
    reasoning?: string
    actionsApplied?: boolean
  }
}


interface ChatPaneProps {
  task?: string
  minScore?: number
  maxScore?: number
  availableFields?: string[]
  selectedFields?: string[]
  sampleSize?: number | ""
  onSampleSizeChange?: (size: number | "") => void

  resetKey?: number

  data?: any[]
  criteria?: any[]
  isScoring?: boolean
  progress?: number
  progressStatus?: string
  comparisonGraphLength?: number

  selectedNodeIds?: Set<string | number>
  onSelectedNodeIdsChange?: (ids: Set<string | number>) => void

  onScore?: (formData: { task: string; min: number | ""; max: number | ""; sampleSize: number | ""; selectedFields: string[] }) => void
  onApplyActions?: (actions: FeedbackAction[]) => Promise<void>
  onCostAdd?: (cost: number) => void

  onRescore?: () => void
  isRescoring?: boolean
  canRescore?: boolean
  hasPendingChanges?: boolean

  mode?: "attune" | "probe"
  sampledIds?: (string | number)[]
  onPromptUpdate?: (prompt: string) => void
  onScoresUpdate?: (scores: Record<string, number>, cost: number, updatedPrompt?: string) => void
}


const ACTION_ICONS: Record<string, typeof Pin> = {
  pin_examples: Pin,
  move_to_score: ArrowRightLeft,
  set_bounds: Fence,
  set_distribution: BarChart3,
  add_criteria: ListPlus,
}

let chatPaneRuntimeCache: {
  messages: ChatMessage[]
  taskConfigured: boolean
  showTaskConfig: boolean
  showChat: boolean
} = {
  messages: [],
  taskConfigured: false,
  showTaskConfig: true,
  showChat: true,
}


const ChatPane = ({
  task: propTask,
  minScore: propMinScore,
  maxScore: propMaxScore,
  availableFields,
  selectedFields: propSelectedFields,
  sampleSize: propSampleSize = 40,
  onSampleSizeChange,
  resetKey,
  data,
  criteria,
  isScoring,
  progress,
  progressStatus,
  comparisonGraphLength,
  selectedNodeIds,
  onSelectedNodeIdsChange,
  onScore,
  onApplyActions,
  onCostAdd,
  onRescore,
  isRescoring = false,
  canRescore = false,
  hasPendingChanges = false,
  mode = "attune",
  sampledIds,
  onPromptUpdate,
  onScoresUpdate,
}: ChatPaneProps) => {
  const [messages, setMessages] = useState<ChatMessage[]>(() => chatPaneRuntimeCache.messages)
  const [inputValue, setInputValue] = useState("")
  const [isProcessing, setIsProcessing] = useState(false)
  const [isApplyingActions, setIsApplyingActions] = useState(false)
  const [taskConfigured, setTaskConfigured] = useState(() => chatPaneRuntimeCache.taskConfigured)
  const [showTaskConfig, setShowTaskConfig] = useState(() => chatPaneRuntimeCache.showTaskConfig)
  const [hasPromptUpdate, setHasPromptUpdate] = useState(false)
  const [showChat, setShowChat] = useState(() => chatPaneRuntimeCache.showChat)
  const [probeRefinementHistory, setProbeRefinementHistory] = useState<string[]>([])
  const [confirmRescoreOpen, setConfirmRescoreOpen] = useState(false)

  const [task, setTask] = useState("")
  const [min, setMin] = useState<number | "">("")
  const [max, setMax] = useState<number | "">("")
  const [selectedFieldsState, setSelectedFieldsState] = useState<string[]>([])
  const [fieldInput, setFieldInput] = useState("")
  const [showSuggestions, setShowSuggestions] = useState(false)
  const sampleSize = propSampleSize
  const setSampleSize = (value: number | "") => onSampleSizeChange?.(value)

  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionAnchor, setMentionAnchor] = useState<number | null>(null)

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const wasScoringRef = useRef(!!isScoring)

  useEffect(() => {
    if (propTask !== undefined) setTask(propTask)
    if (propMinScore !== undefined) setMin(propMinScore)
    if (propMaxScore !== undefined) setMax(propMaxScore)
    if (propSelectedFields) setSelectedFieldsState([...propSelectedFields])
  }, [propTask, propMinScore, propMaxScore, propSelectedFields])

  const prevResetKeyRef = useRef(resetKey)
  useEffect(() => {
    if (resetKey === prevResetKeyRef.current) return
    prevResetKeyRef.current = resetKey
    setMessages([{
      id: "welcome",
      role: "system",
      content: "Configure your scoring task above, then click **Run Initial Scoring**. After scoring, you can use this chat to describe any adjustments.",
      timestamp: new Date(),
    }])
    setTaskConfigured(false)
    setShowTaskConfig(true)
    setHasPromptUpdate(false)
    setProbeRefinementHistory([])
    setInputValue("")
  }, [resetKey])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [messages])

  useEffect(() => {
    chatPaneRuntimeCache = {
      messages,
      taskConfigured,
      showTaskConfig,
      showChat,
    }
  }, [messages, taskConfigured, showTaskConfig, showChat])

  useEffect(() => {
    const wasScoring = wasScoringRef.current
    const isCurrentlyScoring = !!isScoring

    if (wasScoring && !isCurrentlyScoring && taskConfigured) {
      setMessages(prev => [...prev, {
        id: `msg-${Date.now()}-score-complete`,
        role: "assistant",
        content: "Scoring complete. Describe adjustments below.",
        timestamp: new Date(),
        metadata: { action: "initial_score" },
      }])
    }

    wasScoringRef.current = isCurrentlyScoring
  }, [isScoring, taskConfigured])

  const didInitRef = useRef(false)
  useEffect(() => {
    if (!didInitRef.current && messages.length === 0) {
      didInitRef.current = true
      setMessages([{
        id: "welcome",
        role: "system",
        content: "Configure your scoring task above, then click **Run Initial Scoring**. After scoring, you can use this chat to describe any adjustments.",
        timestamp: new Date(),
      }])
    }
  }, [])

  const mentionCriteria = mentionQuery != null && criteria
    ? criteria.filter((c: any) => {
        const name = c.name || c.text || ""
        return name.toLowerCase().includes(mentionQuery.toLowerCase())
      })
    : []

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value
    setInputValue(val)

    const cursor = e.target.selectionStart ?? val.length
    const before = val.slice(0, cursor)
    const atIdx = before.lastIndexOf("@")
    if (atIdx >= 0 && (atIdx === 0 || before[atIdx - 1] === " " || before[atIdx - 1] === "\n")) {
      const query = before.slice(atIdx + 1)
      if (query.length > 60) {
        setMentionQuery(null)
        setMentionAnchor(null)
      } else {
        setMentionQuery(query)
        setMentionAnchor(atIdx)
        setMentionIndex(0)
      }
    } else {
      setMentionQuery(null)
      setMentionAnchor(null)
    }
  }, [])

  const insertMention = useCallback((criterionName: string) => {
    if (mentionAnchor == null) return
    const before = inputValue.slice(0, mentionAnchor)
    const afterCursor = inputRef.current?.selectionStart ?? (mentionAnchor + (mentionQuery?.length ?? 0) + 1)
    const after = inputValue.slice(afterCursor)
    const newVal = `${before}@${criterionName} ${after}`
    setInputValue(newVal)
    setMentionQuery(null)
    setMentionAnchor(null)
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus()
        const pos = before.length + criterionName.length + 2
        inputRef.current.setSelectionRange(pos, pos)
      }
    }, 0)
  }, [inputValue, mentionAnchor, mentionQuery])

  const showSampleSize = onSampleSizeChange !== undefined
  const isFormValid = task.trim() !== "" && min !== "" && max !== "" && (showSampleSize ? sampleSize !== "" : true)

  const addField = (field: string) => {
    if (field && !selectedFieldsState.includes(field)) {
      setSelectedFieldsState([...selectedFieldsState, field])
    }
    setFieldInput("")
    setShowSuggestions(false)
  }

  const removeField = (field: string) => {
    setSelectedFieldsState(selectedFieldsState.filter(f => f !== field))
  }

  const filteredFields = availableFields?.filter(
    field =>
      field.toLowerCase().includes(fieldInput.toLowerCase()) &&
      !selectedFieldsState.includes(field)
  ) || []


  const runInitialScore = useCallback(() => {
    if (!isFormValid) return

    const formData = { task, min, max, sampleSize, selectedFields: selectedFieldsState }
    setTaskConfigured(true)
    setShowTaskConfig(false)

    const configMessage: ChatMessage = {
      id: `msg-${Date.now()}`,
      role: "assistant",
      content: `**Running initial scoring...**\n${task}\n\nScore range: ${min}–${max}${showSampleSize ? ` | Sample: ${sampleSize}` : ''} | Fields: ${selectedFieldsState.join(", ")}`,
      timestamp: new Date(),
      metadata: { action: "initial_score" },
    }
    setMessages(prev => [...prev, configMessage])
    onScore?.(formData)
  }, [task, min, max, sampleSize, selectedFieldsState, isFormValid, onScore, showSampleSize])

  const hasExistingScores = (comparisonGraphLength ?? 0) > 0
  const handleInitialScore = useCallback(() => {
    if (!isFormValid) return
    if (hasExistingScores) {
      setConfirmRescoreOpen(true)
      return
    }
    runInitialScore()
  }, [isFormValid, hasExistingScores, runInitialScore])


  const handleSendMessageProbe = useCallback(async (trimmed: string, contextIds: (string | number)[], placeholderId: string) => {
    try {
      const response = await apiFetch("/chat-refine", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          current_prompt: task,
          refinement_history: probeRefinementHistory,
          task,
          min_score: min,
          max_score: max,
          selected_fields: selectedFieldsState,
          data: data || [],
          sampled_ids: sampledIds || [],
          context_ids: contextIds,
        }),
      })

      if (!response.ok) throw new Error("Failed to refine")

      const reader = response.body?.getReader()
      const decoder = new TextDecoder()
      if (!reader) throw new Error("No response body")

      let buffer = ""
      let updatedPrompt = ""
      let responseText = ""
      let scores: Record<string, number> = {}
      let cost = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n\n")
        buffer = lines.pop() || ""

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue
          const jsonData = JSON.parse(line.slice(6))

          if (jsonData.status) {
            setMessages(prev => prev.map(m => m.id === placeholderId ? { ...m, content: jsonData.status } : m))
          }

          if (jsonData.done) {
            updatedPrompt = jsonData.updated_prompt || ""
            responseText = jsonData.response || ""
            scores = jsonData.scores || {}
            cost = jsonData.cost || 0
          }
        }
      }

      if (updatedPrompt) {
        setTask(updatedPrompt)
        setHasPromptUpdate(true)
        onPromptUpdate?.(updatedPrompt)
      }

      if (Object.keys(scores).length > 0) {
        onScoresUpdate?.(scores, cost, updatedPrompt || undefined)
      } else if (cost > 0) {
        onCostAdd?.(cost)
      }

      setProbeRefinementHistory(prev => [...prev, trimmed])

      setMessages(prev => prev.map(m => m.id === placeholderId ? {
        ...m,
        content: responseText,
        metadata: { action: "refine" as const, scoresUpdated: Object.keys(scores).length > 0, cost },
      } : m))
    } catch (error) {
      console.error("Chat refine error:", error)
      const missingKeys = isMissingApiKeysError(error)
      setMessages(prev => prev.map(m => m.id === placeholderId ? {
        ...m,
        content: missingKeys
          ? "Add your API keys to use this — open Edit › Edit API Keys."
          : "Sorry, I couldn't process that. Please check the backend connection and try again.",
      } : m))
      if (!missingKeys) toast.error("Error", { description: "Failed to refine scoring" })
    } finally {
      setIsProcessing(false)
    }
  }, [task, min, max, selectedFieldsState, data, sampledIds, probeRefinementHistory, onPromptUpdate, onScoresUpdate, onCostAdd])


  const handleSendMessageAttune = useCallback(async (trimmed: string, contextIds: (string | number)[], placeholderId: string) => {
    try {
      const selectedItems: any[] = []
      if (contextIds.length > 0 && data) {
        for (const id of contextIds) {
          const item = data.find((d: any) => String(d.id) === String(id))
          if (item) {
            const slim: any = { id: String(item.id), score: item.score }
            for (const f of selectedFieldsState) {
              if (f in item) slim[f] = item[f]
            }
            selectedItems.push(slim)
          }
        }
      }

      const scoredItems = data?.filter((d: any) => d.score != null) || []
      const scoreCounts: Record<number, number> = {}
      for (const d of scoredItems) { scoreCounts[d.score] = (scoreCounts[d.score] || 0) + 1 }
      const dataSummary = `${data?.length || 0} items total, ${scoredItems.length} scored. Score distribution: ${Object.entries(scoreCounts).sort(([a], [b]) => Number(a) - Number(b)).map(([s, c]) => `${s}:${c}`).join(", ")}`

      const response = await apiFetch("/interpret-feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          task,
          min_score: min,
          max_score: max,
          criteria: criteria || [],
          selected_items: selectedItems,
          data_summary: dataSummary,
        }),
      })

      if (!response.ok) throw new Error("Failed to interpret feedback")

      const result = await response.json()
      const actions: FeedbackAction[] = result.actions || []
      const reasoning: string = result.reasoning || ""
      const cost: number = result.cost || 0

      if (cost > 0) onCostAdd?.(cost)

      if (actions.length === 0) {
        setMessages(prev => prev.map(m => m.id === placeholderId ? {
          ...m,
          content: reasoning || "I couldn't determine a specific scoring action from that feedback. Try being more specific — e.g. \"these should be score 3\" or \"use a normal distribution\".",
          metadata: { action: "info" as const, cost },
        } : m))
      } else {
        setMessages(prev => prev.map(m => m.id === placeholderId ? {
          ...m,
          content: reasoning,
          metadata: { action: "refine" as const, pendingActions: actions, reasoning, cost },
        } : m))
      }
    } catch (error) {
      console.error("Interpret error:", error)
      const missingKeys = isMissingApiKeysError(error)
      setMessages(prev => prev.map(m => m.id === placeholderId ? {
        ...m,
        content: missingKeys
          ? "Add your API keys to use this — open Edit › Edit API Keys."
          : "Sorry, I couldn't process that. Please check the backend connection and try again.",
      } : m))
      if (!missingKeys) toast.error("Error", { description: "Failed to interpret feedback" })
    } finally {
      setIsProcessing(false)
    }
  }, [task, min, max, selectedFieldsState, data, criteria, onCostAdd])


  const handleSendMessage = useCallback(async () => {
    const trimmed = inputValue.trim()
    if (!trimmed || isProcessing) return

    const contextIds = selectedNodeIds ? Array.from(selectedNodeIds) : []

    const userMsgId = `msg-${Date.now()}`
    const placeholderId = `msg-${Date.now()}-reply`
    setMessages(prev => [...prev,
      {
        id: userMsgId,
        role: "user" as const,
        content: trimmed,
        timestamp: new Date(),
        metadata: { action: "refine" as const, contextIds: contextIds.length > 0 ? contextIds : undefined },
      },
      {
        id: placeholderId,
        role: "assistant" as const,
        content: "Processing...",
        timestamp: new Date(),
        metadata: { action: "refine" as const },
      },
    ])
    setInputValue("")
    setIsProcessing(true)

    if (contextIds.length > 0 && onSelectedNodeIdsChange) {
      onSelectedNodeIdsChange(new Set())
    }

    if (mode === "probe") {
      handleSendMessageProbe(trimmed, contextIds, placeholderId)
    } else {
      handleSendMessageAttune(trimmed, contextIds, placeholderId)
    }
  }, [inputValue, isProcessing, mode, selectedNodeIds, onSelectedNodeIdsChange, handleSendMessageProbe, handleSendMessageAttune])


  const handleApprove = useCallback(async (msgId: string, actions: FeedbackAction[]) => {
    if (!onApplyActions) return
    setIsApplyingActions(true)

    try {
      await onApplyActions(actions)

      setMessages(prev => prev.map(m => m.id === msgId ? {
        ...m,
        metadata: { ...m.metadata, pendingActions: undefined, actionsApplied: true },
      } : m))

      toast.success("Actions applied", { description: "Re-scoring with updated constraints..." })
    } catch (error) {
      if (isMissingApiKeysError(error)) return
      console.error("Apply error:", error)
      toast.error("Error", { description: "Failed to apply actions" })
    } finally {
      setIsApplyingActions(false)
    }
  }, [onApplyActions])

  const handleReject = useCallback((msgId: string) => {
    setMessages(prev => prev.map(m => m.id === msgId ? {
      ...m,
      content: m.metadata?.reasoning || m.content,
      metadata: { ...m.metadata, pendingActions: undefined },
    } : m))

    setMessages(prev => [...prev, {
      id: `msg-${Date.now()}`,
      role: "assistant",
      content: "Got it — those changes were discarded. Feel free to try a different description.",
      timestamp: new Date(),
    }])
  }, [])


  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionQuery != null && mentionCriteria.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault()
        setMentionIndex(prev => Math.min(prev + 1, mentionCriteria.length - 1))
        return
      }
      if (e.key === "ArrowUp") {
        e.preventDefault()
        setMentionIndex(prev => Math.max(prev - 1, 0))
        return
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault()
        const selected = mentionCriteria[mentionIndex]
        if (selected) insertMention(selected.name || selected.text)
        return
      }
      if (e.key === "Escape") {
        e.preventDefault()
        setMentionQuery(null)
        setMentionAnchor(null)
        return
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      if (taskConfigured) handleSendMessage()
    }
  }


  return (
    <div className="flex flex-col h-full">
      <Dialog open={confirmRescoreOpen} onOpenChange={setConfirmRescoreOpen}>
        <DialogContent className="max-w-md p-5">
          <DialogTitle className="text-base text-[#003953]">Run initial scoring?</DialogTitle>
          <DialogDescription className="mt-2 text-sm text-[#003953]">
            Attune will keep your annotations, but draw a new sample to run initial
            scoring. This will replace current scores, criteria, and rules. If
            you want to revisit an earlier iteration, use the version dropdown
            instead.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="border-[#fccddd] bg-[#fccddd] text-[#003953] hover:bg-[#f9b8ce] hover:text-[#003953]"
              onClick={() => setConfirmRescoreOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-[#4baeae] text-white hover:bg-[#3d9999]"
              onClick={() => { setConfirmRescoreOpen(false); runInitialScore() }}
            >
              Run Initial Scoring
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className="border-b flex-shrink-0">
        <button
          onClick={() => { const o = !showTaskConfig; setShowTaskConfig(o); if (o) setHasPromptUpdate(false) }}
          className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-[#003953] hover:bg-[#f0f8ff] transition-colors"
        >
          <div className="flex items-center gap-2">
            <Settings2 className="h-3.5 w-3.5" />
            <span>Task Configuration</span>
            {hasPromptUpdate && !showTaskConfig && (
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
              </span>
            )}
          </div>
          {showTaskConfig ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {showTaskConfig && (
          <div className="px-3 pb-3 space-y-2 max-h-[60vh] overflow-y-auto">
            <FieldGroup className="gap-2">
              <FieldSet>
                <FieldGroup className="gap-2">
                  <Field>
                    <FieldLabel htmlFor="chat-task" className="text-xs">
                      Task <span className="text-red-500">*</span>
                    </FieldLabel>
                    <Textarea
                      id="chat-task"
                      placeholder="Describe your scoring task..."
                      className="resize-none min-h-[60px] text-xs"
                      value={task}
                      onChange={(e) => setTask(e.target.value)}
                      disabled={isScoring}
                    />
                  </Field>

                  <Field>
                    <FieldLabel className="text-xs">Field(s) to Score</FieldLabel>
                    {selectedFieldsState.length > 0 && (
                      <div className="flex flex-wrap gap-1 mb-0.5">
                        {selectedFieldsState.map((field) => (
                          <div key={field} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 bg-[#f0f8ff] text-[#003953] rounded-md text-[11px]">
                            <span>{field}</span>
                            <button type="button" onClick={() => removeField(field)} className="rounded-full p-0.5 cursor-pointer">
                              <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                              </svg>
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="relative">
                      <Input
                        type="text" placeholder="Type to search fields..." className="text-xs h-8" value={fieldInput}
                        onChange={(e) => { setFieldInput(e.target.value); setShowSuggestions(true) }}
                        onFocus={() => setShowSuggestions(true)}
                        onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && filteredFields.length > 0) { e.preventDefault(); addField(filteredFields[0]) } }}
                        disabled={isScoring}
                      />
                      {showSuggestions && fieldInput && filteredFields.length > 0 && (
                        <div className="absolute z-10 w-full mt-1 bg-white border border-[#0c5c84] rounded-md shadow-lg max-h-28 overflow-y-auto">
                          {filteredFields.map((field) => (
                            <button key={field} type="button" onClick={() => addField(field)} className="w-full text-left px-2 py-1 hover:bg-[#d3dfe6] text-xs">
                              {field}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </Field>

                  <div className="flex gap-2 items-end">
                    <Field className="w-16 shrink-0">
                      <FieldLabel htmlFor="chat-min" className="text-xs">Min <span className="text-red-500">*</span></FieldLabel>
                      <Input id="chat-min" type="number" value={min} onChange={(e) => setMin(e.target.value === "" ? "" : Number(e.target.value))} disabled={isScoring} className="w-full h-8 text-xs" />
                    </Field>
                    <Field className="w-16 shrink-0">
                      <FieldLabel htmlFor="chat-max" className="text-xs">Max <span className="text-red-500">*</span></FieldLabel>
                      <Input id="chat-max" type="number" value={max} onChange={(e) => setMax(e.target.value === "" ? "" : Number(e.target.value))} disabled={isScoring} className="w-full h-8 text-xs" />
                    </Field>
                    {showSampleSize && (
                      <Field className="w-16 shrink-0">
                        <FieldLabel htmlFor="chat-sample" className="text-xs">Sample <span className="text-red-500">*</span></FieldLabel>
                        <Input
                          id="chat-sample" type="number" value={sampleSize}
                          onChange={(e) => setSampleSize(e.target.value === "" ? "" : Number(e.target.value))}
                          onBlur={(e) => { const v = e.target.value === "" ? "" : Number(e.target.value); if (typeof v === "number" && v > 50) { setSampleSize(50); toast.error("Sample size cannot exceed 50", {}) } }}
                          disabled={isScoring} className="h-8 text-xs"
                        />
                      </Field>
                    )}
                  </div>
                </FieldGroup>
              </FieldSet>

              <Button
                onClick={handleInitialScore} disabled={!isFormValid || isScoring} size="sm"
                className="w-full bg-[#4baeae] text-white hover:bg-[#3d9999] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed text-xs"
              >
                {isScoring ? <><LoaderCircle className="animate-spin mr-2" /> Running</> : "Run Initial Scoring"}
              </Button>
            </FieldGroup>
          </div>
        )}
      </div>

      <div className="flex flex-col flex-1 min-h-0 border-t">
        <button
          onClick={() => setShowChat(!showChat)}
          className="w-full flex items-center justify-between px-3 py-2 text-sm font-medium text-[#003953] hover:bg-[#f0f8ff] transition-colors flex-shrink-0"
        >
          <div className="flex items-center gap-2">
            <MessageSquare className="h-3.5 w-3.5" />
            <span>AI Assistant</span>
          </div>
          {showChat ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </button>

        {showChat && (
          <>
            <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[90%] rounded-md px-2.5 py-1.5 text-xs border ${
                      msg.role === "user"
                        ? "bg-[#4baeae]/25 text-[#003953] border-[#4baeae]/30"
                        : msg.role === "system"
                        ? "bg-[#fccddd]/30 text-[#003953] border-[#fccddd]/50"
                        : "bg-[#fccddd]/30 text-[#003953] border-[#fccddd]/50"
                    }`}
                  >
                    <div className="whitespace-pre-wrap leading-snug">
                      {msg.content === "Processing..." ? (
                        <span className="inline-flex items-center gap-1">
                          <span className="h-1 w-1 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
                          <span className="h-1 w-1 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
                          <span className="h-1 w-1 rounded-full bg-current animate-bounce" />
                        </span>
                      ) : (
                        msg.content.split(/(\*\*.*?\*\*)/).map((part, i) => {
                          if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>
                          return part
                        })
                      )}
                    </div>

                    {msg.metadata?.pendingActions && msg.metadata.pendingActions.length > 0 && (
                      <div className="mt-2 space-y-1.5">
                        {msg.metadata.pendingActions.map((action, idx) => {
                          const Icon = ACTION_ICONS[action.type] || ListPlus
                          return (
                            <div key={idx} className="bg-white/60 rounded border border-[#0c5c84]/20 p-2">
                              <div className="flex items-center gap-1.5 mb-1">
                                <Icon className="h-3 w-3 text-[#0c5c84]" />
                                <span className="text-[10px] font-medium text-[#0c5c84]">{action.explanation}</span>
                              </div>
                              <div className="text-[10px] text-[#003953]/80 leading-snug">
                                {action.type === "pin_examples" && action.items && (
                                  <span>{action.items.map(it => `#${it.id} → ${it.score}`).join(", ")}</span>
                                )}
                                {action.type === "move_to_score" && action.criteria_filter && action.target_score != null && (
                                  <span>
                                    {action.criteria_filter.criterion}
                                    {action.criteria_filter.operator && action.criteria_filter.value != null
                                      ? ` ${action.criteria_filter.operator} ${action.criteria_filter.value}`
                                      : action.criteria_filter.match != null
                                        ? ` = ${action.criteria_filter.match}`
                                        : ""
                                    }
                                    {" → score "}
                                    {action.target_score}
                                  </span>
                                )}
                                {action.type === "set_bounds" && action.bounds && (
                                  <span>{action.bounds.map(b => `#${b.id}: ${b.min != null ? `≥${b.min}` : ""}${b.min != null && b.max != null ? " " : ""}${b.max != null ? `≤${b.max}` : ""}`).join(", ")}</span>
                                )}
                                {action.type === "set_bounds" && action.criteria_filter && (
                                  <span>
                                    {action.criteria_filter.criterion}
                                    {action.criteria_filter.operator && action.criteria_filter.value != null
                                      ? ` ${action.criteria_filter.operator} ${action.criteria_filter.value}`
                                      : action.criteria_filter.match != null
                                        ? ` = ${action.criteria_filter.match}`
                                        : ""
                                    }
                                    {action.criteria_filter.min != null ? ` → score ≥${action.criteria_filter.min}` : ""}
                                    {action.criteria_filter.max != null ? ` → score ≤${action.criteria_filter.max}` : ""}
                                  </span>
                                )}
                                {action.type === "set_distribution" && (
                                  <span>Template: {action.template}</span>
                                )}
                                {action.type === "add_criteria" && action.criteria && (
                                  <span>{action.criteria.map(c => `${c.name} (${c.type})`).join(", ")}</span>
                                )}
                              </div>
                            </div>
                          )
                        })}

                        <div className="flex gap-1.5 mt-1">
                          <Button
                            size="sm" onClick={() => handleApprove(msg.id, msg.metadata!.pendingActions!)}
                            disabled={isApplyingActions || (comparisonGraphLength !== undefined && comparisonGraphLength === 0)}
                            className="flex-1 h-6 text-[10px] bg-[#4baeae] text-white hover:bg-[#3d9999] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {isApplyingActions ? <LoaderCircle className="h-3 w-3 animate-spin mr-1" /> : <Check className="h-3 w-3 mr-1" />}
                            {isApplyingActions ? "Applying..." : "Apply & Re-score"}
                          </Button>
                          <Button
                            size="sm" variant="outline" onClick={() => handleReject(msg.id)}
                            disabled={isApplyingActions}
                            className="h-6 text-[10px] cursor-pointer disabled:opacity-50"
                          >
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                      </div>
                    )}

                    {msg.metadata?.actionsApplied && (
                      <div className="mt-1 flex items-center gap-1 text-[10px] text-green-700">
                        <Check className="h-3 w-3" />
                        <span>Applied — re-scoring in progress</span>
                      </div>
                    )}

                    {msg.metadata?.scoresUpdated && (
                      <div className="mt-0.5 text-[10px] opacity-75 flex items-center gap-1">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-green-400" />
                        Scores updated
                        {msg.metadata.cost !== undefined && ` • $${msg.metadata.cost.toFixed(3)}`}
                      </div>
                    )}
                    {msg.metadata?.contextIds && msg.metadata.contextIds.length > 0 && (
                      <button
                        className="mt-0.5 text-[10px] text-[#0c5c84]/70 hover:text-[#0c5c84] flex items-center gap-1 cursor-pointer transition-colors"
                        onClick={() => { if (onSelectedNodeIdsChange && msg.metadata?.contextIds) onSelectedNodeIdsChange(new Set(msg.metadata.contextIds)) }}
                      >
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-[#4baeae]" />
                        {msg.metadata.contextIds.length} input{msg.metadata.contextIds.length > 1 ? "s" : ""} as context
                      </button>
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="border-t flex-shrink-0">
              {isScoring && progress !== undefined && (
                <div className="px-3 py-2.5">
                  <div className="flex justify-between text-xs font-medium text-[#003953] mb-1">
                    <span>{progressStatus || "Processing..."}</span>
                    <span>{progress}%</span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2.5">
                    <div className="h-2.5 rounded-full transition-all duration-300 bg-teal-600" style={{ width: `${progress}%` }} />
                  </div>
                </div>
              )}

              <div className="px-3 py-2 space-y-1.5">
                {selectedNodeIds && selectedNodeIds.size > 0 && data && (
                  <div className="flex flex-wrap gap-1">
                    {(() => {
                      const groups = new Map<string, (string | number)[]>()
                      for (const id of Array.from(selectedNodeIds)) {
                        const item = data.find((d: any) => String(d.id) === String(id))
                        const score = item?.score != null ? String(item.score) : "unscored"
                        if (!groups.has(score)) groups.set(score, [])
                        groups.get(score)!.push(id)
                      }
                      return Array.from(groups.entries()).map(([score, ids]) => (
                        <span key={score} className="inline-flex items-center gap-1 text-[10px] bg-[#4baeae]/20 text-[#003953] px-1.5 py-0.5 rounded-full border border-[#4baeae]/30">
                          <span>{ids.length} input{ids.length > 1 ? "s" : ""} scored {score}</span>
                          <button className="hover:text-red-500 cursor-pointer" onClick={() => { if (onSelectedNodeIdsChange) { const next = new Set(selectedNodeIds); ids.forEach(id => next.delete(id)); onSelectedNodeIdsChange(next) } }}>
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </span>
                      ))
                    })()}
                  </div>
                )}

                <div className="flex gap-1.5">
                  <div className="relative flex-1">
                    <Textarea
                      ref={inputRef}
                      placeholder={taskConfigured ? "Refine scoring... (use @ to reference criteria)" : "Run initial scoring first..."}
                      className="resize-none min-h-[32px] max-h-[80px] text-xs w-full"
                      value={inputValue}
                      onChange={handleInputChange}
                      onKeyDown={handleKeyDown}
                      onBlur={() => setTimeout(() => { setMentionQuery(null); setMentionAnchor(null) }, 200)}
                      disabled={!taskConfigured || isScoring || isProcessing || isApplyingActions}
                      rows={1}
                    />
                    {mentionQuery != null && mentionCriteria.length > 0 && (
                      <div className="absolute z-20 bottom-full mb-1 left-0 w-full bg-white border border-[#0c5c84] rounded-md shadow-lg max-h-32 overflow-y-auto">
                        {mentionCriteria.map((c: any, idx: number) => {
                          const name = c.name || c.text
                          return (
                            <button
                              key={name}
                              type="button"
                              onMouseDown={(e) => { e.preventDefault(); insertMention(name) }}
                              className={`w-full text-left px-2 py-1 text-xs flex items-center gap-1.5 ${
                                idx === mentionIndex ? "bg-[#d3dfe6]" : "hover:bg-[#f0f8ff]"
                              }`}
                            >
                              <span className="text-[#0c5c84] font-medium">@{name}</span>
                              <span className="text-[10px] text-[#003953]/50">{c.type || "boolean"}</span>
                            </button>
                          )
                        })}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 self-end">
                    <Button
                      onClick={handleSendMessage}
                      disabled={!inputValue.trim() || !taskConfigured || isScoring || isProcessing || isApplyingActions}
                      size="sm"
                      className="bg-[#4baeae] text-white hover:bg-[#3d9999] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed h-7 w-7 p-0"
                    >
                      {isProcessing ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    </Button>
                    {canRescore && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={onRescore}
                        disabled={isRescoring}
                        className={`h-7 w-7 p-0 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed transition-all ${
                          hasPendingChanges && !isRescoring
                            ? "border-[#e8a0b4] bg-[#fcf0f4] text-[#003953] hover:bg-[#f8dfe8]"
                            : "border-[#4baeae] text-[#003953] hover:bg-[#e0f8f8]"
                        }`}
                      >
                        {isRescoring
                          ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          : <RotateCw className="h-3.5 w-3.5" />
                        }
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default ChatPane
