"use client"

import { useRouter, usePathname } from "next/navigation"
import { useEffect, useRef, useCallback } from "react"
import { Button } from "@/components/ui/button"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Upload, Download, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen, ShipWheel, SquarePen, KeyRound, Check } from "lucide-react"
import { useLlmConfig } from "@/lib/llm-config"

interface HeaderProps {
  cost?: string
  accuracy?: string
  mae?: string
  validationAccuracy?: string
  validationMae?: string
  annotatedCount?: number
  consistency?: string
  selectedDataset?: string | null
  onDatasetSelect?: (value: string) => void
  onUpload?: () => void
  onDownload?: () => void
  isSemanticScoreOpen?: boolean
  isInspectorOpen?: boolean
  onToggleSemanticScore?: () => void
  onToggleInspector?: () => void
  mode?: "original" | "baseline"
}

const DATASETS = [
  { value: "triage", label: "TRIAGE", filename: "triage.json" },
  { value: "student_essays", label: "Student Essays (ASAP)", filename: "student_essays.json" },
  { value: "candidate_screening", label: "Candidate Screening", filename: "candidate_screening.json" },
  { value: "patient_risk", label: "Patient Risk Assessment", filename: "patient_risk.json" },
  { value: "support_tickets", label: "Support Ticket Priority", filename: "support_tickets.json" },
  { value: "lease_agreements", label: "Lease Red-Flag Analysis", filename: "lease_agreements.json" },
  { value: "product_search", label: "Monitor Stand Search (WANDS)", filename: "product_search.json" },
  { value: "job_postings", label: "Job Postings", filename: "job_postings.json" },
  { value: "movie_selection", label: "Movie Selection", filename: "movie_selection.json" },
  { value: "llm_redundancy", label: "Scarecrow", filename: "scarecrow.json" },
] as const

const BASELINE_DATASETS = [
  { value: "triage", label: "TRIAGE", filename: "triage.json" },
  { value: "student_essays", label: "Student Essays (ASAP)", filename: "student_essays.json" },
  { value: "candidate_screening", label: "Candidate Screening", filename: "candidate_screening.json" },
  { value: "product_search", label: "Monitor Stand Selection", filename: "product_search.json" },
] as const

const Header = ({
  cost = "$0.00",
  accuracy,
  mae,
  validationAccuracy,
  validationMae,
  annotatedCount = 0,
  consistency: _consistency = "0%",
  selectedDataset,
  onDatasetSelect,
  onUpload,
  onDownload,
  isSemanticScoreOpen = true,
  isInspectorOpen = true,
  onToggleSemanticScore,
  onToggleInspector,
  mode = "original",
}: HeaderProps) => {
  const router = useRouter()
  const pathname = usePathname()
  const { openSettings, isConfigured } = useLlmConfig()
  const currentMode = pathname === "/probe" ? "baseline" : "original"
  const clickCountRef = useRef(0)
  const clickTimerRef = useRef<NodeJS.Timeout | null>(null)

  const handleModeSwitch = useCallback(() => {
    if (currentMode === "baseline") {
      router.push("/")
    } else {
      router.push("/probe")
    }
  }, [currentMode, router])

  const handleTitleClick = () => {
    clickCountRef.current += 1
    if (clickTimerRef.current) clearTimeout(clickTimerRef.current)
    if (clickCountRef.current >= 3) {
      clickCountRef.current = 0
      handleModeSwitch()
    } else {
      clickTimerRef.current = setTimeout(() => {
        clickCountRef.current = 0
      }, 600)
    }
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "B") {
        e.preventDefault()
        handleModeSwitch()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handleModeSwitch])

  return (
    <header className="w-full bg-background border-b">
      <div className="flex items-center px-6 py-3">
        <div className="flex items-center gap-3 flex-1">
          {mode !== "baseline" && (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={onToggleSemanticScore}>
                    {isSemanticScoreOpen ? (
                      <PanelLeftClose className="h-4 w-4" />
                    ) : (
                      <PanelLeftOpen className="h-4 w-4" />
                    )}
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  <p>{isSemanticScoreOpen ? "Hide" : "Show"} Chat </p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}

          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <SquarePen className="h-4 w-4 mr-1" />
                Edit
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel className="flex items-center justify-between gap-3">
                <span>API Keys</span>
                {isConfigured ? (
                  <span className="flex items-center gap-1 text-sm font-normal text-emerald-600">
                    <span className="flex h-2 w-2 rounded-full bg-emerald-500" /> Set
                  </span>
                ) : (
                  <span className="flex items-center gap-1 text-sm font-normal text-rose-700">
                    <span className="flex h-2 w-2 rounded-full bg-rose-700" /> Not set
                  </span>
                )}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setTimeout(openSettings, 0)}>
                <KeyRound className="h-4 w-4" />
                Edit API Keys
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <Select value={selectedDataset ?? ""} onValueChange={onDatasetSelect}>
            <SelectTrigger className="w-[200px] z-10">
              <SelectValue placeholder="Sample Datasets" />
            </SelectTrigger>
            <SelectContent>
              {(mode === "baseline" ? BASELINE_DATASETS : DATASETS).map((dataset) => (
                <SelectItem key={dataset.value} value={dataset.value}>
                  {dataset.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={onUpload}>
                  <Upload className="h-4 w-4 mr-1" />
                  Upload
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Upload JSON</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={onDownload}>
                  <Download className="h-4 w-4 mr-1" />
                  Download
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Download as JSON</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>

        {mode !== "baseline" && (
          <div
            onClick={handleTitleClick}
            className="flex items-center gap-2 select-none cursor-default absolute left-1/2 -translate-x-1/2"
          >
            <ShipWheel className="h-6 w-6 text-[#0c5c84]" />
            <span className="text-sm font-extrabold tracking-widest uppercase text-[#003953]">
              Attune
            </span>
          </div>
        )}

        <div className="flex items-center gap-6 text-sm flex-1 justify-end">
          {mode === "baseline" && accuracy !== undefined && accuracy !== null && (
            <div className="flex flex-col items-end">
              <span className="text-muted-foreground text-xs">Accuracy</span>
              <span className="font-semibold">{accuracy}</span>
            </div>
          )}

          <div className="flex flex-col items-end">
            <span className="text-muted-foreground text-xs">Validation Acc</span>
            <span className="font-semibold">{validationAccuracy ?? "--"}</span>
          </div>

          <div className="flex flex-col items-end">
            <span className="text-muted-foreground text-xs">Validation MAE</span>
            <span className="font-semibold">{validationMae ?? "--"}</span>
          </div>

          <div className="flex flex-col items-end">
            <span className="text-muted-foreground text-xs">Annotated</span>
            <span className="font-semibold">{annotatedCount}</span>
          </div>

          <div className="flex flex-col items-end">
            <span className="text-muted-foreground text-xs">Cost</span>
            <span className="font-semibold">{cost}</span>
          </div>

          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={onToggleInspector}>
                  {isInspectorOpen ? (
                    <PanelRightClose className="h-4 w-4" />
                  ) : (
                    <PanelRightOpen className="h-4 w-4" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{isInspectorOpen ? "Hide" : "Show"} {mode === "baseline" ? "Chat" : "Scoring Inspector"} </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </header>
  )
}

export default Header
export { DATASETS }