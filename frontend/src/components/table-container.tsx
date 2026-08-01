"use client"

import { useState, useMemo, useRef, useEffect } from "react";
import Table from "@/components/table";
import ClusterView from "@/components/cluster-view";
import { Switch } from "@/components/ui/switch"
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable"
import { Table2, ScatterChart, Columns2, GitCompareArrows, ChevronDown, PencilIcon, CircleCheckBig } from "lucide-react"
import { VersionSnapshot, ScoreDiff } from "@/hooks/use-versioning"
import type { AnnotationRecord, AnnotationDelta } from "@/hooks/use-scoring"

interface TableContainerProps {
  data: Record<string, any>[];
  onDataChange?: (updatedData: Record<string, any>[], editedIds: (string | number)[]) => void;
  sampledIds?: (string | number)[];
  groupedByScore?: boolean;
  viewSample?: boolean;
  viewMode?: 'table' | 'cluster' | 'split';
  onGroupedByScoreChange?: (value: boolean) => void;
  onViewSampleChange?: (value: boolean) => void;
  onViewModeChange?: (value: 'table' | 'cluster' | 'split') => void;
  selectedFields?: string[];
  minScore?: number | null;
  maxScore?: number | null;
  mappedFeatures?: Record<string | number, Record<string, boolean>>;
  selectedCriterion?: string | null;
  selectedNodeIds?: Set<string | number>;
  onNodeSelect?: (nodeIds: Set<string | number>) => void;
  onCriterionSelect?: (criterion: string | null) => void;
  rules?: any[];
  onScoreRuleClick?: (score: number) => void;
  onZoomedScoreChange?: (score: number | null) => void;
  criteria?: any[];
  versions?: VersionSnapshot[];
  selectedVersionId?: number | null;
  isDiffing?: boolean;
  scoreDiffs?: Record<string | number, ScoreDiff>;
  onVersionSelect?: (versionId: number) => void;
  onDiffToggle?: (value: boolean) => void;
  annotations?: Record<string, AnnotationRecord>;
  annotationDeltas?: Record<string, AnnotationDelta>;
  onAnnotateItem?: (id: string | number, annotatedScore: number) => void;
  showValidationDecorators?: boolean;
  onShowValidationDecoratorsChange?: (value: boolean) => void;
}

