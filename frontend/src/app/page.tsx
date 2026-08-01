"use client"

import { useState, useCallback, useEffect } from "react"

import Header from "@/components/header"
import TableContainer from "@/components/table-container"
import ChatPane, { FeedbackAction } from "@/components/chat-pane"
import Inspector from "@/components/inspector-sidepane"
import { DistributionTemplate, generateProportions } from "@/components/scoring-distribution"

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"

import { useScoring, apiFetch } from "@/hooks/use-scoring"

interface EditableStructuredRule {
  conditions: string[];
  score: number;
  n: number;
  n_total?: number;
  item_ids?: (string | number)[];
  raw?: string;
}

function parseConditionValue(raw: string): unknown {
  const trimmed = raw.trim()
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1)
  }
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true"
  if (/^null$/i.test(trimmed)) return null
  const numeric = Number(trimmed)
  if (Number.isFinite(numeric)) return numeric
  return trimmed
}

function evaluateRuleCondition(condition: string, item: Record<string, any>, features: Record<string, any>): boolean {
  const source = { ...(item || {}), ...(features || {}) }
  let text = condition.trim()
  if (!text || text === "DEFAULT" || text.toLowerCase() === "all items") return true

  let isNegated = false
  if (/^NOT\s+/i.test(text)) {
    isNegated = true
    text = text.replace(/^NOT\s+/i, "").trim()
  }

  const exprMatch = text.match(/^(.+?)\s*(<=|>=|!=|==|=|<|>)\s*(.+)$/)
  let result = false

  if (!exprMatch) {
    const value = source[text]
    result = typeof value === "boolean" ? value : Boolean(value)
  } else {
    const [, rawKey, operator, rawExpected] = exprMatch
    const key = rawKey.trim()
    const actual = source[key]
    const expected = parseConditionValue(rawExpected)

    if (actual === undefined) {
      result = false
    } else {
      const actualNum = Number(actual)
      const expectedNum = Number(expected)
      const bothNumeric = Number.isFinite(actualNum) && Number.isFinite(expectedNum)
      const left = bothNumeric ? actualNum : actual
      const right = bothNumeric ? expectedNum : expected

      switch (operator) {
        case ">": result = (left as any) > (right as any); break
        case "<": result = (left as any) < (right as any); break
        case ">=": result = (left as any) >= (right as any); break
        case "<=": result = (left as any) <= (right as any); break
        case "!=": result = left !== right; break
        case "=":
        case "==":
          result = left === right
          break
        default:
          result = false
      }
    }
  }

  return isNegated ? !result : result
}

