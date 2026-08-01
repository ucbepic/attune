"use client"

import { useState } from "react"

import Header from "@/components/header"
import TableContainer from "@/components/table-container"
import ChatPane from "@/components/chat-pane"

import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"

import { useScoring } from "@/hooks/use-scoring"

export default function BaselinePage() {
  const scoring = useScoring({ scoreEndpoint: "/baseline-score" })
  const [isChatOpen, setIsChatOpen] = useState(true)

  return (
    <div className="flex flex-col h-screen overflow-auto">
      <Header
        selectedDataset={scoring.selectedDataset}
        cost={"$" + scoring.cost.toFixed(2).toString()}
        accuracy={scoring.accuracy != null ? scoring.accuracy.toFixed(1) + "%" : undefined}
        consistency={scoring.consistency.toFixed(2) + "%"}
        onDatasetSelect={scoring.handleDatasetSelect}
        onUpload={scoring.handleUpload}
        onDownload={scoring.handleDownload}
        isSemanticScoreOpen={false}
        isInspectorOpen={isChatOpen}
        onToggleSemanticScore={() => {}}
        onToggleInspector={() => setIsChatOpen(!isChatOpen)}
        mode="baseline"
      />

      <ResizablePanelGroup
        id="probe-layout"
        key={`baseline-${isChatOpen}`}
        className="flex-1 overflow-hidden"
        direction="horizontal"
      >
        <ResizablePanel
          defaultSize={isChatOpen ? 75 : 100}
          minSize={50}
          id="baseline-table"
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
            versions={scoring.versions}
            selectedVersionId={scoring.selectedVersionId}
            isDiffing={scoring.isDiffing}
            scoreDiffs={scoring.scoreDiffs}
            onVersionSelect={scoring.handleVersionSelect}
            onDiffToggle={scoring.setIsDiffing}
          />
        </ResizablePanel>

        {isChatOpen && (
          <>
            <ResizableHandle withHandle />
            <ResizablePanel
              defaultSize={25}
              minSize={25}
              maxSize={35}
              id="chat-pane"
              className="overflow-hidden"
            >
              <ChatPane
                mode="probe"
                task={scoring.currentTask ?? scoring.datasetConfig?.task}
                minScore={scoring.minScore ?? scoring.datasetConfig?.minScore}
                maxScore={scoring.maxScore ?? scoring.datasetConfig?.maxScore}
                availableFields={scoring.availableFields}
                selectedFields={scoring.selectedFields}
                resetKey={scoring.datasetEpoch}
                sampledIds={scoring.sampledIds}
                data={scoring.data}
                criteria={scoring.criteria}
                isScoring={scoring.isScoring}
                progress={scoring.scoringProgress}
                progressStatus={scoring.scoringStatus}
                selectedNodeIds={scoring.selectedNodeIds}
                onSelectedNodeIdsChange={scoring.setSelectedNodeIds}
                onScore={scoring.handleScore}
                onCostAdd={(cost) => scoring.setCost((prev: number) => prev + cost)}
                onPromptUpdate={(prompt) => scoring.setCurrentTask(prompt)}
                onScoresUpdate={(scores, cost, updatedPrompt) => {
                  const updatedData = (scoring.data || []).map((item: any) => {
                    const newScore = scores[String(item.id)]
                    return newScore !== undefined ? { ...item, score: newScore } : item
                  })
                  scoring.setData(updatedData)
                  scoring.setDataVersion((prev: number) => prev + 1)
                  scoring.setCost((prev: number) => prev + cost)
                  scoring.createVersionSnapshot(
                    updatedData,
                    scoring.criteria ?? [],
                    [],
                    {},
                    {
                      task: updatedPrompt || scoring.currentTask || scoring.datasetConfig?.task || "",
                      minScore: scoring.minScore ?? scoring.datasetConfig?.minScore ?? null,
                      maxScore: scoring.maxScore ?? scoring.datasetConfig?.maxScore ?? null,
                      selectedFields: scoring.selectedFields,
                      sampleSize: scoring.sampleSize,
                    },
                  )
                }}
              />
            </ResizablePanel>
          </>
        )}
      </ResizablePanelGroup>
    </div>
  )
}
