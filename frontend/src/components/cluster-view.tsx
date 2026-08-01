"use client"

import { useEffect, useLayoutEffect, useRef, useMemo, useState, useCallback } from 'react';
import * as d3 from 'd3';
import { ScoreDiff } from '@/hooks/use-versioning';
import type { AnnotationRecord, AnnotationDelta } from '@/hooks/use-scoring';

interface ClusterViewProps {
  data: Record<string, any>[];
  sampledIds?: (string | number)[];
  selectedFields: string[];
  onScoreChange?: (id: string | number, newScore: number | null) => void;
  onBatchScoreChange?: (changes: { id: string | number; newScore: number | null }[]) => void;
  minScore?: number | null;
  maxScore?: number | null;
  mappedFeatures?: Record<string | number, Record<string, boolean>>;
  selectedCriterion?: string | null;
  selectedNodeIds?: Set<string | number>;
  onNodeSelect?: (nodeIds: Set<string | number>) => void;
  onCriterionSelect?: (criterion: string | null) => void;
  scoreDiffs?: Record<string | number, ScoreDiff>;
  rules?: any[];
  onScoreRuleClick?: (score: number) => void;
  onZoomedScoreChange?: (score: number | null) => void;
  criteria?: any[];
  annotations?: Record<string, AnnotationRecord>;
  annotationDeltas?: Record<string, AnnotationDelta>;
  showValidationDecorators?: boolean;
}

interface NodeData {
  id: string | number;
  score: number;
  rawScore: number | null;
  isNullScore: boolean;
  displayText: string;
  x: number;
  y: number;
  fx?: number | null;
  fy?: number | null;
}

const normalizeItemId = (id: string | number | null | undefined) => String(id);

interface ClusterCenter {
  score: number;
  x: number;
  y: number;
}

interface SubCluster {
  ruleIndex: number;
  conditions: string[];
  nodeIds: Set<string | number>;
}

function computeBTRanking(
  groupNodes: NodeData[],
  allNodes: NodeData[],
  mappedFeatures?: Record<string | number, Record<string, boolean | number>>,
): { id: string | number; btScore: number; percentile: number }[] {
  if (!mappedFeatures || groupNodes.length === 0) {
    return groupNodes.map((n, i) => ({
      id: n.id,
      btScore: 0,
      percentile: groupNodes.length <= 1 ? 100 : Math.round(((groupNodes.length - 1 - i) / (groupNodes.length - 1)) * 100),
    }));
  }

  const criterionKeys = new Set<string>();
  Object.values(mappedFeatures).forEach(feats => {
    Object.keys(feats).forEach(k => criterionKeys.add(k));
  });
  if (criterionKeys.size === 0) {
    return groupNodes.map((n, i) => ({
      id: n.id,
      btScore: 0,
      percentile: groupNodes.length <= 1 ? 100 : Math.round(((groupNodes.length - 1 - i) / (groupNodes.length - 1)) * 100),
    }));
  }

  const criterionWeights = new Map<string, number>();
  for (const key of criterionKeys) {
    let sumWith = 0, countWith = 0, sumWithout = 0, countWithout = 0;
    for (const node of allNodes) {
      const feat = mappedFeatures[node.id];
      if (!feat) { sumWithout += node.score; countWithout++; continue; }
      const val = feat[key];
      if (val === true || (typeof val === 'number' && val > 0)) {
        sumWith += node.score;
        countWith++;
      } else {
        sumWithout += node.score;
        countWithout++;
      }
    }
    const avgWith = countWith > 0 ? sumWith / countWith : 0;
    const avgWithout = countWithout > 0 ? sumWithout / countWithout : 0;
    criterionWeights.set(key, avgWith - avgWithout);
  }

  const scored = groupNodes.map(node => {
    const feat = mappedFeatures[node.id] || {};
    let btScore = 0;
    for (const [key, weight] of criterionWeights) {
      const val = feat[key];
      if (val === true) btScore += weight;
      else if (typeof val === 'number') btScore += val * weight;
    }
    return { id: node.id, btScore };
  });

  scored.sort((a, b) => b.btScore - a.btScore);

  const n = scored.length;
  return scored.map((item, rank) => ({
    ...item,
    percentile: n <= 1 ? 100 : Math.round(((n - 1 - rank) / (n - 1)) * 100),
  }));
}

interface ZoomedScoreViewProps {
  score: number;
  nodes: NodeData[];
  allNodes: NodeData[];
  rules: any[];
  data: Record<string, any>[];
  selectedFields: string[];
  colorScale: (score: number) => string;
  mappedFeatures?: Record<string | number, Record<string, boolean | number>>;
  selectedCriterion?: string | null;
  selectedNodeIds?: Set<string | number>;
  onExit: () => void;
  onScoreRuleClick?: (score: number) => void;
  onNodeSelect?: (nodeIds: Set<string | number>) => void;
  onCriterionSelect?: (criterion: string | null) => void;
  annotations?: Record<string, AnnotationRecord>;
  annotationDeltas?: Record<string, AnnotationDelta>;
  showValidationDecorators?: boolean;
}