export default function Page() {
  const scoring = useScoring()
  const [isChatOpen, setIsChatOpen] = useState(true)
  const [isInspectorOpen, setIsInspectorOpen] = useState(true)
  const [hasPendingChanges, setHasPendingChanges] = useState(false)
  const [highlightedScore, setHighlightedScore] = useState<number | null>(null)
  const [selectedRuleIndex, setSelectedRuleIndex] = useState<number | null>(null)
  const [zoomedScore, setZoomedScore] = useState<number | null>(null)

  useEffect(() => {
    const handleEscReset = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return

      scoring.setSelectedCriterion(null)
      scoring.setSelectedNodeIds(new Set())
      setHighlightedScore(null)
      setSelectedRuleIndex(null)
      setZoomedScore(null)
    }

    window.addEventListener("keydown", handleEscReset)
    return () => window.removeEventListener("keydown", handleEscReset)
  }, [scoring])

  const handleDistributionTemplateChange = useCallback((template: DistributionTemplate | null) => {
    scoring.setDistributionTemplate(template)
    if (template && scoring.minScore != null && scoring.maxScore != null) {
      const proportions = generateProportions(template, scoring.minScore, scoring.maxScore)
      scoring.setDistributionConstraints(proportions)
    } else {
      scoring.setDistributionConstraints(null)
    }
    setHasPendingChanges(true)
  }, [scoring])

  const handleCriteriaChange = useCallback((criteria: any[]) => {
    scoring.setCriteria(criteria)
    setHasPendingChanges(true)
  }, [scoring])

  const handleAddCriterion = useCallback(async (name: string, definition: string) => {
    await scoring.handleAddCriterion(name, definition)
    setHasPendingChanges(true)
  }, [scoring])

  const handleScoreRuleClick = useCallback((score: number) => {
    setHighlightedScore(score)
    setTimeout(() => setHighlightedScore(null), 2000)
  }, [])

  const handleRuleClick = useCallback((itemIds: (string | number)[]) => {
    if (itemIds.length === 0) {
      scoring.setSelectedNodeIds(new Set())
      setSelectedRuleIndex(null)
    } else {
      scoring.setSelectedNodeIds(new Set(itemIds))
      const rules = scoring.rules as any[]
      const idx = rules.findIndex(r => r.item_ids && r.item_ids.length === itemIds.length && r.item_ids[0] === itemIds[0])
      setSelectedRuleIndex(idx >= 0 ? idx : null)
    }
  }, [scoring])

  const handleRulesChange = useCallback((updatedRules: EditableStructuredRule[]) => {
    if (!Array.isArray(updatedRules) || !Array.isArray(scoring.data)) return
    const sampledSet = new Set((scoring.sampledIds || []).map((id: string | number) => String(id)))
    const hasSampling = sampledSet.size > 0

    const normalizedRules: EditableStructuredRule[] = updatedRules.map((rule) => {
      const nextConditions = Array.isArray(rule.conditions)
        ? rule.conditions
            .map(c => c.trim())
            .filter(Boolean)
            .map(c => c.toLowerCase() === "all items" ? "DEFAULT" : c)
        : []
      return {
        ...rule,
        conditions: nextConditions.length > 0 ? nextConditions : ["DEFAULT"],
        n: 0,
        n_total: 0,
        item_ids: [],
      }
    })

    const rescoredData = scoring.data.map((item: Record<string, any>) => {
      const itemId = String(item.id)
      if (hasSampling && !sampledSet.has(itemId)) {
        const { _scoreCategory, ...rest } = item
        return rest
      }

      const itemFeatures = scoring.mappedFeatures?.[itemId] ?? scoring.mappedFeatures?.[item.id] ?? {}

      const matchedRule = normalizedRules.find((rule) =>
        rule.conditions.every((condition) => evaluateRuleCondition(condition, item, itemFeatures))
      )

      if (matchedRule) {
        matchedRule.item_ids!.push(item.id)
        matchedRule.n += 1
        matchedRule.n_total = matchedRule.n
      }

      return {
        ...item,
        score: matchedRule ? matchedRule.score : null,
        _scoreCategory: matchedRule ? "scored" : "null",
      }
    })

    scoring.setRules(normalizedRules)
    scoring.setData(rescoredData)
    scoring.setDataVersion((prev: number) => prev + 1)
    scoring.setSelectedNodeIds(new Set())
    setSelectedRuleIndex(null)
    setHasPendingChanges(false)

    scoring.createVersionSnapshot(
      rescoredData,
      scoring.criteria,
      normalizedRules,
      scoring.mappedFeatures,
    )
  }, [scoring])

  const handleRescore = useCallback(() => {
    const template = scoring.distributionTemplate as DistributionTemplate | null
    const dist = template && scoring.minScore != null && scoring.maxScore != null
      ? generateProportions(template, scoring.minScore, scoring.maxScore)
      : scoring.distributionConstraints
    scoring.handleRescore({ distribution: dist })
    setHasPendingChanges(false)
  }, [scoring])

  const criteriaFilterMatches = useCallback((cf: FeedbackAction["criteria_filter"], itemFeatures: Record<string, any>): boolean => {
    if (!cf) return false
    const val = itemFeatures[cf.criterion]
    if (val === undefined) return false

    if (cf.operator && cf.value != null && typeof val === "number") {
      switch (cf.operator) {
        case ">=": return val >= cf.value
        case "<=": return val <= cf.value
        case ">": return val > cf.value
        case "<": return val < cf.value
        case "==": return val === cf.value
        default: return val >= cf.value
      }
    }

    if (cf.match != null) {
      const boolVal = typeof val === "boolean" ? val : (typeof val === "number" ? val > 0 : Boolean(val))
      return boolVal === cf.match
    }

    return false
  }, [])

  const recharacterize = useCallback(async (updatedData: any[]) => {
    const scores: Record<string, number> = {}
    for (const item of updatedData) {
      if (item.score != null) scores[String(item.id)] = item.score
    }
    try {
      const resp = await apiFetch("/recharacterize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scores,
          mapped_features: scoring.mappedFeatures,
          criteria: scoring.criteria,
          task: scoring.currentTask || "",
          min_score: scoring.minScore,
          max_score: scoring.maxScore,
        }),
      })
      const result = await resp.json()
      if (result.cost) scoring.setCost((prev: number) => prev + result.cost)
      const newRules = result.rules || []
      if (newRules.length > 0) scoring.setRules(newRules)
      if (result.rule_summaries) scoring.setRuleSummaries(result.rule_summaries)
      if (result.rule_transitions) scoring.setRuleTransitions(result.rule_transitions)

      scoring.createVersionSnapshot(updatedData, scoring.criteria, newRules, scoring.mappedFeatures)
    } catch (err) {
      console.error("Failed to recharacterize:", err)
    }
  }, [scoring])

  const handleApplyActions = useCallback(async (actions: FeedbackAction[]) => {
    let newBounds = scoring.bounds ? { ...scoring.bounds } : {}
    let distributionOverride: Record<number, number> | null | undefined = undefined
    let localMappedFeatures: Record<string, any> = { ...(scoring.mappedFeatures || {}) }
    let currentData = scoring.data ? [...scoring.data] : []

    const needsOptimization = actions.some(a =>
      a.type === "add_criteria" || a.type === "set_distribution" || a.type === "set_bounds"
    )

    for (const action of actions) {
      switch (action.type) {
        case "pin_examples": {
          if (action.items && currentData.length > 0) {
            currentData = currentData.map((item: any) => {
              const pinned = action.items!.find(p => String(p.id) === String(item.id))
              if (pinned) return { ...item, score: pinned.score }
              return item
            })
            scoring.setData([...currentData])
            scoring.setDataVersion((prev: number) => prev + 1)
            const newEditedIds = action.items.map(p => String(p.id))
            scoring.setEditedIds((prev: (string | number)[]) => [...new Set([...prev, ...newEditedIds])])
          }
          break
        }

        case "move_to_score": {
          if (action.criteria_filter && action.target_score != null && currentData.length > 0) {
            const movedIds: string[] = []
            currentData = currentData.map((item: any) => {
              const itemFeatures = localMappedFeatures[String(item.id)]
              if (!itemFeatures) return item
              if (criteriaFilterMatches(action.criteria_filter, itemFeatures)) {
                movedIds.push(String(item.id))
                return { ...item, score: action.target_score }
              }
              return item
            })
            scoring.setData([...currentData])
            scoring.setDataVersion((prev: number) => prev + 1)
            scoring.setEditedIds((prev: (string | number)[]) => [...new Set([...prev, ...movedIds])])
          }
          break
        }

        case "set_bounds": {
          if (action.bounds) {
            for (const b of action.bounds) {
              const key = String(b.id)
              const bound: { min?: number; max?: number } = {}
              if (b.min != null) bound.min = b.min
              if (b.max != null) bound.max = b.max
              if (Object.keys(bound).length > 0) newBounds[key] = bound
            }
          }

          if (action.criteria_filter && currentData.length > 0) {
            const cf = action.criteria_filter
            for (const item of currentData) {
              const itemFeatures = localMappedFeatures[String(item.id)]
              if (!itemFeatures) continue
              if (criteriaFilterMatches(cf, itemFeatures)) {
                const key = String(item.id)
                const bound: { min?: number; max?: number } = { ...(newBounds[key] || {}) }
                if (cf.min != null) bound.min = cf.min
                if (cf.max != null) bound.max = cf.max
                if (Object.keys(bound).length > 0) newBounds[key] = bound
              }
            }
          }
          break
        }

        case "set_distribution": {
          const templateMap: Record<string, DistributionTemplate> = {
            "uniform": "uniform",
            "gaussian": "gaussian",
            "normal": "gaussian",
            "left-skew": "left-skew",
            "left_skew": "left-skew",
            "right-skew": "right-skew",
            "right_skew": "right-skew",
          }
          const tmpl = templateMap[action.template || ""] || null
          if (tmpl && scoring.minScore != null && scoring.maxScore != null) {
            scoring.setDistributionTemplate(tmpl)
            const proportions = generateProportions(tmpl, scoring.minScore, scoring.maxScore)
            scoring.setDistributionConstraints(proportions)
            distributionOverride = proportions
          }
          break
        }

        case "add_criteria": {
          if (action.criteria && action.criteria.length > 0 && currentData.length > 0) {
            try {
              const resp = await apiFetch("/add-criteria", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  criteria: action.criteria,
                  data: currentData,
                  selected_fields: scoring.selectedFields,
                }),
              })
              const result = await resp.json()
              if (result.cost) scoring.setCost((prev: number) => prev + result.cost)

              const existingCriteria = scoring.criteria || []
              const newCriteria = action.criteria.map(c => ({
                name: c.name,
                text: c.name,
                type: c.type,
                definition: c.definition,
                visible: true,
              }))
              scoring.setCriteria([...existingCriteria, ...newCriteria])

              if (result.mapped_features) {
                for (const [itemId, features] of Object.entries(result.mapped_features as Record<string, any>)) {
                  localMappedFeatures[itemId] = { ...(localMappedFeatures[itemId] || {}), ...features }
                }
                scoring.setMappedFeatures({ ...localMappedFeatures })
              }
            } catch (err) {
              console.error("Failed to add criteria:", err)
            }
          }
          break
        }
      }
    }

    if (Object.keys(newBounds).length > 0) {
      scoring.setBounds(newBounds)
    }

    if (needsOptimization) {
      const template = scoring.distributionTemplate as DistributionTemplate | null
      const dist = distributionOverride !== undefined
        ? distributionOverride
        : (template && scoring.minScore != null && scoring.maxScore != null
          ? generateProportions(template, scoring.minScore, scoring.maxScore)
          : scoring.distributionConstraints)

      scoring.handleRescore({
        distribution: dist,
        bounds: Object.keys(newBounds).length > 0 ? newBounds : scoring.bounds,
      })
    } else {
      await recharacterize(currentData)
    }
    setHasPendingChanges(false)
  }, [scoring, criteriaFilterMatches, recharacterize])

  return(
    <div className="flex flex-col h-screen overflow-hidden">
      <Header
        selectedDataset={scoring.selectedDataset}
        cost={"$" + scoring.cost.toFixed(2).toString()}
        accuracy={scoring.accuracy != null ? scoring.accuracy.toFixed(1) + "%" : undefined}
        mae={scoring.mae != null ? scoring.mae.toFixed(2) : undefined}
        validationAccuracy={scoring.validationAccuracy != null ? scoring.validationAccuracy.toFixed(1) + "%" : undefined}
        validationMae={scoring.validationMae != null ? scoring.validationMae.toFixed(2) : undefined}
        annotatedCount={scoring.annotatedCount}
        consistency={scoring.consistency.toFixed(2) + "%"}
        onDatasetSelect={scoring.handleDatasetSelect}
        onUpload={scoring.handleUpload}
        onDownload={scoring.handleDownload}
        isSemanticScoreOpen={isChatOpen}
        isInspectorOpen={isInspectorOpen}
        onToggleSemanticScore={() => setIsChatOpen(!isChatOpen)}
        onToggleInspector={() => setIsInspectorOpen(!isInspectorOpen)}
      />
      <ResizablePanelGroup
        id="attune-main-layout"
        key={`${isChatOpen}-${isInspectorOpen}`}
        className="flex-1 min-h-0 overflow-hidden"
        direction="horizontal"
      >
        {isChatOpen && (
          <>
            <ResizablePanel
              defaultSize={25}
              minSize={20}
              maxSize={35}
              id="chat-pane"
              className="overflow-hidden"
            >
              <ChatPane
                task={scoring.currentTask ?? scoring.datasetConfig?.task}
                minScore={scoring.minScore ?? scoring.datasetConfig?.minScore}
                maxScore={scoring.maxScore ?? scoring.datasetConfig?.maxScore}
                availableFields={scoring.availableFields}
                selectedFields={scoring.selectedFields}
                sampleSize={scoring.sampleSize}
                onSampleSizeChange={scoring.setSampleSize}
                resetKey={scoring.datasetEpoch}
                data={scoring.data}
                criteria={scoring.criteria}
                isScoring={scoring.isScoring || scoring.isRescoring}
                progress={scoring.scoringProgress}
                progressStatus={scoring.scoringStatus}
                comparisonGraphLength={scoring.comparisonGraph.length}
                selectedNodeIds={scoring.selectedNodeIds}
                onSelectedNodeIdsChange={scoring.setSelectedNodeIds}
                onScore={scoring.handleScore}
                onApplyActions={handleApplyActions}
                onCostAdd={(cost) => scoring.setCost((prev: number) => prev + cost)}
                onRescore={handleRescore}
                isRescoring={scoring.isRescoring}
                canRescore={scoring.comparisonGraph.length > 0}
                hasPendingChanges={hasPendingChanges}
              />
            </ResizablePanel>
            <ResizableHandle withHandle />
          </>
        )}
        <ResizablePanel
          defaultSize={isChatOpen && isInspectorOpen ? 55 : isChatOpen || isInspectorOpen ? 75 : 100}
          minSize={40}
          id="table"
        >
          <TableContainer
            data={scoring.data || []}
            onDataChange={scoring.handleExampleAddition}
            sampledIds={scoring.sampledIds}
            groupedByScore={scoring.groupedByScore}
            viewSample={scoring.viewSample}
            viewMode={scoring.viewMode}
            onGroupedByScoreChange={scoring.setGroupedByScore}
            onViewSampleChange={scoring.setViewSample}
            onViewModeChange={scoring.setViewMode}
            selectedFields={scoring.selectedFields}
            minScore={scoring.minScore}
            maxScore={scoring.maxScore}
            mappedFeatures={scoring.mappedFeatures}
            selectedCriterion={scoring.selectedCriterion}
            selectedNodeIds={scoring.selectedNodeIds}
            onNodeSelect={scoring.setSelectedNodeIds}
            onCriterionSelect={scoring.setSelectedCriterion}
            rules={scoring.rules}
            onScoreRuleClick={handleScoreRuleClick}
            onZoomedScoreChange={setZoomedScore}
            criteria={scoring.criteria}
            versions={scoring.versions}
            selectedVersionId={scoring.selectedVersionId}
            isDiffing={scoring.isDiffing}
            scoreDiffs={scoring.scoreDiffs}
            onVersionSelect={scoring.handleVersionSelect}
            onDiffToggle={scoring.setIsDiffing}
            annotations={scoring.annotations}
            annotationDeltas={scoring.annotationDeltas}
            onAnnotateItem={scoring.annotateItem}
            showValidationDecorators={scoring.showValidationDecorators}
            onShowValidationDecoratorsChange={scoring.setShowValidationDecorators}
          />
        </ResizablePanel>
        {isInspectorOpen && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={20}
              minSize={20}
              maxSize={50}
              id="inspector"
              className="overflow-hidden"
            >
              <Inspector
              data={scoring.data || []}
              criteria={scoring.criteria}
              otherCriteria={scoring.otherCriteria}
              rules={zoomedScore !== null
                ? (scoring.rules || []).filter((r: any) => r.score === zoomedScore)
                : scoring.rules}
              ruleSummaries={scoring.ruleSummaries}
              ruleTransitions={scoring.ruleTransitions}
              minScore={scoring.minScore}
              maxScore={scoring.maxScore}
              onCriteriaChange={handleCriteriaChange}
              onAddCriterion={handleAddCriterion}
              mappedFeatures={scoring.mappedFeatures}
              selectedCriterion={scoring.selectedCriterion}
              selectedNodeIds={scoring.selectedNodeIds}
              onCriterionSelect={scoring.setSelectedCriterion}
              onNodeSelect={scoring.setSelectedNodeIds}
              selectedDistributionTemplate={scoring.distributionTemplate as DistributionTemplate | null}
              onDistributionTemplateChange={handleDistributionTemplateChange}
              highlightedScore={highlightedScore}
              onRuleClick={handleRuleClick}
              selectedRuleIndex={selectedRuleIndex}
              task={scoring.currentTask}
              loadingCriteria={scoring.loadingCriteria}
              onRulesChange={handleRulesChange}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}
