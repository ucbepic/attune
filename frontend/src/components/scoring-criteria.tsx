"use client"

import { useState, useMemo, useCallback } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Loader2, Plus, Trash2 } from "lucide-react";

interface OtherCriterion {
  name: string;
  edge_count: number;
  total_edges: number;
  avg_score_gap: number;
  favors_higher: number;
}

interface CriterionItem {
  id: string;
  text: string;
  visible: boolean;
}

interface CriterionMeta {
  type?: "boolean" | "integer";
  definition?: string;
}

interface BooleanDistribution {
  type: "boolean";
  trueNodeIds: (string | number)[];
  falseNodeIds: (string | number)[];
  total: number;
}

interface IntegerBin {
  min: number;
  max: number;
  nodeIds: (string | number)[];
  count: number;
}

interface IntegerDistribution {
  type: "integer";
  bins: IntegerBin[];
  total: number;
}

type CriterionDistribution = BooleanDistribution | IntegerDistribution;

const ScoringCriteria = ({
  criteria,
  onCriteriaChange,
  onAddCriterion,
  mappedFeatures,
  selectedCriterion,
  selectedNodeIds,
  onCriterionSelect,
  onNodeSelect,
  rules,
  otherCriteria,
  loadingCriteria,
}: {
  criteria: any[];
  onCriteriaChange?: (criteria: any[]) => void;
  onAddCriterion?: (name: string, definition: string) => void;
  mappedFeatures?: Record<string | number, Record<string, boolean>>;
  selectedCriterion?: string | null;
  selectedNodeIds?: Set<string | number>;
  onCriterionSelect?: (criterion: string | null) => void;
  onNodeSelect?: (nodeIds: Set<string | number>) => void;
  rules?: any[];
  otherCriteria?: OtherCriterion[];
  loadingCriteria?: string[];
}) => {
  const [showAll, setShowAll] = useState(false);
  const [expandedCriterion, setExpandedCriterion] = useState<string | null>(null);
  const [activeBin, setActiveBin] = useState<{ criterion: string; binIndex: number } | null>(null);
  const [hoveredBin, setHoveredBin] = useState<{ criterion: string; binIndex: number } | null>(null);

  const criteriaMetaMap = useMemo(() => {
    const map = new Map<string, CriterionMeta>();
    if (!criteria) return map;
    for (const item of criteria) {
      if (typeof item === "object" && item !== null) {
        const name = item.text ?? item.name;
        if (name) {
          map.set(name, { type: item.type, definition: item.definition });
        }
      }
    }
    return map;
  }, [criteria]);

  const rulesText = useMemo(() => {
    if (!rules || !Array.isArray(rules)) return "";
    return rules.map(r => typeof r === "string" ? r : r.raw || "").join("\n");
  }, [rules]);

  const criteriaInRules = useMemo(() => {
    const inRules = new Set<string>();
    if (!rulesText) return inRules;
    for (const name of criteriaMetaMap.keys()) {
      if (rulesText.includes(name)) inRules.add(name);
    }
    return inRules;
  }, [rulesText, criteriaMetaMap]);


  const criteriaDistributions = useMemo(() => {
    const dists = new Map<string, CriterionDistribution>();
    if (!mappedFeatures) return dists;

    const allNodeIds = Object.keys(mappedFeatures);
    if (allNodeIds.length === 0) return dists;

    const parseId = (id: string): string | number => isNaN(Number(id)) ? id : Number(id);
    const collected = new Map<string, { nodeId: string | number; value: boolean | number }[]>();
    for (const rawId of allNodeIds) {
      const nodeId = parseId(rawId);
      const features = mappedFeatures[rawId];
      if (!features) continue;
      for (const [criterion, value] of Object.entries(features)) {
        if (!collected.has(criterion)) collected.set(criterion, []);
        collected.get(criterion)!.push({ nodeId, value: value as boolean | number });
      }
    }

    for (const [criterion, entries] of collected) {
      const meta = criteriaMetaMap.get(criterion);
      const isBool = meta?.type === "boolean" || (entries.length > 0 && typeof entries[0].value === "boolean");

      if (isBool) {
        const trueNodeIds: (string | number)[] = [];
        const falseNodeIds: (string | number)[] = [];
        for (const e of entries) {
          if (e.value === true) trueNodeIds.push(e.nodeId);
          else falseNodeIds.push(e.nodeId);
        }
        dists.set(criterion, { type: "boolean", trueNodeIds, falseNodeIds, total: entries.length });
      } else {
        const nums = entries.map(e => ({ nodeId: e.nodeId, value: e.value as number }));
        const values = nums.map(n => n.value);
        const min = Math.min(...values);
        const max = Math.max(...values);

        let bins: IntegerBin[];
        if (min === max) {
          bins = [{ min, max, nodeIds: nums.map(n => n.nodeId), count: nums.length }];
        } else {
          const uniqueValues = [...new Set(values)].sort((a, b) => a - b);
          const binCount = Math.min(8, uniqueValues.length);
          const binWidth = (max - min) / binCount;
          bins = Array.from({ length: binCount }, (_, i) => ({
            min: min + i * binWidth,
            max: i === binCount - 1 ? max + 0.001 : min + (i + 1) * binWidth,
            nodeIds: [] as (string | number)[],
            count: 0,
          }));

          for (const n of nums) {
            const binIdx = Math.min(Math.floor((n.value - min) / binWidth), binCount - 1);
            bins[binIdx].nodeIds.push(n.nodeId);
            bins[binIdx].count++;
          }
        }
        dists.set(criterion, { type: "integer", bins, total: entries.length });
      }
    }
    return dists;
  }, [mappedFeatures, criteriaMetaMap]);

  const selectedBinsMap = useMemo(() => {
    const map = new Map<string, Set<number>>();
    if (!selectedNodeIds || selectedNodeIds.size === 0) return map;

    for (const [criterion, dist] of criteriaDistributions) {
      const highlighted = new Set<number>();
      if (dist.type === "boolean") {
        const hasTrue = dist.trueNodeIds.some(id => selectedNodeIds.has(id));
        const hasFalse = dist.falseNodeIds.some(id => selectedNodeIds.has(id));
        if (hasTrue) highlighted.add(0);
        if (hasFalse) highlighted.add(1);
      } else {
        dist.bins.forEach((bin, i) => {
          if (bin.nodeIds.some(id => selectedNodeIds.has(id))) highlighted.add(i);
        });
      }
      if (highlighted.size > 0) map.set(criterion, highlighted);
    }
    return map;
  }, [selectedNodeIds, criteriaDistributions]);

  const handleBinClick = useCallback((e: React.MouseEvent, criterion: string, binIndex: number) => {
    e.stopPropagation();
    if (!onNodeSelect) return;

    const dist = criteriaDistributions.get(criterion);
    if (!dist) return;

    if (activeBin?.criterion === criterion && activeBin?.binIndex === binIndex) {
      setActiveBin(null);
      onNodeSelect(new Set());
      if (onCriterionSelect) onCriterionSelect(null);
      return;
    }

    let nodeIds: (string | number)[];
    if (dist.type === "boolean") {
      nodeIds = binIndex === 0 ? dist.trueNodeIds : dist.falseNodeIds;
    } else {
      nodeIds = dist.bins[binIndex]?.nodeIds ?? [];
    }

    setActiveBin({ criterion, binIndex });
    if (onCriterionSelect) {
      onCriterionSelect(dist.type === "integer" ? criterion : null);
    }
    onNodeSelect(new Set(nodeIds));
  }, [criteriaDistributions, activeBin, onNodeSelect, onCriterionSelect]);

  const getTooltipText = useCallback((criterionName: string, binIndex: number): string => {
    const dist = criteriaDistributions.get(criterionName);
    if (!dist) return "";
    if (dist.type === "boolean") {
      if (binIndex === 0) {
        const pct = dist.total > 0 ? Math.round((dist.trueNodeIds.length / dist.total) * 100) : 0;
        return `True: ${dist.trueNodeIds.length} (${pct}%)`;
      }
      const pct = dist.total > 0 ? Math.round((dist.falseNodeIds.length / dist.total) * 100) : 0;
      return `False: ${dist.falseNodeIds.length} (${pct}%)`;
    }
    const bin = dist.bins[binIndex];
    if (!bin) return "";
    const binMin = Math.round(bin.min);
    const binMax = bin.max % 1 > 0.009 ? Math.round(bin.max) : Math.round(bin.max - 0.001);
    const rangeLabel = binMin === binMax ? `${binMin}` : `${binMin}–${binMax}`;
    return `${rangeLabel}: ${bin.count} items`;
  }, [criteriaDistributions]);

  const CHART_W = 72;
  const BAR_H = 16;
  const AXIS_H = 10;
  const TOTAL_H = BAR_H + AXIS_H;

  const renderInlineChart = (criterionName: string) => {
    const dist = criteriaDistributions.get(criterionName);
    if (!dist) return null;

    const highlightedBins = selectedBinsMap.get(criterionName);
    const isActiveCriterion = activeBin?.criterion === criterionName;
    const isHoveredCriterion = hoveredBin?.criterion === criterionName;
    const showTooltip = isHoveredCriterion && hoveredBin != null;
    const tooltipText = showTooltip ? getTooltipText(criterionName, hoveredBin!.binIndex) : "";

    if (dist.type === "boolean") {
      const truePct = dist.total > 0 ? dist.trueNodeIds.length / dist.total : 0;
      const trueW = Math.round(truePct * CHART_W);
      const falseW = CHART_W - trueW;
      const trueHighlighted = highlightedBins?.has(0) || (isActiveCriterion && activeBin?.binIndex === 0);
      const falseHighlighted = highlightedBins?.has(1) || (isActiveCriterion && activeBin?.binIndex === 1);
      const trueHovered = isHoveredCriterion && hoveredBin?.binIndex === 0;
      const falseHovered = isHoveredCriterion && hoveredBin?.binIndex === 1;
      const hasHighlight = highlightedBins != null || isActiveCriterion;

      return (
        <div className="relative shrink-0" style={{ width: CHART_W }}>
          {showTooltip && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 rounded bg-gray-800 text-white text-[9px] whitespace-nowrap pointer-events-none z-50">
              {tooltipText}
            </div>
          )}
          <svg width={CHART_W} height={TOTAL_H} className="block">
            <rect
              x={0} y={0} width={trueW || 0} height={BAR_H}
              rx={truePct === 1 ? 3 : 0}
              className="cursor-pointer transition-all"
              fill={trueHighlighted || trueHovered || !hasHighlight ? "#a7d7a8" : "#dceedd"}
              opacity={hasHighlight && !trueHighlighted && !trueHovered ? 0.4 : 1}
              stroke={trueHovered ? "#6dba6e" : "none"} strokeWidth={trueHovered ? 1 : 0}
              onClick={(e) => handleBinClick(e, criterionName, 0)}
              onMouseEnter={() => setHoveredBin({ criterion: criterionName, binIndex: 0 })}
              onMouseLeave={() => setHoveredBin(null)}
            />
            <rect
              x={trueW} y={0} width={falseW || 0} height={BAR_H}
              rx={truePct === 0 ? 3 : 0}
              className="cursor-pointer transition-all"
              fill={falseHighlighted || falseHovered || !hasHighlight ? "#e8b4b4" : "#f3dada"}
              opacity={hasHighlight && !falseHighlighted && !falseHovered ? 0.4 : 1}
              stroke={falseHovered ? "#c98a8a" : "none"} strokeWidth={falseHovered ? 1 : 0}
              onClick={(e) => handleBinClick(e, criterionName, 1)}
              onMouseEnter={() => setHoveredBin({ criterion: criterionName, binIndex: 1 })}
              onMouseLeave={() => setHoveredBin(null)}
            />
            <text x={1} y={TOTAL_H - 1} fontSize={8} fill="#9ca3af" dominantBaseline="auto">T</text>
            <text x={CHART_W - 1} y={TOTAL_H - 1} fontSize={8} fill="#9ca3af" textAnchor="end" dominantBaseline="auto">F</text>
          </svg>
        </div>
      );
    }

    const maxCount = Math.max(...dist.bins.map(b => b.count));
    const hasHighlight = highlightedBins != null || isActiveCriterion;
    const n = dist.bins.length;
    const gap = 1;
    const barW = (CHART_W - (n - 1) * gap) / n;
    const minVal = dist.bins[0].min;
    const maxVal = dist.bins[n - 1].max;
    const maxLabel = maxVal % 1 > 0.009 ? String(Math.round(maxVal)) : String(Math.round(maxVal - 0.001));

    return (
      <div className="relative shrink-0" style={{ width: CHART_W }}>
        {showTooltip && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 px-1.5 py-0.5 rounded bg-gray-800 text-white text-[9px] whitespace-nowrap pointer-events-none z-50">
            {tooltipText}
          </div>
        )}
        <svg width={CHART_W} height={TOTAL_H} className="block">
          {dist.bins.map((bin, i) => {
            const barH = maxCount > 0 ? Math.max(2, (bin.count / maxCount) * BAR_H) : 2;
            const isHighlighted = highlightedBins?.has(i) || (isActiveCriterion && activeBin?.binIndex === i);
            const isHovered = isHoveredCriterion && hoveredBin?.binIndex === i;
            const x = i * (barW + gap);
            return (
              <g key={i}>
                <rect
                  x={x} y={0} width={barW} height={BAR_H}
                  fill="transparent"
                  className="cursor-pointer"
                  onClick={(e) => handleBinClick(e, criterionName, i)}
                  onMouseEnter={() => setHoveredBin({ criterion: criterionName, binIndex: i })}
                  onMouseLeave={() => setHoveredBin(null)}
                />
                <rect
                  x={x} y={BAR_H - barH} width={barW} height={barH} rx={1}
                  className="pointer-events-none transition-all"
                  fill={isHighlighted || isHovered || !hasHighlight ? "#0d9488" : "#ccfbf1"}
                  opacity={hasHighlight && !isHighlighted && !isHovered ? 0.35 : 1}
                  stroke={isHovered ? "#0f766e" : "none"} strokeWidth={isHovered ? 1 : 0}
                />
              </g>
            );
          })}
          <text x={1} y={TOTAL_H - 1} fontSize={8} fill="#9ca3af" dominantBaseline="auto">{Math.round(minVal)}</text>
          <text x={CHART_W - 1} y={TOTAL_H - 1} fontSize={8} fill="#9ca3af" textAnchor="end" dominantBaseline="auto">{maxLabel}</text>
        </svg>
      </div>
    );
  };

  const { items, originalById } = useMemo(() => {
    if (!criteria || criteria.length === 0)
      return { items: [] as CriterionItem[], originalById: new Map<string, any>() };

    const itemsList: CriterionItem[] = [];
    const origMap = new Map<string, any>();

    for (let i = 0; i < criteria.length; i++) {
      const raw = criteria[i];
      let entry: CriterionItem;

      if (typeof raw === 'object' && raw !== null && 'id' in raw && 'text' in raw && 'visible' in raw) {
        entry = raw as CriterionItem;
      } else {
        const text = typeof raw === "string" ? raw : raw?.text ?? raw?.name ?? String(raw);
        entry = { id: raw?.id ?? `criterion-${i}`, text, visible: true };
      }

      itemsList.push(entry);
      if (typeof raw === 'object' && raw !== null) {
        origMap.set(entry.id, raw);
      }
    }

    return { items: itemsList, originalById: origMap };
  }, [criteria]);

  const [newCriterion, setNewCriterion] = useState("");
  const [newDefinition, setNewDefinition] = useState("");
  const [isAddFormOpen, setIsAddFormOpen] = useState(false);
  const [showOtherCriteria, setShowOtherCriteria] = useState(false);

  const updateItems = (newItems: CriterionItem[]) => {
    if (!onCriteriaChange) return;
    const merged = newItems.map(item => {
      const original = originalById.get(item.id);
      if (original) {
        return { ...original, id: item.id, text: item.text, visible: item.visible };
      }
      return item;
    });
    onCriteriaChange(merged);
  };

  const sortedItems = [...items].sort((a, b) => {
    if (a.visible === b.visible) return 0;
    return a.visible ? -1 : 1;
  });

  const hasRules = rulesText.length > 0 && criteriaInRules.size > 0;
  const isLoadingItem = (item: CriterionItem) => loadingCriteria?.includes(item.text) ?? false;
  const activeItems = hasRules ? sortedItems.filter(item => criteriaInRules.has(item.text) || isLoadingItem(item)) : sortedItems;
  const inactiveItems = hasRules ? sortedItems.filter(item => !criteriaInRules.has(item.text) && !isLoadingItem(item)) : [];
  const displayItems = showAll ? sortedItems : activeItems;

  const getOriginalIndex = (item: CriterionItem) => items.findIndex((i) => i.id === item.id);

  const toggleVisibility = (item: CriterionItem) => {
    const idx = getOriginalIndex(item);
    const newItems = [...items];
    newItems[idx] = { ...newItems[idx], visible: !newItems[idx].visible };
    updateItems(newItems);
  };

  const deleteCriterion = (item: CriterionItem) => {
    const idx = getOriginalIndex(item);
    updateItems(items.filter((_, i) => i !== idx));
  };

  const addCriterion = () => {
    const name = newCriterion.trim();
    const definition = newDefinition.trim();
    if (!name) return;

    if (onAddCriterion && definition) {
      onAddCriterion(name, definition);
    } else {
      updateItems([...items, { id: `criterion-${Date.now()}`, text: name, visible: true }]);
    }
    setNewCriterion("");
    setNewDefinition("");
    setIsAddFormOpen(false);
  };

  const renderCriterionRow = (item: CriterionItem) => {
    const isSelected = selectedCriterion === item.text;
    const meta = criteriaMetaMap.get(item.text);
    const isExpanded = expandedCriterion === item.text;
    const dist = criteriaDistributions.get(item.text);
    const hasNodeSelection = selectedNodeIds != null && selectedNodeIds.size > 0;
    const shouldDim = hasNodeSelection && !dist;
    const isLoading = loadingCriteria?.includes(item.text) ?? false;

    return (
      <div key={item.id}>
        <div
          onClick={() => {
            if (onCriterionSelect) {
              if (onNodeSelect) onNodeSelect(new Set());
              onCriterionSelect(isSelected ? null : item.text);
            }
            setExpandedCriterion(isExpanded ? null : item.text);
          }}
          className={`
            group flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg transition-all cursor-pointer relative
            ${isSelected ? "bg-[#e4f0f6] ring-1 ring-[#0c5c84]/30" : "hover:bg-gray-50"}
            ${shouldDim ? "opacity-35" : ""}
            ${!item.visible ? "opacity-40" : ""}
          `}
        >
          {meta?.definition ? (
            <ChevronRight className={`h-3 w-3 text-gray-400 shrink-0 transition-transform duration-150 ${isExpanded ? "rotate-90" : ""}`} />
          ) : (
            <div className="w-3 shrink-0" />
          )}

          <span className={`flex-1 text-sm truncate ${
            item.visible
              ? isSelected ? "text-[#0c5c84] font-medium" : "text-gray-700"
              : "line-through text-gray-400"
          }`}>
            {item.text}
          </span>

          {isLoading ? (
            <div className="shrink-0 flex items-center justify-center" style={{ width: CHART_W }}>
              <Loader2 className="h-4 w-4 text-gray-400 animate-spin" />
            </div>
          ) : (
            renderInlineChart(item.text)
          )}

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
            <button
              onClick={(e) => { e.stopPropagation(); toggleVisibility(item); }}
              className="p-0.5 rounded text-gray-400 hover:text-gray-600 cursor-pointer"
              aria-label={item.visible ? "Hide criterion" : "Show criterion"}
            >
              {item.visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            </button>
            <button
              onClick={(e) => { e.stopPropagation(); deleteCriterion(item); }}
              className="p-0.5 rounded text-gray-400 hover:text-red-500 cursor-pointer"
              aria-label="Delete criterion"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {isExpanded && meta?.definition && (
          <p className="pl-2 pr-3 pb-1.5 pt-0.5 text-xs leading-relaxed text-gray-500 select-text">
            {meta.definition}
          </p>
        )}
      </div>
    );
  };

  const renderAddForm = () => {
    if (!isAddFormOpen) {
      return (
        <button
          onClick={() => setIsAddFormOpen(true)}
          className="flex items-center gap-1.5 text-xs text-[#0c5c84] hover:text-[#003953] cursor-pointer pl-1 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>Add criterion</span>
        </button>
      );
    }

    return (
      <div className="space-y-2 p-2 bg-teal-50 rounded-lg border border-teal-600">
        <input
          type="text"
          value={newCriterion}
          onChange={(e) => setNewCriterion(e.target.value)}
          placeholder="Criterion name..."
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-[#0c5c84]/30 focus:border-[#0c5c84]/30 placeholder:text-gray-400"
          autoFocus
        />
        <textarea
          value={newDefinition}
          onChange={(e) => setNewDefinition(e.target.value)}
          placeholder="Definition — how should this criterion be evaluated?"
          rows={2}
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-gray-200 rounded-md focus:outline-none focus:ring-1 focus:ring-[#0c5c84]/30 focus:border-[#0c5c84]/30 placeholder:text-gray-400 resize-none"
        />
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={() => { setIsAddFormOpen(false); setNewCriterion(""); setNewDefinition(""); }}
            className="px-2.5 py-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={addCriterion}
            disabled={!newCriterion.trim() || !newDefinition.trim()}
            className="px-3 py-1 text-xs bg-teal-600 text-white rounded-md hover:bg-[#003953] disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            Apply
          </button>
        </div>
      </div>
    );
  };

  if (!items || items.length === 0) {
    return (
      <div className="space-y-3 px-2">
        {renderAddForm()}
        <p className="text-xs text-gray-400 text-center py-4">
          No criteria discovered yet.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 px-2">
      {renderAddForm()}

      <div className="space-y-0.5 overflow-visible">
        {displayItems.map((item) => renderCriterionRow(item))}
      </div>

      {hasRules && inactiveItems.length > 0 && (
        <div className="pt-1 border-t border-gray-100">
          {!showAll && (
            <p className="text-xs text-gray-400 mb-0.5 pl-1">
              Only showing criteria that impacted scoring decisions, in decreasing order of influence.
            </p>
          )}
          <button
            onClick={() => setShowAll(!showAll)}
            className="text-xs text-[#0c5c84] hover:underline cursor-pointer pl-1"
          >
            {showAll ? `Hide ${inactiveItems.length} unused` : `View all (${inactiveItems.length} more)`}
          </button>
        </div>
      )}

      {otherCriteria && otherCriteria.length > 0 && (
        <div className="pt-2 border-t border-gray-100 mt-1">
          <button
            onClick={() => setShowOtherCriteria(!showOtherCriteria)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 cursor-pointer pl-1 w-full"
          >
            {showOtherCriteria
              ? <ChevronDown className="h-3 w-3" />
              : <ChevronRight className="h-3 w-3" />
            }
            <span>Other observed features ({otherCriteria.length})</span>
          </button>

          {showOtherCriteria && (
            <div className="mt-1.5 space-y-0.5">
              {otherCriteria.map((oc, i) => {
                const impactPct = oc.total_edges > 0
                  ? Math.round((oc.edge_count / oc.total_edges) * 100)
                  : 0;
                return (
                  <div
                    key={i}
                    className="group flex items-center gap-2 pl-5 pr-3 py-1 rounded-lg hover:bg-gray-50 transition-colors"
                  >
                    <span className="flex-1 text-xs text-gray-500 truncate">
                      {oc.name}
                    </span>
                    <span className="text-xs text-gray-400 whitespace-nowrap tabular-nums" title={`Appeared in ${oc.edge_count} of ${oc.total_edges} comparisons`}>
                      {impactPct}% of pairs
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (onCriteriaChange) {
                          const newItem = {
                            id: `criterion-${Date.now()}-${i}`,
                            text: oc.name,
                            name: oc.name,
                            visible: true,
                            type: "boolean" as const,
                            definition: "",
                          };
                          onCriteriaChange([...criteria, newItem]);
                        }
                      }}
                      className="opacity-0 group-hover:opacity-100 p-0.5 rounded text-gray-400 hover:text-[#0c5c84] cursor-pointer transition-opacity"
                      aria-label="Add as criterion"
                      title="Add as criterion"
                    >
                      <Plus className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ScoringCriteria;
