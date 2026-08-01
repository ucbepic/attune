"use client"

import { useState, useCallback, useMemo, useRef } from "react"

export interface VersionSnapshot {
  id: number
  label: string
  scores: Record<string | number, number | null>
  impactedCount: number
  criteria: any[]
  rules: any[]
  mappedFeatures: Record<string | number, Record<string, boolean>>
  distributionTemplate: string | null
  taskConfig: {
    task: string
    minScore: number | null
    maxScore: number | null
    selectedFields: string[]
    sampleSize: number | ""
  }
  accuracy: number | null
}

export interface ScoreDiff {
  oldScore: number | null
  newScore: number | null
  direction: "up" | "down" | "same" | "new"
}

export function useVersioning() {
  const [versions, setVersions] = useState<VersionSnapshot[]>([])
  const [selectedVersionId, setSelectedVersionId] = useState<number | null>(null)
  const [isDiffing, setIsDiffing] = useState(false)
  const versionCounterRef = useRef(0)
  const versionsRef = useRef<VersionSnapshot[]>([])

  const createVersion = useCallback((
    data: Record<string, any>[],
    criteria: any[],
    rules: any[],
    mappedFeatures: Record<string | number, Record<string, boolean>>,
    taskConfig: {
      task: string
      minScore: number | null
      maxScore: number | null
      selectedFields: string[]
      sampleSize: number | ""
    },
    accuracy: number | null = null,
    distributionTemplate: string | null = null,
  ) => {
    versionCounterRef.current += 1
    const newId = versionCounterRef.current

    const scores: Record<string | number, number | null> = {}
    data.forEach(item => {
      scores[item.id] = item.score ?? null
    })

    let impactedCount = 0
    const prevVersions = versionsRef.current
    if (prevVersions.length > 0) {
      const lastVersion = prevVersions[prevVersions.length - 1]
      Object.keys(scores).forEach(id => {
        const oldScore = lastVersion.scores[id]
        const newScore = scores[id]
        if (oldScore !== newScore) {
          impactedCount++
        }
      })
    } else {
      impactedCount = Object.values(scores).filter(s => s != null).length
    }

    const snapshot: VersionSnapshot = {
      id: newId,
      label: `v${newId}`,
      scores,
      impactedCount,
      criteria: JSON.parse(JSON.stringify(criteria)),
      rules,
      mappedFeatures: JSON.parse(JSON.stringify(mappedFeatures)),
      distributionTemplate,
      taskConfig: { ...taskConfig },
      accuracy,
    }

    setVersions(prev => {
      const updated = [...prev, snapshot]
      versionsRef.current = updated
      return updated
    })
    setSelectedVersionId(newId)
  }, [])

  const getVersionById = useCallback((versionId: number): VersionSnapshot | null => {
    return versionsRef.current.find(v => v.id === versionId) ?? null
  }, [])

  const selectedVersion = useMemo(() => {
    if (selectedVersionId === null) return null
    return versions.find(v => v.id === selectedVersionId) ?? null
  }, [versions, selectedVersionId])

  const previousVersion = useMemo(() => {
    if (selectedVersionId === null || versions.length < 2) return null
    const idx = versions.findIndex(v => v.id === selectedVersionId)
    if (idx <= 0) return null
    return versions[idx - 1]
  }, [versions, selectedVersionId])

  const scoreDiffs = useMemo((): Record<string | number, ScoreDiff> => {
    if (!isDiffing || !selectedVersion || !previousVersion) return {}

    const diffs: Record<string | number, ScoreDiff> = {}
    const allIds = new Set([
      ...Object.keys(selectedVersion.scores),
      ...Object.keys(previousVersion.scores),
    ])

    allIds.forEach(id => {
      const oldScore = previousVersion.scores[id] ?? null
      const newScore = selectedVersion.scores[id] ?? null

      if (oldScore === newScore) return

      let direction: ScoreDiff["direction"] = "same"
      if (oldScore === null && newScore !== null) {
        direction = "new"
      } else if (oldScore !== null && newScore !== null) {
        if (newScore > oldScore) direction = "up"
        else if (newScore < oldScore) direction = "down"
        else direction = "same"
      }

      if (direction !== "same") {
        diffs[id] = { oldScore, newScore, direction }
      }
    })

    return diffs
  }, [isDiffing, selectedVersion, previousVersion])

  const selectVersion = useCallback((versionId: number) => {
    setSelectedVersionId(versionId)
  }, [])

  const resetVersioning = useCallback(() => {
    setVersions([])
    versionsRef.current = []
    versionCounterRef.current = 0
    setSelectedVersionId(null)
    setIsDiffing(false)
  }, [])

  return {
    versions,
    selectedVersionId,
    selectedVersion,
    previousVersion,
    isDiffing,
    scoreDiffs,
    createVersion,
    selectVersion,
    setIsDiffing,
    resetVersioning,
    getVersionById,
  }
}