const ZoomedScoreView = ({
  score, nodes, allNodes, rules, data, selectedFields, colorScale,
  mappedFeatures, selectedCriterion, selectedNodeIds, onExit,
  onScoreRuleClick, onNodeSelect, onCriterionSelect,
  annotations = {}, annotationDeltas = {}, showValidationDecorators = true,
}: ZoomedScoreViewProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 600, height: 400 });
  const [selectedItemIndex, setSelectedItemIndex] = useState(0);
  const annotatedNodeIds = useMemo(() => {
    const ids = new Set<string | number>();
    Object.keys(annotations).forEach(nodeId => {
      const parsedId = isNaN(Number(nodeId)) ? nodeId : Number(nodeId);
      ids.add(parsedId);
      ids.add(String(parsedId));
    });
    return ids;
  }, [annotations]);

  const onNodeSelectRef = useRef(onNodeSelect);
  const onCriterionSelectRef = useRef(onCriterionSelect);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  useEffect(() => {
    onNodeSelectRef.current = onNodeSelect;
    onCriterionSelectRef.current = onCriterionSelect;
    selectedNodeIdsRef.current = selectedNodeIds;
  }, [onNodeSelect, onCriterionSelect, selectedNodeIds]);

  const highlightedNodeIds = useMemo(() => {
    if (!selectedCriterion || !mappedFeatures) return new Set<string | number>();
    const highlighted = new Set<string | number>();
    const nodeIdSet = new Set(nodes.map(n => n.id));
    Object.entries(mappedFeatures).forEach(([nodeId, features]) => {
      const parsedId = isNaN(Number(nodeId)) ? nodeId : Number(nodeId);
      if (!nodeIdSet.has(parsedId)) return;
      const val = features[selectedCriterion];
      if (val === true || (typeof val === 'number' && !Number.isNaN(val))) {
        highlighted.add(parsedId);
      }
    });
    return highlighted;
  }, [selectedCriterion, mappedFeatures, nodes]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onExit();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExit]);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setDimensions({ width: Math.max((width || 600) * 0.55, 300), height: Math.max(height - 20, 300) });
      }
    };
    updateDimensions();
    const resizeObserver = new ResizeObserver(updateDimensions);
    if (containerRef.current) resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  const subClusters = useMemo<SubCluster[]>(() => {
    if (!rules || !Array.isArray(rules)) return [];
    const nodeIdSet = new Set(nodes.map(n => n.id));
    const assigned = new Set<string | number>();

    const clusters: SubCluster[] = [];
    rules.forEach((r: any, ruleIdx: number) => {
      if (r.score !== score || !Array.isArray(r.item_ids)) return;
      const ids = (r.item_ids as (string | number)[]).filter(id => nodeIdSet.has(id));
      if (ids.length === 0) return;
      ids.forEach(id => assigned.add(id));
      const conditions: string[] = r.conditions && r.conditions[0] !== 'DEFAULT' ? r.conditions : ['All items'];
      clusters.push({
        ruleIndex: ruleIdx,
        conditions,
        nodeIds: new Set(ids),
      });
    });

    const unmatched = nodes.filter(n => !assigned.has(n.id));
    if (unmatched.length > 0) {
      clusters.push({
        ruleIndex: -1,
        conditions: ['Other'],
        nodeIds: new Set(unmatched.map(n => n.id)),
      });
    }

    return clusters;
  }, [rules, score, nodes]);

  const btRanking = useMemo(
    () => computeBTRanking(nodes, allNodes, mappedFeatures),
    [nodes, allNodes, mappedFeatures],
  );

  const btMap = useMemo(() => {
    const map = new Map<string | number, { btScore: number; percentile: number }>();
    btRanking.forEach(r => map.set(r.id, r));
    return map;
  }, [btRanking]);

  const sortedNodes = useMemo(() => {
    const order = new Map(btRanking.map((r, i) => [r.id, i]));
    return [...nodes].sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [nodes, btRanking]);

  const visibleItems = sortedNodes;

  useEffect(() => {
    if (selectedItemIndex >= visibleItems.length) {
      setSelectedItemIndex(Math.max(0, visibleItems.length - 1));
    }
  }, [visibleItems, selectedItemIndex]);

  const clusterColors = useMemo(() => {
    const baseColor = colorScale(score);
    return subClusters.map(() => baseColor);
  }, [subClusters, colorScale, score]);

  const nodeClusterMap = useMemo(() => {
    const map = new Map<string | number, number>();
    subClusters.forEach((c, i) => {
      c.nodeIds.forEach(id => map.set(id, i));
    });
    return map;
  }, [subClusters]);

  useEffect(() => {
    if (!svgRef.current || nodes.length === 0) return;

    const svg = d3.select(svgRef.current);
    const { width, height } = dimensions;
    svg.selectAll('*').remove();

    const paddingX = 70;
    const paddingY = 70;
    const cols = Math.max(1, Math.ceil(Math.sqrt(subClusters.length || 1)));
    const rows = Math.max(1, Math.ceil((subClusters.length || 1) / cols));
    const stepX = cols > 1 ? (width - paddingX * 2) / (cols - 1) : 0;
    const stepY = rows > 1 ? (height - paddingY * 2) / (rows - 1) : 0;
    const centers = subClusters.length <= 1
      ? [{ x: width / 2, y: height / 2 }]
      : subClusters.map((_, i) => {
          const row = Math.floor(i / cols);
          const col = i % cols;
          return {
            x: paddingX + col * stepX,
            y: paddingY + row * stepY,
          };
        });

    const simNodes = nodes.map(node => ({
      ...node,
      x: width / 2 + (Math.random() - 0.5) * 80,
      y: height / 2 + (Math.random() - 0.5) * 80,
    }));

    const clusterForce = (alpha: number) => {
      simNodes.forEach(node => {
        const ci = nodeClusterMap.get(node.id) ?? 0;
        const center = centers[ci] || centers[0];
        node.x! += (center.x - node.x!) * alpha * 0.25;
        node.y! += (center.y - node.y!) * alpha * 0.15;
      });
    };

    const simulation = d3.forceSimulation(simNodes)
      .force('charge', d3.forceManyBody().strength(-25))
      .force('collide', d3.forceCollide().radius(7).strength(0.6))
      .force('cluster', clusterForce)
      .force('y', d3.forceY(height / 2).strength(0.02))
      .alphaDecay(0.008);

    const nodeGroup = svg.append('g').attr('class', 'nodes');
    const nodeElements = nodeGroup.selectAll<SVGCircleElement, typeof simNodes[0]>('circle')
      .data(simNodes)
      .join('circle')
      .attr('r', 7)
      .attr('fill', d => {
        const ci = nodeClusterMap.get(d.id) ?? 0;
        return clusterColors[ci];
      })
      .attr('opacity', 0.85)
      .attr('cursor', 'pointer')
      .attr('stroke', 'none')
      .attr('stroke-width', 0);

    if (showValidationDecorators) {
      const annotationMarkerGroup = svg.append('g').attr('class', 'zoom-annotation-markers');
      simNodes.forEach(node => {
        const key = normalizeItemId(node.id);
        const annotation = annotations[key];
        if (!annotation) return;

        const delta = annotationDeltas[key];
        const cx = Math.max(10, Math.min(width - 10, node.x ?? 0));
        const cy = Math.max(35, Math.min(height - 25, node.y ?? 0));

        if (delta && delta.absoluteDelta > 0) {
          annotationMarkerGroup.append('text')
            .attr('class', 'annotation-delta')
            .attr('data-node-id', key)
            .attr('x', cx)
            .attr('y', cy - 13)
            .attr('text-anchor', 'middle')
            .attr('font-size', '9px')
            .attr('font-weight', 'bold')
            .attr('fill', '#ef4444')
            .attr('pointer-events', 'none')
            .text(`${delta.direction === 'up' ? '+' : delta.direction === 'down' ? '-' : ''}${delta.absoluteDelta.toFixed(1)}`.trim());
        }
      });
    }

    nodeElements.on('click', (event, d) => {
      event.stopPropagation();
      const idx = sortedNodes.findIndex(v => v.id === d.id);
      if (idx >= 0) setSelectedItemIndex(idx);
      if (onCriterionSelectRef.current) onCriterionSelectRef.current(null);
      if (onNodeSelectRef.current) {
        const current = selectedNodeIdsRef.current || new Set<string | number>();
        if (event.metaKey || event.ctrlKey) {
          const next = new Set(current);
          if (next.has(d.id)) next.delete(d.id); else next.add(d.id);
          onNodeSelectRef.current(next);
        } else {
          if (current.size === 1 && current.has(d.id)) {
            onNodeSelectRef.current(new Set());
          } else {
            onNodeSelectRef.current(new Set([d.id]));
          }
        }
      }
    });

    nodeElements
      .on('mouseenter', function() {
        d3.select(this).attr('opacity', 1);
      })
      .on('mouseleave', function() {
        d3.select(this).attr('opacity', 0.85);
      });

    svg.on('click', () => {
      if (onCriterionSelectRef.current) onCriterionSelectRef.current(null);
      if (onNodeSelectRef.current) onNodeSelectRef.current(new Set());
    });

    simulation.on('tick', () => {
      nodeElements
        .attr('cx', d => Math.max(10, Math.min(width - 10, d.x!)))
        .attr('cy', d => Math.max(35, Math.min(height - 25, d.y!)));

      const nodesById = new Map(simNodes.map(n => [String(n.id), n]));
      svg.selectAll('.annotation-ring').each(function() {
        const el = d3.select(this);
        const nid = el.attr('data-node-id');
        const node = nodesById.get(nid);
        if (node) {
          el.attr('cx', Math.max(10, Math.min(width - 10, node.x!)))
            .attr('cy', Math.max(35, Math.min(height - 25, node.y!)));
        }
      });
      svg.selectAll('.annotation-delta').each(function() {
        const el = d3.select(this);
        const nid = el.attr('data-node-id');
        const node = nodesById.get(nid);
        if (node) {
          el.attr('x', Math.max(10, Math.min(width - 10, node.x!)))
            .attr('y', Math.max(35, Math.min(height - 25, node.y!)) - 13);
        }
      });
    });

    simulation.on('end', () => {
      simNodes.forEach(n => { n.fx = n.x; n.fy = n.y; });
    });

    return () => { simulation.stop(); };
  }, [nodes, dimensions, subClusters, clusterColors, nodeClusterMap, sortedNodes, annotations, annotationDeltas, showValidationDecorators]);

  useEffect(() => {
    if (!svgRef.current) return;
    const svg = d3.select(svgRef.current);
    const currentItem = visibleItems[selectedItemIndex];
    const hasParentSelection = selectedNodeIds && selectedNodeIds.size > 0;
    const hasCriterion = selectedCriterion != null && highlightedNodeIds.size > 0;

    svg.selectAll<SVGCircleElement, NodeData>('.nodes circle')
      .attr('stroke', d => {
        if (d.id === currentItem?.id) return '#000';
        if (hasParentSelection && selectedNodeIds!.has(d.id)) return '#000';
        if (hasCriterion && highlightedNodeIds.has(d.id)) return '#000';
        if (annotatedNodeIds.has(d.id)) {
          return '#fde047';
        }
        return 'none';
      })
      .attr('stroke-width', d => {
        if (d.id === currentItem?.id) return 2;
        if (hasParentSelection && selectedNodeIds!.has(d.id)) return 1.5;
        if (hasCriterion && highlightedNodeIds.has(d.id)) return 1.5;
        if (annotatedNodeIds.has(d.id)) return 2.8;
        return 0;
      })
      .attr('opacity', d => {
        if (hasCriterion && !highlightedNodeIds.has(d.id)) return 0.2;
        if (hasParentSelection && !selectedNodeIds!.has(d.id)) return 0.3;
        return 0.85;
        })
        .attr('stroke-dasharray', d => {
          if (d.id === currentItem?.id) return 'none';
          if (hasParentSelection && selectedNodeIds!.has(d.id)) return 'none';
          if (hasCriterion && highlightedNodeIds.has(d.id)) return 'none';
          return 'none';
      });
    }, [selectedItemIndex, visibleItems, selectedNodeIds, selectedCriterion, highlightedNodeIds, annotatedNodeIds]);

  const currentFullItem = useMemo(() => {
    const node = visibleItems[selectedItemIndex];
    if (!node) return null;
    return data.find(d => d.id === node.id) || null;
  }, [visibleItems, selectedItemIndex, data]);

  const currentItemClusterIdx = useMemo(() => {
    const node = visibleItems[selectedItemIndex];
    if (!node) return null;
    return nodeClusterMap.get(node.id) ?? null;
  }, [visibleItems, selectedItemIndex, nodeClusterMap]);

  const currentItemPercentile = useMemo(() => {
    const node = visibleItems[selectedItemIndex];
    if (!node) return null;
    return btMap.get(node.id)?.percentile ?? null;
  }, [visibleItems, selectedItemIndex, btMap]);

  const currentItemAnnotation = useMemo(() => {
    const node = visibleItems[selectedItemIndex];
    if (!node) return null;
    return annotations[normalizeItemId(node.id)] || null;
  }, [visibleItems, selectedItemIndex, annotations]);

  const currentItemDelta = useMemo(() => {
    const node = visibleItems[selectedItemIndex];
    if (!node) return null;
    return annotationDeltas[normalizeItemId(node.id)] || null;
  }, [visibleItems, selectedItemIndex, annotationDeltas]);

  const navigateToItem = useCallback((index: number) => {
    setSelectedItemIndex(index);
    if (onCriterionSelect) onCriterionSelect(null);
    if (onNodeSelect) onNodeSelect(new Set());
  }, [onCriterionSelect, onNodeSelect]);

  const scoreBaseColor = colorScale(score);

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[400px] flex flex-col">
      <div className="flex items-center gap-3 px-3 py-2 border-b border-gray-100 flex-shrink-0">
        <button
          onClick={onExit}
          className="flex items-center gap-1.5 px-2.5 py-1 text-sm rounded-md border border-gray-200 bg-white hover:bg-gray-50 transition-colors text-gray-600"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
          All scores
        </button>
        <div className="flex items-center gap-2">
          <span
            className="inline-flex items-center justify-center w-7 h-7 rounded-md text-white text-sm font-semibold"
            style={{ backgroundColor: scoreBaseColor }}
          >
            {score}
          </span>
          <span className="text-sm text-gray-500">{nodes.length} item{nodes.length !== 1 ? 's' : ''}</span>
        </div>
      </div>

      <div className="flex-1 flex min-h-0">
        <div className="flex-1 min-w-0">
          <svg
            ref={svgRef}
            width={dimensions.width}
            height={dimensions.height}
            className="bg-white select-none"
            style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
          />
        </div>

        <div className="w-[45%] max-w-[420px] min-w-[220px] border-l border-gray-100 flex flex-col bg-gray-50/50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-gray-100 flex-shrink-0">
            <button
              onClick={() => navigateToItem(Math.max(0, selectedItemIndex - 1))}
              disabled={selectedItemIndex <= 0}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6"/></svg>
            </button>
            <div className="flex flex-col items-center">
              <span className="text-xs text-gray-500 tabular-nums">
                {visibleItems.length > 0 ? `${selectedItemIndex + 1} / ${visibleItems.length}` : 'No items'}
              </span>
              {currentItemPercentile !== null && (
                <span className="text-[10px] text-gray-400 tabular-nums">
                </span>
              )}
            </div>
            <button
              onClick={() => navigateToItem(Math.min(visibleItems.length - 1, selectedItemIndex + 1))}
              disabled={selectedItemIndex >= visibleItems.length - 1}
              className="p-1 rounded hover:bg-gray-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6"/></svg>
            </button>
          </div>

          {currentItemClusterIdx !== null && subClusters[currentItemClusterIdx] && (
            <div className="px-3 pt-2 space-y-1.5">
              <div className="flex items-center gap-2">
                {currentItemPercentile !== null && (
                  <span
                    className="inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] tabular-nums"
                    style={{
                      borderColor: scoreBaseColor + '40',
                      color: scoreBaseColor,
                      backgroundColor: scoreBaseColor + '10',
                    }}
                  >
                    {currentItemPercentile}th percentile
                  </span>
                )}
                {showValidationDecorators && currentItemAnnotation && (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md border border-amber-300 text-[11px] text-amber-800 bg-amber-100">
                    Annotated {currentItemAnnotation.annotatedScore}
                  </span>
                )}
                {showValidationDecorators && currentItemDelta && (
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-md border text-[11px] ${
                    currentItemDelta.direction === 'up'
                      ? 'border-green-300 text-green-700 bg-green-50'
                      : currentItemDelta.direction === 'down'
                        ? 'border-red-300 text-red-700 bg-red-50'
                        : 'border-gray-300 text-gray-700 bg-gray-50'
                  }`}>
                    {currentItemDelta.direction === 'up' ? '+' : currentItemDelta.direction === 'down' ? '-' : ''}
                    {currentItemDelta.absoluteDelta.toFixed(2)}
                  </span>
                )}
              </div>
              {subClusters[currentItemClusterIdx].conditions[0] !== 'Other' && (
                <div className="flex flex-wrap gap-1">
                  {subClusters[currentItemClusterIdx].conditions.map((cond, j) => (
                    <span key={j} className="flex items-center gap-1">
                      {j > 0 && <span className="text-[10px] text-gray-300 font-medium">AND</span>}
                      <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-white border border-gray-200 text-[11px] text-gray-600">
                        {cond}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex-1 overflow-y-auto px-3 py-2">
            {currentFullItem ? (
              <div className="space-y-2">
                {(selectedFields.length > 0 ? selectedFields : Object.keys(currentFullItem).filter(k => k !== 'id' && k !== 'score')).map(field => (
                  <div key={field}>
                    <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wide mb-0.5">{field}</div>
                    <div className="text-sm text-gray-800 leading-relaxed whitespace-pre-wrap break-words">
                      {String(currentFullItem[field] ?? '')}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-gray-400 italic">No item selected</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

interface ComparePanelProps {
  selectedNodeIds?: Set<string | number>;
  data: Record<string, any>[];
  selectedFields: string[];
  mappedFeatures?: Record<string | number, Record<string, boolean | number>>;
  criteria?: any[];
  nodes: NodeData[];
  colorScale: (score: number) => string;
  onClose: () => void;
}

const ComparePanel = ({
  selectedNodeIds, data, selectedFields,
  mappedFeatures, criteria, nodes, colorScale, onClose,
}: ComparePanelProps) => {
  const ids = useMemo(() => {
    if (!selectedNodeIds || selectedNodeIds.size !== 2) return [];
    return Array.from(selectedNodeIds);
  }, [selectedNodeIds]);

  const [itemA, itemB] = useMemo(() => {
    if (ids.length !== 2) return [null, null];
    return [
      data.find(d => d.id === ids[0]) || null,
      data.find(d => d.id === ids[1]) || null,
    ];
  }, [ids, data]);

  const [nodeA, nodeB] = useMemo(() => {
    if (ids.length !== 2) return [null, null];
    return [
      nodes.find(n => n.id === ids[0]) || null,
      nodes.find(n => n.id === ids[1]) || null,
    ];
  }, [ids, nodes]);

  const criteriaComparison = useMemo(() => {
    if (!mappedFeatures || ids.length !== 2) return [];
    const featA = mappedFeatures[ids[0]] || {};
    const featB = mappedFeatures[ids[1]] || {};

    const allKeys = new Set([...Object.keys(featA), ...Object.keys(featB)]);

    const nameMap = new Map<string, string>();
    if (criteria) {
      for (const c of criteria) {
        if (typeof c === 'object' && c !== null) {
          const key = c.text ?? c.name;
          if (key) nameMap.set(key, key);
        }
      }
    }

    const visibleKeys = criteria
      ? new Set(criteria.filter((c: any) => c.visible !== false).map((c: any) => c.text ?? c.name))
      : allKeys;

    return Array.from(allKeys)
      .filter(k => visibleKeys.has(k))
      .map(key => {
        const valA = featA[key];
        const valB = featB[key];
        const same = valA === valB;
        return { name: nameMap.get(key) || key, valA, valB, same };
      });
  }, [mappedFeatures, ids, criteria]);

  const differences = criteriaComparison.filter(c => !c.same);
  const similarities = criteriaComparison.filter(c => c.same);

  if (!itemA || !itemB) return null;

  const renderValue = (val: boolean | number | undefined) => {
    if (val === true) return <span className="text-green-600 font-medium">Yes</span>;
    if (val === false) return <span className="text-red-500 font-medium">No</span>;
    if (typeof val === 'number') return <span className="tabular-nums">{val}</span>;
    return <span className="text-gray-300">&mdash;</span>;
  };

  return (
    <div className="absolute inset-0 z-20 bg-white/95 backdrop-blur-sm overflow-y-auto rounded-lg">
      <div className="sticky top-0 bg-white/95 backdrop-blur-sm border-b border-gray-100 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-4">
          {[{ item: itemA, node: nodeA }, { item: itemB, node: nodeB }].map(({ item, node }, i) => (
            <div key={i} className="flex items-center gap-2">
              <span
                className="inline-flex items-center justify-center w-6 h-6 rounded-md text-white text-xs font-semibold"
                style={{ backgroundColor: node ? colorScale(node.score) : '#9ca3af' }}
              >
                {node ? (node.rawScore == null ? 'null' : node.rawScore) : '?'}
              </span>
              <span className="text-sm text-gray-500">#{String(item?.id ?? '?')}</span>
              {i === 0 && <span className="text-gray-300 text-xs">vs</span>}
            </div>
          ))}
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-gray-100 transition-colors text-gray-400 hover:text-gray-600"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
        </button>
      </div>

      <div className="px-4 py-3 space-y-4">
        {criteriaComparison.length > 0 ? (
          <>
            {differences.length > 0 && (
              <div>
                <div className="text-[11px] font-medium text-amber-600 uppercase tracking-wide mb-1.5">
                  Differences ({differences.length})
                </div>
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-3 py-1.5 text-[11px] font-medium text-gray-400">Criterion</th>
                        <th className="text-center px-3 py-1.5 text-[11px] font-medium text-gray-400 w-16">#{String(itemA?.id ?? 'A')}</th>
                        <th className="text-center px-3 py-1.5 text-[11px] font-medium text-gray-400 w-16">#{String(itemB?.id ?? 'B')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {differences.map((c, i) => (
                        <tr key={c.name} className={i % 2 === 0 ? 'bg-amber-50/50' : ''}>
                          <td className="px-3 py-1.5 text-gray-700 text-xs">{c.name}</td>
                          <td className="px-3 py-1.5 text-center text-xs">{renderValue(c.valA)}</td>
                          <td className="px-3 py-1.5 text-center text-xs">{renderValue(c.valB)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {similarities.length > 0 && (
              <div>
                <div className="text-[11px] font-medium text-green-600 uppercase tracking-wide mb-1.5">
                  Similarities ({similarities.length})
                </div>
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200">
                        <th className="text-left px-3 py-1.5 text-[11px] font-medium text-gray-400">Criterion</th>
                        <th className="text-center px-3 py-1.5 text-[11px] font-medium text-gray-400 w-16">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {similarities.map((c, i) => (
                        <tr key={c.name} className={i % 2 === 0 ? 'bg-green-50/40' : ''}>
                          <td className="px-3 py-1.5 text-gray-700 text-xs">{c.name}</td>
                          <td className="px-3 py-1.5 text-center text-xs">{renderValue(c.valA)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="text-xs text-gray-400 italic">No criteria to compare.</div>
        )}

        {(selectedFields.length > 0 ? selectedFields : Object.keys(itemA).filter(k => k !== 'id' && k !== 'score')).map(field => {
          const valA = String(itemA[field] ?? '');
          const valB = String(itemB[field] ?? '');
          const same = valA === valB;
          return (
            <div key={field}>
              <div className="flex items-center gap-2 mb-1">
                <div className="text-[10px] font-medium text-gray-400 uppercase tracking-wide">{field}</div>
                {same && <span className="text-[9px] text-green-600 bg-green-50 px-1 py-0.5 rounded">Same</span>}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className={`text-xs leading-relaxed whitespace-pre-wrap break-words p-2 rounded-md border ${same ? 'bg-gray-50/80 border-gray-100' : 'bg-amber-50/30 border-amber-200/40'}`}>
                  {valA || <span className="text-gray-300 italic">Empty</span>}
                </div>
                <div className={`text-xs leading-relaxed whitespace-pre-wrap break-words p-2 rounded-md border ${same ? 'bg-gray-50/80 border-gray-100' : 'bg-amber-50/30 border-amber-200/40'}`}>
                  {valB || <span className="text-gray-300 italic">Empty</span>}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

function useSimilarItems(
  anchorId: string | number | null,
  threshold: number,
  data: Record<string, any>[],
  mappedFeatures?: Record<string | number, Record<string, boolean | number>>,
  criteria?: any[],
) {
  const visibleKeys = useMemo(() => {
    if (!anchorId || !mappedFeatures) return [];
    const anchorFeats = mappedFeatures[anchorId];
    if (!anchorFeats) return [];
    const allKeys = Object.keys(anchorFeats);
    if (!criteria) return allKeys;
    const visible = new Set(criteria.filter((c: any) => c.visible !== false).map((c: any) => c.text ?? c.name));
    return allKeys.filter(k => visible.has(k));
  }, [mappedFeatures, anchorId, criteria]);

  const matchingIds = useMemo(() => {
    if (!anchorId || !mappedFeatures || visibleKeys.length === 0) return new Set<string | number>();
    const anchorFeats = mappedFeatures[anchorId] || {};
    const ids = new Set<string | number>();

    for (const d of data) {
      if (d.id === anchorId || d.score == null || d.score === '') continue;
      const feats = mappedFeatures[d.id] || {};
      let matching = 0;
      for (const key of visibleKeys) {
        if (anchorFeats[key] === feats[key]) matching++;
      }
      if (matching / visibleKeys.length >= threshold) ids.add(d.id);
    }
    return ids;
  }, [data, mappedFeatures, anchorId, visibleKeys, threshold]);

  return { matchingIds, totalCriteria: visibleKeys.length };
}

const ClusterView = ({ data, sampledIds = [], selectedFields, onScoreChange, onBatchScoreChange, minScore, maxScore, mappedFeatures, selectedCriterion, selectedNodeIds, onNodeSelect, onCriterionSelect, scoreDiffs = {}, rules, onScoreRuleClick, onZoomedScoreChange, criteria, annotations = {}, annotationDeltas = {}, showValidationDecorators = true }: ClusterViewProps) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const simulationRef = useRef<d3.Simulation<NodeData, undefined> | null>(null);
  const nodesRef = useRef<NodeData[]>([]);
  const manuallyPinnedRef = useRef<Set<string | number>>(new Set());
  const onNodeSelectRef = useRef(onNodeSelect);
  const onCriterionSelectRef = useRef(onCriterionSelect);
  const selectedNodeIdsRef = useRef(selectedNodeIds);
  const scoreDiffsRef = useRef(scoreDiffs);
  const annotationsRef = useRef(annotations);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number; content: string; visible: boolean }>({
    x: 0,
    y: 0,
    content: '',
    visible: false
  });
  const [dimensions, setDimensions] = useState({ width: 800, height: 500 });
  const [zoomedScore, setZoomedScoreRaw] = useState<number | null>(null);
  const setZoomedScore = useCallback((s: number | null) => {
    setZoomedScoreRaw(s);
    onZoomedScoreChange?.(s);
  }, [onZoomedScoreChange]);

  const onScoreRuleClickRef = useRef(onScoreRuleClick);

  const [compareOpen, setCompareOpen] = useState(false);

  const [similarOpen, setSimilarOpen] = useState(false);
  const [similarAnchorId, setSimilarAnchorId] = useState<string | number | null>(null);
  const [similarThreshold, setSimilarThreshold] = useState(1.0);
  const similarOpenRef = useRef(false);
  const similarAnchorIdRef = useRef<string | number | null>(null);
  const mappedFeaturesRef = useRef(mappedFeatures);
  const criteriaRef = useRef(criteria);

  const { matchingIds: similarMatchingIds, totalCriteria: similarTotalCriteria } = useSimilarItems(
    similarOpen ? similarAnchorId : null,
    similarThreshold,
    data,
    mappedFeatures,
    criteria,
  );

  useEffect(() => {
    if (!selectedNodeIds || selectedNodeIds.size !== 2) {
      setCompareOpen(false);
    }
  }, [selectedNodeIds]);


  useEffect(() => {
    const handleEscReset = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;

      setCompareOpen(false);
      setSimilarOpen(false);
      setSimilarAnchorId(null);
      setSimilarThreshold(1.0);
      setTooltip(prev => ({ ...prev, visible: false }));
      setZoomedScore(null);

      if (onCriterionSelectRef.current) onCriterionSelectRef.current(null);
      if (onNodeSelectRef.current) onNodeSelectRef.current(new Set());
    };

    window.addEventListener('keydown', handleEscReset);
    return () => window.removeEventListener('keydown', handleEscReset);
  }, [setZoomedScore]);

  useEffect(() => {
    onNodeSelectRef.current = onNodeSelect;
    onCriterionSelectRef.current = onCriterionSelect;
    selectedNodeIdsRef.current = selectedNodeIds;
    scoreDiffsRef.current = scoreDiffs;
    annotationsRef.current = annotations;
    onScoreRuleClickRef.current = onScoreRuleClick;
    similarOpenRef.current = similarOpen;
    similarAnchorIdRef.current = similarAnchorId;
    mappedFeaturesRef.current = mappedFeatures;
    criteriaRef.current = criteria;
  }, [onNodeSelect, onCriterionSelect, selectedNodeIds, scoreDiffs, onScoreRuleClick, similarOpen, similarAnchorId, mappedFeatures, criteria]);

  const highlightedNodeIds = useMemo(() => {
    if (!selectedCriterion || !mappedFeatures) return new Set<string | number>();

    const highlighted = new Set<string | number>();
    Object.entries(mappedFeatures).forEach(([nodeId, features]) => {
      const val = features[selectedCriterion];
      if (val === true || (typeof val === "number" && !Number.isNaN(val))) {
        const parsedId = isNaN(Number(nodeId)) ? nodeId : Number(nodeId);
        highlighted.add(parsedId);
      }
    });
    return highlighted;
  }, [selectedCriterion, mappedFeatures]);

  const annotatedNodeIds = useMemo(() => {
    const annotated = new Set<string | number>();
    Object.keys(annotations).forEach(nodeId => {
      const parsedId = isNaN(Number(nodeId)) ? nodeId : Number(nodeId);
      annotated.add(parsedId);
      annotated.add(String(parsedId));
    });
    return annotated;
  }, [annotations]);

  const integerAnnotations = useMemo(() => {
    if (!selectedCriterion || !mappedFeatures) return null;
    const annotations = new Map<string | number, number>();
    let isInteger = false;
    Object.entries(mappedFeatures).forEach(([nodeId, features]) => {
      const val = features[selectedCriterion];
      if (typeof val === "number" && !Number.isNaN(val)) {
        isInteger = true;
        const parsedId = isNaN(Number(nodeId)) ? nodeId : Number(nodeId);
        annotations.set(parsedId, val);
      }
    });
    return isInteger ? annotations : null;
  }, [selectedCriterion, mappedFeatures]);

  const { nodes, uniqueScores, nullBandScore } = useMemo(() => {
    const buildDisplayText = (item: Record<string, any>) => {
      if (selectedFields.length > 0) {
        return selectedFields.map(field => {
          const value = item[field];
          if (typeof value === 'string' && value.length > 150) {
            return `${field}: ${value.substring(0, 150)}...`;
          }
          return `${field}: ${value}`;
        }).join('\n');
      }
      return Object.entries(item)
        .filter(([key]) => key !== 'id' && key !== 'score' && !key.startsWith('_'))
        .map(([key, value]) => {
          if (typeof value === 'string' && value.length > 150) {
            return `${key}: ${String(value).substring(0, 150)}...`;
          }
          return `${key}: ${value}`;
        })
        .join('\n');
    };

    const numericScores = data
      .map((item) => Number(item.score))
      .filter((value) => Number.isFinite(value));

    const inferredMin = numericScores.length > 0 ? Math.min(...numericScores) : (minScore ?? 0);
    const sampledSet = new Set(sampledIds.map((id) => String(id)));
    const hasSampling = sampledSet.size > 0;
    const nullBucket = inferredMin - 1;

    const allNodes: NodeData[] = data.map((item) => {
      const parsed = Number(item.score);
      const isSampled = !hasSampling || sampledSet.has(String(item.id));
      const isNullScore = isSampled && (item.score == null || item.score === '' || !Number.isFinite(parsed));
      if (!isSampled && (item.score == null || item.score === '')) {
        return null as unknown as NodeData;
      }
      return {
        id: item.id,
        score: isNullScore ? nullBucket : parsed,
        rawScore: isNullScore ? null : parsed,
        isNullScore,
        displayText: buildDisplayText(item),
      } as NodeData;
    }).filter(Boolean) as NodeData[];

    let scores: number[];
    if (minScore != null && maxScore != null) {
      scores = [];
      for (let s = maxScore; s >= minScore; s--) {
        scores.push(s);
      }
    } else {
      scores = [...new Set(allNodes.filter(n => !n.isNullScore).map(d => d.score))].sort((a, b) => b - a);
    }

    const hasNullGroup = allNodes.some(n => n.isNullScore);
    if (hasNullGroup) {
      scores = [...scores, nullBucket];
    }
    return {
      nodes: allNodes,
      uniqueScores: scores,
      nullBandScore: hasNullGroup ? nullBucket : null,
    };
  }, [data, selectedFields, minScore, maxScore, sampledIds]);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        const { width, height } = containerRef.current.getBoundingClientRect();
        setDimensions({ width: width || 800, height: Math.max(height - 60, 400) });
      }
    };

    updateDimensions();
    const resizeObserver = new ResizeObserver(updateDimensions);
    if (containerRef.current) {
      resizeObserver.observe(containerRef.current);
    }
    return () => resizeObserver.disconnect();
  }, []);

  const clusterCenters = useMemo<ClusterCenter[]>(() => {
    const { width, height } = dimensions;
    const paddingY = 60;
    const availableHeight = height - paddingY * 2;

    if (uniqueScores.length === 0) return [];
    if (uniqueScores.length === 1) {
      return [{ score: uniqueScores[0], x: width / 2, y: height / 2 }];
    }

    return uniqueScores.map((score, i) => ({
      score,
      x: width / 2,
      y: paddingY + (i / (uniqueScores.length - 1)) * availableHeight
    }));
  }, [uniqueScores, dimensions]);

  const colorScale = useMemo(() => {
    if (uniqueScores.length === 0) return () => '#9ca3af';
    
    const spectrum = d3.scaleLinear<string>()
      .domain([0, 0.5, 1])
      .range(['#d45c5c', '#d4a04a', '#4db892'])
      .interpolate(d3.interpolateRgb);
    
    return (score: number) => {
      if (nullBandScore != null && score === nullBandScore) return '#9ca3af';
      if (uniqueScores.length === 1) return '#5a8ab8';
      const numericScores = uniqueScores.filter(s => (nullBandScore == null || s !== nullBandScore));
      if (numericScores.length === 0) return '#5a8ab8';
      const min = minScore ?? Math.min(...numericScores);
      const max = maxScore ?? Math.max(...numericScores);
      if (min === max) return '#5a8ab8';
      const normalized = (score - min) / (max - min);
      return spectrum(normalized);
    };
  }, [uniqueScores, minScore, maxScore, nullBandScore]);

  useEffect(() => {
    if (!svgRef.current || clusterCenters.length === 0) return;

    const svg = d3.select(svgRef.current);
    const { width, height } = dimensions;

    svg.selectAll('*').remove();

    const existingPositions = new Map(nodesRef.current.map(n => [n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy }]));
    
    const simulationNodes = nodes.map(node => {
      const existing = existingPositions.get(node.id);
      const center = clusterCenters.find(c => c.score === node.score) || clusterCenters[0];
      const isPinned = manuallyPinnedRef.current.has(node.id);
      
      if (isPinned && existing) {
        return {
          ...node,
          x: existing.x,
          y: existing.y,
          fx: existing.x,
          fy: existing.y
        };
      }
      
      return {
        ...node,
        x: existing?.x ?? center.x + (Math.random() - 0.5) * 200,
        y: existing?.y ?? center.y + (Math.random() - 0.5) * 40
      };
    });
    
    nodesRef.current = simulationNodes;

    const centerX = width / 2;

    const clusterForce = (alpha: number) => {
      simulationNodes.forEach(node => {
        if (node.fx != null && node.fy != null) return;
        const center = clusterCenters.find(c => c.score === node.score);
        if (center) {
          node.x! += (centerX - node.x!) * alpha * 0.1;
          node.y! += (center.y - node.y!) * alpha * 0.3;
        }
      });
    };

    if (simulationRef.current) {
      simulationRef.current.stop();
    }

    const simulation = d3.forceSimulation(simulationNodes)
      .force('charge', d3.forceManyBody().strength(-30))
      .force('collide', d3.forceCollide().radius(6).strength(0.0004))
      .force('cluster', clusterForce)
      .force('x', d3.forceX<NodeData>(centerX).strength(0.01))
      .alphaDecay(0.005);

    simulationRef.current = simulation;

    const labelGroup = svg.append('g').attr('class', 'cluster-labels');
    const labelPadding = 40;

    const zoneHeight = clusterCenters.length > 1
      ? (clusterCenters[1].y - clusterCenters[0].y)
      : height;

    clusterCenters.forEach((center, i) => {
      const zoneY = i === 0
        ? 0
        : center.y - zoneHeight / 2;
      const zoneH = i === 0
        ? center.y + zoneHeight / 2
        : (i === clusterCenters.length - 1 ? height - zoneY : zoneHeight);

      labelGroup.append('rect')
        .attr('class', `cluster-zone cluster-zone-${center.score}`)
        .attr('x', labelPadding)
        .attr('y', zoneY)
        .attr('width', width - labelPadding)
        .attr('height', zoneH)
        .attr('fill', colorScale(center.score))
        .attr('opacity', 0)
        .attr('rx', 8);

      const scoreLabelG = labelGroup.append('g')
        .attr('class', 'score-label')
        .attr('cursor', 'pointer')
        .on('click', (event: MouseEvent) => {
          event.stopPropagation();
          if ((nullBandScore != null && center.score === nullBandScore)) {
            return;
          }
          onScoreRuleClickRef.current?.(center.score);
          setZoomedScore(center.score);
        });

      scoreLabelG.append('text')
        .attr('x', 24)
        .attr('y', center.y + 5)
        .attr('text-anchor', 'middle')
        .attr('font-size', '14px')
        .attr('font-weight', 'bold')
        .attr('fill', (nullBandScore != null && center.score === nullBandScore) ? '#6b7280' : colorScale(center.score))
        .attr('class', 'score-label')
        .text(`${nullBandScore != null && center.score === nullBandScore ? 'null' : center.score}`);

      const labelHeight = 16;
      scoreLabelG.append('line')
        .attr('x1', 34)
        .attr('x2', 34)
        .attr('y1', center.y - labelHeight / 2)
        .attr('y2', center.y + labelHeight / 2)
        .attr('stroke', colorScale(center.score))
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '2,2')
        .attr('opacity', 0.35)
        .attr('class', 'score-label-underline');

      scoreLabelG
        .on('mouseenter', function() {
          d3.select(this).select('.score-label-underline')
            .attr('opacity', 1)
            .attr('stroke-dasharray', 'none');
        })
        .on('mouseleave', function() {
          d3.select(this).select('.score-label-underline')
            .attr('opacity', 0.35)
            .attr('stroke-dasharray', '2,2');
        });

      labelGroup.append('line')
        .attr('x1', labelPadding)
        .attr('y1', center.y)
        .attr('x2', width - 10)
        .attr('y2', center.y)
        .attr('stroke', colorScale(center.score))
        .attr('stroke-opacity', 0.2)
        .attr('stroke-width', 2)
        .attr('stroke-dasharray', '4,4');
    });

    const nodeGroup = svg.append('g').attr('class', 'nodes');

    const nodeElements = nodeGroup.selectAll<SVGCircleElement, typeof simulationNodes[0]>('circle')
      .data(simulationNodes)
      .join('circle')
      .attr('r', 8)
      .attr('fill', d => colorScale(d.score))
      .attr('stroke', 'none')
      .attr('stroke-width', 0)
      .attr('opacity', 1)
      .attr('cursor', 'pointer');

    let dragCompanions: typeof simulationNodes = [];
    let dragStartX = 0;
    let dragStartY = 0;
    let companionStarts: Map<string | number, { x: number; y: number }> = new Map();

    const drag = d3.drag<SVGCircleElement, typeof simulationNodes[0]>()
      .on('start', (event, d) => {
        if (!event.active) simulation.alphaTarget(0.3).restart();
        dragStartX = d.x!;
        dragStartY = d.y!;
        d.fx = d.x;
        d.fy = d.y;

        const sel = selectedNodeIdsRef.current;
        const isGroupDrag = sel && sel.size > 1 && sel.has(d.id);
        dragCompanions = isGroupDrag
          ? simulationNodes.filter(n => n.id !== d.id && sel!.has(n.id))
          : [];
        companionStarts = new Map(dragCompanions.map(n => [n.id, { x: n.x!, y: n.y! }]));

        dragCompanions.forEach(n => { n.fx = n.x; n.fy = n.y; });

        d3.select(event.sourceEvent.target)
          .attr('cursor', 'grabbing')
          .attr('r', 12)
          .attr('opacity', 0.8);

        if (dragCompanions.length > 0) {
          nodeElements.filter((n: any) => sel!.has(n.id) && n.id !== d.id)
            .attr('opacity', 0.8);
        }

        svg.selectAll('.cluster-zone').attr('opacity', 0.15);
      })
      .on('drag', (event, d) => {
        const dx = event.x - dragStartX;
        const dy = event.y - dragStartY;

        d.fx = event.x;
        d.fy = event.y;

        dragCompanions.forEach(n => {
          const start = companionStarts.get(n.id)!;
          const nx = start.x + dx;
          const ny = start.y + dy;
          n.fx = nx;
          n.fy = ny;
          n.x = nx;
          n.y = ny;
        });

        if (dragCompanions.length > 0) {
          const companionIds = new Set(dragCompanions.map(n => n.id));
          nodeElements.filter((n: any) => companionIds.has(n.id))
            .attr('cx', (n: any) => Math.max(50, Math.min(width - 10, n.x!)))
            .attr('cy', (n: any) => Math.max(10, Math.min(height - 10, n.y!)));
        }

        let nearestCenter = clusterCenters[0];
        let minDist = Infinity;
        clusterCenters.forEach(center => {
          const dist = Math.abs(center.y - event.y);
          if (dist < minDist) {
            minDist = dist;
            nearestCenter = center;
          }
        });

        svg.selectAll('.cluster-zone').attr('opacity', 0.1);
        svg.select(`.cluster-zone-${nearestCenter.score}`).attr('opacity', 0.3);

        d3.select(event.sourceEvent.target)
          .attr('fill', colorScale(nearestCenter.score));
        if (dragCompanions.length > 0) {
          const companionIds = new Set(dragCompanions.map(n => n.id));
          nodeElements.filter((n: any) => companionIds.has(n.id))
            .attr('fill', colorScale(nearestCenter.score));
        }
      })
      .on('end', (event, d) => {
        if (!event.active) simulation.alphaTarget(0);

        let nearestCenter = clusterCenters[0];
        let minDist = Infinity;
        const nodeY = d.fy ?? d.y ?? 0;

        clusterCenters.forEach(center => {
          const dist = Math.abs(center.y - nodeY);
          if (dist < minDist) {
            minDist = dist;
            nearestCenter = center;
          }
        });

        const allDragged = [d, ...dragCompanions];
        const batchChanges: { id: string | number; newScore: number | null }[] = [];

        allDragged.forEach(n => {
          const targetRawScore = (nullBandScore != null && nearestCenter.score === nullBandScore)
            ? null
            : nearestCenter.score;
          const scoreChanged = targetRawScore !== n.rawScore;
          if (scoreChanged) {
            n.score = nearestCenter.score;
            n.rawScore = targetRawScore;
            n.isNullScore = targetRawScore == null;
            batchChanges.push({ id: n.id, newScore: targetRawScore });
          }
          n.fx = n.x;
          n.fy = n.y;
          manuallyPinnedRef.current.add(n.id);
        });

        if (batchChanges.length > 0) {
          if (onBatchScoreChange) {
            onBatchScoreChange(batchChanges);
          } else if (onScoreChange) {
            batchChanges.forEach(c => onScoreChange(c.id, c.newScore));
          }
        }

        nodeElements
          .attr('cursor', 'pointer')
          .attr('r', 8)
          .attr('opacity', 1)
          .attr('fill', (n: any) => colorScale(n.score))
          .attr('stroke', 'none')
          .attr('stroke-width', 0);

        svg.selectAll('.cluster-zone').attr('opacity', 0);

        dragCompanions = [];
        companionStarts = new Map();
      });

    nodeElements.call(drag);

    nodeElements.on('click', (event, d) => {
      event.stopPropagation();

      if (similarOpenRef.current) {
        if (onNodeSelectRef.current) {
          onNodeSelectRef.current(new Set([similarAnchorIdRef.current!, d.id]));
        }

        const mf = mappedFeaturesRef.current;
        const anchorId = similarAnchorIdRef.current;
        if (mf && anchorId != null) {
          const anchorFeats = mf[anchorId] || {};
          const nodeFeats = mf[d.id] || {};
          const crit = criteriaRef.current;
          const visibleKeys = crit
            ? Object.keys(anchorFeats).filter(k => crit.some((c: any) => c.visible !== false && (c.text ?? c.name) === k))
            : Object.keys(anchorFeats);

          const lines: string[] = [`#${String(d.id)}  Score: ${d.rawScore == null ? 'null' : d.rawScore}`];
          const annotation = annotationsRef.current[normalizeItemId(d.id)];
          if (annotation) {
            lines.push(`Ground truth annotation: ${annotation.annotatedScore}`);
          }
          const matches: string[] = [];
          const diffs: string[] = [];
          for (const key of visibleKeys) {
            const aVal = anchorFeats[key];
            const nVal = nodeFeats[key];
            const aStr = aVal === true ? 'Yes' : aVal === false ? 'No' : String(aVal ?? '—');
            const nStr = nVal === true ? 'Yes' : nVal === false ? 'No' : String(nVal ?? '—');
            if (aVal === nVal) {
              matches.push(`  ${key}: ${nStr}`);
            } else {
              diffs.push(`  ${key}: ${nStr}  (ref: ${aStr})`);
            }
          }
          if (diffs.length > 0) lines.push(`\nDiffers:`, ...diffs);
          if (matches.length > 0) lines.push(`\nMatches:`, ...matches);

          setTooltip({
            x: event.clientX,
            y: event.clientY - 10,
            content: lines.join('\n'),
            visible: true,
          });
        }
        return;
      }

      if (onCriterionSelectRef.current) {
        onCriterionSelectRef.current(null);
      }
      if (onNodeSelectRef.current) {
        const current = selectedNodeIdsRef.current || new Set<string | number>();
        if (event.metaKey || event.ctrlKey) {
          const next = new Set(current);
          if (next.has(d.id)) {
            next.delete(d.id);
          } else {
            next.add(d.id);
          }
          onNodeSelectRef.current(next);
        } else {
          if (current.size === 1 && current.has(d.id)) {
            onNodeSelectRef.current(new Set());
          } else {
            onNodeSelectRef.current(new Set([d.id]));
          }
        }
      }
    });

    nodeElements
      .on('mouseover', (event, d) => {
          let content = d.displayText;
          const annotation = annotationsRef.current[normalizeItemId(d.id)];
          if (annotation) {
            content += `\nGround truth annotation: ${annotation.annotatedScore}`;
          }
          const diff = scoreDiffsRef.current[d.id];
          if (diff) {
            const arrow = diff.direction === 'up' ? '↑' : diff.direction === 'down' ? '↓' : '';
            if (arrow && diff.oldScore !== null) {
              content += `\nScore: ${d.rawScore == null ? 'null' : d.rawScore} ${arrow} (was ${diff.oldScore})`;
            } else if (diff.direction === 'new') {
              content += `\nScore: ${d.rawScore == null ? 'null' : d.rawScore} (new)`;
            }
          } else {
            content += `\nScore: ${d.rawScore == null ? 'null' : d.rawScore}`;
          }
          setTooltip({
            x: event.clientX,
            y: event.clientY - 10,
            content,
            visible: true
          });
      })
      .on('mouseout', () => {
        setTooltip(prev => ({ ...prev, visible: false }));
      });

    let brushStartPoint: [number, number] | null = null;
    let brushRect: d3.Selection<SVGRectElement, unknown, null, undefined> | null = null;

    svg.on('mousedown', (event: MouseEvent) => {
      if (similarOpenRef.current) return;
      const target = event.target as Element;
      if (target.tagName === 'circle' || target.tagName === 'rect') return;
      if (target.closest('.score-label')) return;
      
      const [mx, my] = d3.pointer(event, svgRef.current);
      brushStartPoint = [mx, my];
      
      brushRect = svg.append('rect')
        .attr('class', 'selection-brush')
        .attr('x', mx)
        .attr('y', my)
        .attr('width', 0)
        .attr('height', 0)
        .attr('fill', 'rgba(75, 174, 174, 0.15)')
        .attr('stroke', '#4baeae')
        .attr('stroke-width', 1)
        .attr('stroke-dasharray', '4,2');
    });

    svg.on('mousemove', (event: MouseEvent) => {
      if (!brushStartPoint || !brushRect) return;
      
      const [mx, my] = d3.pointer(event, svgRef.current);
      const x = Math.min(brushStartPoint[0], mx);
      const y = Math.min(brushStartPoint[1], my);
      const w = Math.abs(mx - brushStartPoint[0]);
      const h = Math.abs(my - brushStartPoint[1]);
      
      brushRect.attr('x', x).attr('y', y).attr('width', w).attr('height', h);
    });

    svg.on('mouseup', (event: MouseEvent) => {
      if (!brushStartPoint || !brushRect) {
        return;
      }
      
      const [mx, my] = d3.pointer(event, svgRef.current);
      const x1 = Math.min(brushStartPoint[0], mx);
      const y1 = Math.min(brushStartPoint[1], my);
      const x2 = Math.max(brushStartPoint[0], mx);
      const y2 = Math.max(brushStartPoint[1], my);
      
      brushRect.remove();
      brushRect = null;
      
      if (x2 - x1 < 5 && y2 - y1 < 5) {
        brushStartPoint = null;
        if (onNodeSelectRef.current) {
          onNodeSelectRef.current(new Set());
        }
        return;
      }
      
      brushStartPoint = null;
      
      const selected = new Set<string | number>();
      simulationNodes.forEach(node => {
        const nx = Math.max(50, Math.min(width - 10, node.x!));
        const ny = Math.max(10, Math.min(height - 10, node.y!));
        if (nx >= x1 && nx <= x2 && ny >= y1 && ny <= y2) {
          selected.add(node.id);
        }
      });
      
      if (onCriterionSelectRef.current) {
        onCriterionSelectRef.current(null);
      }
      
      if (onNodeSelectRef.current && selected.size > 0) {
        if (event.metaKey || event.ctrlKey) {
          const current = selectedNodeIdsRef.current || new Set<string | number>();
          const merged = new Set([...current, ...selected]);
          onNodeSelectRef.current(merged);
        } else {
          onNodeSelectRef.current(selected);
        }
      } else if (onNodeSelectRef.current) {
        onNodeSelectRef.current(new Set());
      }
    });

    const xMin = 50;
    const xMax = width - 10;
    const yMin = 10;
    const yMax = height - 10;
    simulation.on('tick', () => {
      nodeElements
        .attr('cx', d => Math.max(xMin, Math.min(xMax, d.x!)))
        .attr('cy', d => Math.max(yMin, Math.min(yMax, d.y!)));

      const nodesById = new Map(simulationNodes.map(n => [String(n.id), n]));
      svg.selectAll('.diff-ring').each(function() {
        const el = d3.select(this);
        const nid = el.attr('data-node-id');
        const node = nodesById.get(nid);
        if (node) {
          el.attr('cx', Math.max(xMin, Math.min(xMax, node.x!)))
            .attr('cy', Math.max(yMin, Math.min(yMax, node.y!)));
        }
      });
      svg.selectAll('.diff-arrow').each(function() {
        const el = d3.select(this);
        const nid = el.attr('data-node-id');
        const node = nodesById.get(nid);
        if (node) {
          el.attr('x', Math.max(xMin, Math.min(xMax, node.x!)))
            .attr('y', Math.max(yMin, Math.min(yMax, node.y!)) - 14);
        }
      });
      svg.selectAll('.int-annotations text').each(function() {
        const el = d3.select(this);
        const nid = el.attr('data-node-id');
        const node = nodesById.get(nid);
        if (node) {
          el.attr('x', Math.max(xMin, Math.min(xMax, node.x!)))
            .attr('y', Math.max(yMin, Math.min(yMax, node.y!)) + 3.5);
        }
      });
      svg.selectAll('.annotation-delta').each(function() {
        const el = d3.select(this);
        const nid = el.attr('data-node-id');
        const node = nodesById.get(nid);
        if (node) {
          el.attr('x', Math.max(xMin, Math.min(xMax, node.x!)))
            .attr('y', Math.max(yMin, Math.min(yMax, node.y!)) - 13);
        }
      });
    });
    
    simulation.on('end', () => {
      simulationNodes.forEach(node => {
        node.fx = node.x;
        node.fy = node.y;
      });
    });

    return () => {
      simulation.stop();
    };
  }, [nodes, clusterCenters, colorScale, dimensions, onScoreChange, onBatchScoreChange, zoomedScore, nullBandScore]);
  
  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    const nodeElements = svg.selectAll<SVGCircleElement, NodeData>('.nodes circle');
    const hasSelection = selectedNodeIds && selectedNodeIds.size > 0;
    const isSimilarMode = similarOpen && similarAnchorId != null;

    svg.selectAll('.similar-anchor-ring').remove();

    nodeElements
      .attr('r', d => {
        if (isSimilarMode && d.id === similarAnchorId) return 11;
        return 8;
      })
      .attr('stroke', d => {
        if (isSimilarMode) {
          if (d.id === similarAnchorId) return '#000';
          if (similarMatchingIds.has(d.id)) return '#000';
          return 'none';
        }
        if (hasSelection && selectedNodeIds!.has(d.id)) return '#000';
        if (highlightedNodeIds.has(d.id)) return '#000';
        if (annotatedNodeIds.has(d.id)) {
          return '#fde047';
        }
        return 'none';
      })
      .attr('stroke-width', d => {
        if (isSimilarMode) {
          if (d.id === similarAnchorId) return 2.5;
          if (similarMatchingIds.has(d.id)) return 1.5;
          return 0;
        }
        if (hasSelection && selectedNodeIds!.has(d.id)) return 1.5;
        if (highlightedNodeIds.has(d.id)) return 1.5;
        if (annotatedNodeIds.has(d.id)) return 2.8;
        return 0;
      })
      .attr('stroke-dasharray', d => {
        if (isSimilarMode && d.id === similarAnchorId) return '3,1.5';
        return 'none';
      })
      .attr('opacity', d => {
        if (isSimilarMode) {
          if (d.id === similarAnchorId || similarMatchingIds.has(d.id)) return 1;
          return 0.15;
        }
        if (selectedCriterion && !highlightedNodeIds.has(d.id)) return 0.3;
        if (hasSelection && !selectedNodeIds!.has(d.id)) return 0.3;
        return 1;
      });
  }, [highlightedNodeIds, selectedNodeIds, selectedCriterion, similarOpen, similarAnchorId, similarMatchingIds, annotatedNodeIds, showValidationDecorators]);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('.int-annotations').remove();

    if (!integerAnnotations) return;

    const simNodes = nodesRef.current;
    if (!simNodes || simNodes.length === 0) return;

    const { width, height } = dimensions;
    const annGroup = svg.append('g').attr('class', 'int-annotations');

    simNodes.forEach(node => {
      const val = integerAnnotations.get(node.id);
      if (val == null) return;

      const cx = Math.max(50, Math.min(width - 10, node.x ?? 0));
      const cy = Math.max(10, Math.min(height - 10, node.y ?? 0));

      annGroup.append('text')
        .attr('data-node-id', String(node.id))
        .attr('x', cx)
        .attr('y', cy + 3.5)
        .attr('text-anchor', 'middle')
        .attr('font-size', '9px')
        .attr('font-weight', 'bold')
        .attr('fill', '#fff')
        .attr('pointer-events', 'none')
        .text(String(val));
    });
  }, [integerAnnotations, nodes, clusterCenters, dimensions]);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('.diff-markers').remove();

    const hasDiffs = Object.keys(scoreDiffs).length > 0;
    if (!hasDiffs) return;

    const simNodes = nodesRef.current;
    if (!simNodes || simNodes.length === 0) return;

    const { width, height } = dimensions;
    const markersGroup = svg.append('g').attr('class', 'diff-markers');

    simNodes.forEach(node => {
      const diff = scoreDiffs[node.id];
      if (!diff) return;

      const cx = Math.max(50, Math.min(width - 10, node.x ?? 0));
      const cy = Math.max(10, Math.min(height - 10, node.y ?? 0));
      const r = 8;

      markersGroup.append('circle')
        .attr('class', 'diff-ring')
        .attr('data-node-id', String(node.id))
        .attr('cx', cx)
        .attr('cy', cy)
        .attr('r', r + 4)
        .attr('fill', 'none')
        .attr('stroke', diff.direction === 'up' ? '#16a34a' : diff.direction === 'down' ? '#ef4444' : '#3b82f6')
        .attr('stroke-width', 1.5)
        .attr('stroke-dasharray', '3,2')
        .attr('pointer-events', 'none');

      const arrowY = cy - r - 6;
      if (diff.direction === 'up') {
        markersGroup.append('text')
          .attr('class', 'diff-arrow')
          .attr('data-node-id', String(node.id))
          .attr('x', cx)
          .attr('y', arrowY)
          .attr('text-anchor', 'middle')
          .attr('font-size', '9px')
          .attr('fill', '#16a34a')
          .attr('font-weight', 'bold')
          .attr('pointer-events', 'none')
          .text('\u25B2');
      } else if (diff.direction === 'down') {
        markersGroup.append('text')
          .attr('class', 'diff-arrow')
          .attr('data-node-id', String(node.id))
          .attr('x', cx)
          .attr('y', arrowY)
          .attr('text-anchor', 'middle')
          .attr('font-size', '9px')
          .attr('fill', '#ef4444')
          .attr('font-weight', 'bold')
          .attr('pointer-events', 'none')
          .text('\u25BC');
      }
    });
  }, [scoreDiffs, nodes, clusterCenters, dimensions]);

  useEffect(() => {
    if (!svgRef.current) return;

    const svg = d3.select(svgRef.current);
    svg.selectAll('.annotation-markers').remove();

    if (!showValidationDecorators || Object.keys(annotations).length === 0) return;

    const simNodes = nodesRef.current;
    if (!simNodes || simNodes.length === 0) return;

    const { width, height } = dimensions;
    const markersGroup = svg.append('g').attr('class', 'annotation-markers');

    simNodes.forEach(node => {
      const key = normalizeItemId(node.id);
      const annotation = annotations[key];
      if (!annotation) return;

      const delta = annotationDeltas[key];
      const cx = Math.max(50, Math.min(width - 10, node.x ?? 0));
      const cy = Math.max(10, Math.min(height - 10, node.y ?? 0));

      if (delta && delta.absoluteDelta > 0) {
        markersGroup.append('text')
          .attr('class', 'annotation-delta')
          .attr('data-node-id', key)
          .attr('x', cx)
          .attr('y', cy - 13)
          .attr('text-anchor', 'middle')
          .attr('font-size', '9px')
          .attr('font-weight', 'bold')
          .attr('fill', '#ef4444')
          .attr('pointer-events', 'none')
          .text(`${delta.direction === 'up' ? '+' : delta.direction === 'down' ? '-' : ''}${delta.absoluteDelta.toFixed(1)}`.trim());
      }
    });
        }, [annotations, annotationDeltas, nodes, clusterCenters, dimensions, showValidationDecorators]);

  useLayoutEffect(() => {
    if (!tooltip.visible || !tooltipRef.current) return;
    const el = tooltipRef.current;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const pad = 8;

    let left = tooltip.x - rect.width / 2;
    let top = tooltip.y - rect.height;

    if (left < pad) left = pad;
    if (left + rect.width > vw - pad) left = vw - rect.width - pad;

    if (top < pad) top = tooltip.y + 20;

    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    el.style.transform = 'none';
  }, [tooltip]);

  const zoomedNodes = useMemo(() => {
    if (zoomedScore === null) return [];
    return nodes.filter(n => n.score === zoomedScore);
  }, [nodes, zoomedScore]);

  const handleZoomExit = useCallback(() => setZoomedScore(null), []);

  if (nodes.length === 0 && clusterCenters.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        No scores available yet.
      </div>
    );
  }

  if (zoomedScore !== null && zoomedNodes.length > 0) {
    return (
      <ZoomedScoreView
        score={zoomedScore}
        nodes={zoomedNodes}
        allNodes={nodes}
        rules={rules || []}
        data={data}
        selectedFields={selectedFields}
        colorScale={colorScale}
        mappedFeatures={mappedFeatures}
        selectedCriterion={selectedCriterion}
        selectedNodeIds={selectedNodeIds}
        onExit={handleZoomExit}
        onScoreRuleClick={onScoreRuleClick}
        onNodeSelect={onNodeSelect}
        onCriterionSelect={onCriterionSelect}
        annotations={annotations}
        annotationDeltas={annotationDeltas}
        showValidationDecorators={showValidationDecorators}
      />
    );
  }

  return (
    <div ref={containerRef} className="relative w-full h-full min-h-[400px]">
      <svg
        ref={svgRef}
        width={dimensions.width}
        height={dimensions.height}
        className="bg-white rounded-lg select-none"
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      />

      {tooltip.visible && (
        <div
          ref={tooltipRef}
          className="fixed pointer-events-none bg-gray-900 text-white text-xs px-3 py-2 rounded-lg shadow-lg max-w-xs z-50"
          style={{
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -100%)'
          }}
        >
          <pre className="whitespace-pre-wrap font-sans">{tooltip.content}</pre>
        </div>
      )}

      {!compareOpen && !similarOpen && selectedNodeIds && selectedNodeIds.size >= 1 && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 z-10">
          {selectedNodeIds.size === 1 && (
            <button
              onClick={() => {
                const id = Array.from(selectedNodeIds)[0];
                setSimilarAnchorId(id);
                setSimilarOpen(true);
              }}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-gray-200 bg-white shadow-sm hover:bg-gray-50 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
              Find similar
            </button>
          )}
          {selectedNodeIds.size === 2 && (
            <button
              onClick={() => setCompareOpen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-gray-200 bg-white shadow-sm hover:bg-gray-50 transition-colors"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M16 3h5v5"/><path d="M8 3H3v5"/><path d="M12 22v-8.3a4 4 0 0 0-1.172-2.872L3 3"/><path d="m15 9 6-6"/></svg>
              Compare
            </button>
          )}
        </div>
      )}

      {compareOpen && (
        <ComparePanel
          selectedNodeIds={selectedNodeIds}
          data={data}
          selectedFields={selectedFields}
          mappedFeatures={mappedFeatures}
          criteria={criteria}
          nodes={nodes}
          colorScale={colorScale}
          onClose={() => setCompareOpen(false)}
        />
      )}

      {similarOpen && similarAnchorId != null && (
        <div className="absolute bottom-3 left-3 right-3 z-20 flex items-center gap-3 px-3 py-2 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-lg shadow-sm">
          <div className="flex items-center gap-1.5 text-xs text-gray-500 whitespace-nowrap">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
            <span className="font-medium text-gray-700">#{String(similarAnchorId)}</span>
          </div>

          <div className="flex items-center gap-2 flex-1 min-w-0">
            <span className="text-[11px] font-medium text-gray-600 whitespace-nowrap">Relaxed</span>
            <input
              type="range"
              min={0}
              max={1}
              step={similarTotalCriteria > 0 ? 1 / similarTotalCriteria : 0.1}
              value={similarThreshold}
              onChange={e => setSimilarThreshold(parseFloat(e.target.value))}
              className="flex-1 h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-teal-600 [&::-webkit-slider-thumb]:shadow-sm [&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-teal-600 [&::-moz-range-thumb]:border-0"
            />
            <span className="text-[11px] font-medium text-gray-600 whitespace-nowrap">Exact</span>
          </div>

          <div className="text-xs tabular-nums font-medium text-gray-600 whitespace-nowrap">
            {similarMatchingIds.size} match{similarMatchingIds.size !== 1 ? 'es' : ''}
            {similarTotalCriteria > 0 && (
              <span className="text-gray-400 font-normal ml-1">
                on {Math.ceil(similarThreshold * similarTotalCriteria)}/{similarTotalCriteria} criteria
              </span>
            )}
          </div>

          <button
            onClick={() => {
              setSimilarOpen(false);
              setSimilarAnchorId(null);
              setSimilarThreshold(1.0);
            }}
            className="p-0.5 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
        </div>
      )}

    </div>
  );
};

export default ClusterView;