const TableContainer = ({ 
  data, 
  onDataChange, 
  sampledIds, 
  groupedByScore = false, 
  viewSample = false, 
  viewMode = 'table',
  onGroupedByScoreChange,
  onViewSampleChange,
  onViewModeChange,
  selectedFields = [], 
  minScore, 
  maxScore,
  mappedFeatures,
  selectedCriterion,
  selectedNodeIds,
  onNodeSelect,
  onCriterionSelect,
  rules,
  onScoreRuleClick,
  onZoomedScoreChange,
  criteria,
  versions = [],
  selectedVersionId,
  isDiffing = false,
  scoreDiffs = {},
  onVersionSelect,
  onDiffToggle,
  annotations = {},
  annotationDeltas = {},
  onAnnotateItem,
  showValidationDecorators = true,
  onShowValidationDecoratorsChange,
}: TableContainerProps) => {
  const [editedIds, setEditedIds] = useState<(string | number)[]>([]);
  const [versionDropdownOpen, setVersionDropdownOpen] = useState(false);
  const [annotateMenuOpen, setAnnotateMenuOpen] = useState(false);
  const [annotationScoreValue, setAnnotationScoreValue] = useState<string>("");
  const versionDropdownRef = useRef<HTMLDivElement>(null);
  const annotateMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (versionDropdownRef.current && !versionDropdownRef.current.contains(e.target as Node)) {
        setVersionDropdownOpen(false);
      }
    };
    if (versionDropdownOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [versionDropdownOpen]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (annotateMenuRef.current && !annotateMenuRef.current.contains(e.target as Node)) {
        setAnnotateMenuOpen(false);
      }
    };
    if (annotateMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [annotateMenuOpen]);
  
  const isGrouped = groupedByScore;
  const showOnlySampled = viewSample;
  
  const setIsGrouped = (value: boolean) => {
    onGroupedByScoreChange?.(value);
  };
  
  const setShowOnlySampled = (value: boolean) => {
    onViewSampleChange?.(value);
  };
  
  const setViewMode = (value: 'table' | 'cluster' | 'split') => {
    onViewModeChange?.(value);
  };

  const selectedCount = selectedNodeIds?.size ?? 0;
  const annotatedCount = Object.keys(annotations).length;

  const annotationScoreOptions = useMemo(() => {
    if (minScore != null && maxScore != null) {
      const lower = Math.min(minScore, maxScore);
      const upper = Math.max(minScore, maxScore);
      const options: number[] = [];
      for (let score = lower; score <= upper; score += 1) {
        options.push(score);
      }
      return options;
    }

    const inferred = Array.from(new Set(
      data
        .map(item => Number(item.score))
        .filter(score => Number.isFinite(score) && Number.isInteger(score))
    )).sort((a, b) => a - b);
    return inferred;
  }, [minScore, maxScore, data]);

  useEffect(() => {
    if (selectedCount === 0) {
      setAnnotateMenuOpen(false);
    }
  }, [selectedCount]);

  useEffect(() => {
    if (!annotateMenuOpen) return;

    if (selectedNodeIds && selectedNodeIds.size === 1) {
      const selectedId = Array.from(selectedNodeIds)[0];
      const existingAnnotation = annotations[String(selectedId)]?.annotatedScore;
      if (existingAnnotation != null) {
        setAnnotationScoreValue(String(existingAnnotation));
        return;
      }
    }

    if (annotationScoreOptions.length > 0) {
      setAnnotationScoreValue(String(annotationScoreOptions[0]));
    }
  }, [annotateMenuOpen, selectedNodeIds, annotations, annotationScoreOptions]);

  const handleApplyAnnotation = () => {
    if (!onAnnotateItem || !selectedNodeIds || selectedNodeIds.size === 0) return;
    const parsedScore = Number(annotationScoreValue);
    if (!Number.isFinite(parsedScore) || !Number.isInteger(parsedScore)) return;
    Array.from(selectedNodeIds).forEach(id => onAnnotateItem(id, parsedScore));
    setAnnotateMenuOpen(false);
  };

  const filteredData = useMemo(() => {
    let result = data;

    if (showOnlySampled && sampledIds && sampledIds.length > 0) {
      const sampledIdStrings = sampledIds.map(id => String(id));
      const sampledIdSet = new Set(sampledIdStrings);
      const sampledIdOrder = new Map(sampledIdStrings.map((id, index) => [id, index]));

      result = result
        .filter(row => row.id !== undefined && sampledIdSet.has(String(row.id)))
        .sort((a, b) => {
          const orderA = sampledIdOrder.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER;
          const orderB = sampledIdOrder.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER;
          return orderA - orderB;
        });
    }

    return result;
  }, [data, showOnlySampled, sampledIds]);

  const scoreColumn = useMemo(() => {
    if (!filteredData || filteredData.length === 0) return null;
    
    const firstRow = filteredData[0];
    const scoreKey = Object.keys(firstRow).find(
      key => key.toLowerCase() === "score"
    );
    
    return scoreKey || null;
  }, [filteredData]);

  const groupedData = useMemo(() => {
    if (!scoreColumn || !isGrouped) return null;

    const groups: Record<string, Record<string, any>[]> = {};
    
    filteredData.forEach(row => {
      const scoreValue = row[scoreColumn];
      if (!groups[scoreValue]) {
        groups[scoreValue] = [];
      }
      groups[scoreValue].push(row);
    });

    return groups;
  }, [filteredData, scoreColumn, isGrouped]);

  const groupedEntries = useMemo(() => {
    if (!groupedData) return [];

    const toNumber = (value: string) => Number(value);

    return Object.entries(groupedData).sort(([scoreA], [scoreB]) => {
      const numA = toNumber(scoreA);
      const numB = toNumber(scoreB);
      const hasNumA = Number.isFinite(numA);
      const hasNumB = Number.isFinite(numB);

      if (hasNumA && hasNumB) {
        return numB - numA;
      }

      if (hasNumA) return -1;
      if (hasNumB) return 1;

      return scoreB.localeCompare(scoreA);
    });
  }, [groupedData]);

  const handleDataChange = (updatedData: Record<string, any>[], newEditedIds: (string | number)[]) => {
    const updatedMap = new Map(updatedData.map(row => [row.id, row]));
    const mergedData = data.map(row => {
      const updated = updatedMap.get(row.id);
      return updated || row;
    });
    
    const combinedEditedIds = [...new Set([...editedIds, ...newEditedIds])];
    setEditedIds(combinedEditedIds);
    
    if (onDataChange) {
      onDataChange(mergedData, combinedEditedIds);
    }
  };

  const hasScores = useMemo(() => {
    return data.some(item => item.score != null && item.score !== '');
  }, [data]);

  const handleScoreChange = (id: string | number, newScore: number | null) => {
    const updatedData = data.map(row => {
      if (row.id === id) {
        return { ...row, score: newScore };
      }
      return row;
    });

    const newEditedIds = [...new Set([...editedIds, id])];
    setEditedIds(newEditedIds);

    if (onDataChange) {
      onDataChange(updatedData, newEditedIds);
    }
  };

  const handleBatchScoreChange = (changes: { id: string | number; newScore: number | null }[]) => {
    const changeMap = new Map(changes.map(c => [c.id, c.newScore]));
    const updatedData = data.map(row => {
      const newScore = changeMap.get(row.id);
      if (newScore !== undefined) {
        return { ...row, score: newScore };
      }
      return row;
    });

    const newEditedIds = [...new Set([...editedIds, ...changes.map(c => c.id)])];
    setEditedIds(newEditedIds);

    if (onDataChange) {
      onDataChange(updatedData, newEditedIds);
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full m-4 bg-white rounded-lg shadow-lg">
      {scoreColumn && (
        <div className="mb-4 flex items-center gap-6 px-4 pt-4 flex-shrink-0">
          {versions.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="relative" ref={versionDropdownRef}>
                <button
                  onClick={() => setVersionDropdownOpen(!versionDropdownOpen)}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm border border-[#d3dfe6] rounded-md bg-[#f0f8ff] hover:bg-[#d3dfe6] transition-colors"
                >
                  <span className="font-medium text-[#003953]">
                    {selectedVersionId ? `v${selectedVersionId}` : 'Versions'}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-[#003953]" />
                </button>
                {versionDropdownOpen && (
                  <div className="absolute top-full left-0 mt-1 w-56 bg-white border border-[#d3dfe6] rounded-md shadow-lg z-50 max-h-64 overflow-y-auto">
                    {versions.map((version) => (
                        <button
                          key={version.id}
                          onClick={() => {
                            onVersionSelect?.(version.id);
                            setVersionDropdownOpen(false);
                          }}
                          className={`w-full text-left px-3 py-2 text-sm hover:bg-[#f0f8ff] transition-colors border-b border-[#f0f0f0] last:border-b-0 ${
                            selectedVersionId === version.id ? 'bg-[#e0f0f5] font-medium' : ''
                          }`}
                        >
                          <div className="font-medium text-[#003953]">v{version.id}</div>
                          <div className="text-xs text-gray-500 mt-0.5">
                            {version.impactedCount} input{version.impactedCount !== 1 ? 's' : ''} impacted
                          </div>
                        </button>
                    ))}
                  </div>
                )}
              </div>
              {versions.length >= 2 && selectedVersionId && selectedVersionId > 1 && (
                <button
                  onClick={() => {
                    const nextDiffing = !isDiffing;
                    if (nextDiffing) {
                      onShowValidationDecoratorsChange?.(false);
                    }
                    onDiffToggle?.(nextDiffing);
                  }}
                  className={`p-1.5 rounded-md border transition-colors ${
                    isDiffing
                      ? 'bg-[#4baeae] border-[#4baeae] text-white'
                      : 'border-[#d3dfe6] bg-[#f0f8ff] text-[#003953] hover:bg-[#d3dfe6]'
                  }`}
                  title={isDiffing ? 'Disable diffing' : 'Compare with previous version'}
                >
                  <GitCompareArrows className="h-4 w-4" />
                </button>
              )}
              {annotatedCount > 0 && (
                <button
                  onClick={() => {
                    const nextValidation = !showValidationDecorators;
                    if (nextValidation) {
                      onDiffToggle?.(false);
                    }
                    onShowValidationDecoratorsChange?.(nextValidation);
                  }}
                  className={`p-1.5 rounded-md border transition-colors ${
                    showValidationDecorators
                      ? 'bg-[#4baeae] border-[#4baeae] text-white'
                      : 'border-[#d3dfe6] bg-[#f0f8ff] text-[#003953] hover:bg-[#d3dfe6]'
                  }`}
                  title={showValidationDecorators ? 'Hide validation decorators' : 'Show Annotated Items'}
                >
                  <CircleCheckBig className="h-4 w-4" />
                </button>
              )}
            </div>
          )}
          {
            <div className="flex items-center gap-1 border border-[#d3dfe6] rounded-md p-1 bg-[#f0f8ff]">
              <button
                onClick={() => setViewMode('table')}
                className={`p-2 rounded ${viewMode === 'table' ? 'bg-white shadow-sm text-[#0c5c84]' : 'text-[#003953] hover:bg-[#d3dfe6]'}`}
                title="Table View"
              >
                <Table2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('split')}
                className={`p-2 rounded ${viewMode === 'split' ? 'bg-white shadow-sm text-[#0c5c84]' : 'text-[#003953] hover:bg-[#d3dfe6]'}`}
                title="Side by Side View"
              >
                <Columns2 className="h-4 w-4" />
              </button>
              <button
                onClick={() => setViewMode('cluster')}
                className={`p-2 rounded ${viewMode === 'cluster' ? 'bg-white shadow-sm text-[#0c5c84]' : 'text-[#003953] hover:bg-[#d3dfe6]'}`}
                title="Cluster View"
              >
                <ScatterChart className="h-4 w-4" />
              </button>
            </div>
          }
          
          {(viewMode === 'table' || viewMode === 'split') && (
            <>
              <label className="flex items-center gap-2 cursor-pointer">
                <Switch
                  checked={isGrouped}
                  onCheckedChange={setIsGrouped}
                />
                <span className="text-sm font-medium">Group by Score</span>
              </label>
            </>
          )}

          <div className="ml-auto relative" ref={annotateMenuRef}>
            {selectedCount > 0 && (
              <>
                <button
                  onClick={() => setAnnotateMenuOpen(prev => !prev)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 transition-colors"
                  title={selectedCount === 1 ? 'Annotate selected input' : `Annotate ${selectedCount} selected inputs`}
                >
                  <PencilIcon className="h-3 w-3" />
                  Annotate Selected ({selectedCount})
                  <ChevronDown className="h-3 w-3" />
                </button>

                {annotateMenuOpen && (
                  <div className="absolute top-full right-0 mt-1 w-52 rounded-md border border-amber-200 bg-white shadow-lg z-50 p-2">
                    <div className="text-[11px] font-medium text-gray-600 mb-1">Choose annotation score</div>
                    <select
                      value={annotationScoreValue}
                      onChange={(e) => setAnnotationScoreValue(e.target.value)}
                      className="w-full text-xs border border-gray-200 rounded-md px-2 py-1 mb-2 bg-white"
                    >
                      {annotationScoreOptions.map(score => (
                        <option key={score} value={String(score)}>{score}</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={handleApplyAnnotation}
                      disabled={annotationScoreOptions.length === 0}
                      className="w-full text-xs rounded-md px-2 py-1.5 border border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      Apply
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {viewMode === 'split' ? (
          <ResizablePanelGroup id="table-split-view" direction="horizontal" className="h-full">
            <ResizablePanel defaultSize={50} minSize={20}>
              <div className="h-full overflow-auto">
                {isGrouped && groupedData ? (
                  <div className="space-y-6 pb-4">
                    {groupedEntries.map(([score, rows]) => (
                      <div key={score}>
                        <Table 
                          data={rows} 
                          header={score ? score : "Not Specified"}
                          onDataChange={handleDataChange}
                          sampledIds={sampledIds}
                          selectedNodeIds={selectedNodeIds}
                          onNodeSelect={onNodeSelect}
                          onCriterionSelect={onCriterionSelect}
                          mappedFeatures={mappedFeatures}
                          selectedCriterion={selectedCriterion}
                          scoreDiffs={scoreDiffs}
                          annotations={annotations}
                          annotationDeltas={annotationDeltas}
                          showValidationDecorators={showValidationDecorators}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  <Table 
                    data={filteredData}
                    header={null}
                    onDataChange={handleDataChange}
                    sampledIds={sampledIds}
                    selectedNodeIds={selectedNodeIds}
                    onNodeSelect={onNodeSelect}
                    onCriterionSelect={onCriterionSelect}
                    mappedFeatures={mappedFeatures}
                    selectedCriterion={selectedCriterion}
                    scoreDiffs={scoreDiffs}
                    annotations={annotations}
                    annotationDeltas={annotationDeltas}
                    showValidationDecorators={showValidationDecorators}
                  />
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel defaultSize={50} minSize={20}>
              <div className="h-full overflow-auto">
                <ClusterView
                  data={data}
                  sampledIds={sampledIds}
                  selectedFields={selectedFields}
                  onScoreChange={handleScoreChange}
                  onBatchScoreChange={handleBatchScoreChange}
                  minScore={minScore}
                  maxScore={maxScore}
                  mappedFeatures={mappedFeatures}
                  selectedCriterion={selectedCriterion}
                  selectedNodeIds={selectedNodeIds}
                  onNodeSelect={onNodeSelect}
                  onCriterionSelect={onCriterionSelect}
                  scoreDiffs={scoreDiffs}
                  rules={rules}
                  onScoreRuleClick={onScoreRuleClick}
                  onZoomedScoreChange={onZoomedScoreChange}
                  criteria={criteria}
                  annotations={annotations}
                  annotationDeltas={annotationDeltas}
                  showValidationDecorators={showValidationDecorators}
                />
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        ) : viewMode === 'cluster' ? (
          <ClusterView
            data={data}
            sampledIds={sampledIds}
            selectedFields={selectedFields}
            onScoreChange={handleScoreChange}
            onBatchScoreChange={handleBatchScoreChange}
            minScore={minScore}
            maxScore={maxScore}
            mappedFeatures={mappedFeatures}
            selectedCriterion={selectedCriterion}
            selectedNodeIds={selectedNodeIds}
            onNodeSelect={onNodeSelect}
            onCriterionSelect={onCriterionSelect}
            scoreDiffs={scoreDiffs}
            rules={rules}
            onScoreRuleClick={onScoreRuleClick}
            onZoomedScoreChange={onZoomedScoreChange}
            criteria={criteria}
            annotations={annotations}
            annotationDeltas={annotationDeltas}
            showValidationDecorators={showValidationDecorators}
          />
        ) : isGrouped && groupedData ? (
          <div className="space-y-6 pb-4">
            {groupedEntries.map(([score, rows]) => (
              <div key={score}>
                <Table 
                  data={rows} 
                  header={score? score : "Not Specified"}
                  onDataChange={handleDataChange}
                  sampledIds={sampledIds}
                  selectedNodeIds={selectedNodeIds}
                  onNodeSelect={onNodeSelect}
                  onCriterionSelect={onCriterionSelect}
                  mappedFeatures={mappedFeatures}
                  selectedCriterion={selectedCriterion}
                  scoreDiffs={scoreDiffs}
                  annotations={annotations}
                  annotationDeltas={annotationDeltas}
                  showValidationDecorators={showValidationDecorators}
                />
              </div>
            ))}
          </div>
        ) : (
          <Table 
              data={filteredData}
              header={null}
              onDataChange={handleDataChange}
              sampledIds={sampledIds}
              selectedNodeIds={selectedNodeIds}
              onNodeSelect={onNodeSelect}
              onCriterionSelect={onCriterionSelect}
              mappedFeatures={mappedFeatures}
              selectedCriterion={selectedCriterion}
              scoreDiffs={scoreDiffs}
              annotations={annotations}
              annotationDeltas={annotationDeltas}
                showValidationDecorators={showValidationDecorators}
          />
        )}
      </div>
    </div>
  );
};

export default TableContainer;