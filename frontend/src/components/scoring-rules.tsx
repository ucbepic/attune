"use client"

import { useMemo, useRef, useEffect, useState, useCallback } from "react";
import { apiFetch } from "@/hooks/use-scoring";

interface StructuredRule {
  conditions: string[];
  score: number;
  n: number;
  n_total?: number;
  item_ids?: (string | number)[];
  raw: string;
}

interface ScoringRulesProps {
  rules?: StructuredRule[] | string | string[];
  ruleSummaries?: Record<string, string>;
  ruleTransitions?: Record<string, string>;
  minScore?: number | null;
  maxScore?: number | null;
  highlightedScore?: number | null;
  onRuleClick?: (itemIds: (string | number)[]) => void;
  selectedRuleIndex?: number | null;
  task?: string | null;
  onRulesChange?: (rules: StructuredRule[]) => void;
}

interface ParsedRule {
  conditions: string[];
  score: number;
  n: number;
  nTotal?: number;
  itemIds?: (string | number)[];
  originalIndex: number;
}

interface ScoreGroup {
  score: number;
  rules: ParsedRule[];
  totalItems: number;
}

function normalizeRules(rules: StructuredRule[] | string | string[]): ParsedRule[] {
  if (Array.isArray(rules) && rules.length > 0 && typeof rules[0] === "object") {
    return (rules as StructuredRule[]).map((r, i) => ({
      conditions: r.conditions[0] === "DEFAULT" ? ["All items"] : r.conditions,
      score: r.score,
      n: r.n,
      nTotal: r.n_total,
      itemIds: r.item_ids,
      originalIndex: i,
    }));
  }

  const lines = Array.isArray(rules)
    ? (rules as string[]).filter(l => l.trim())
    : typeof rules === "string"
      ? rules.split("\n").filter(l => l.trim())
      : [];

  return lines.map((line, i) => {
    const scoreMatch = line.match(/Score\s*=\s*([\d.]+)/);
    const nMatch = line.match(/\(n=(\d+)\)/);
    const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0;
    const n = nMatch ? parseInt(nMatch[1]) : 1;

    if (line.startsWith("DEFAULT")) {
      return { conditions: ["All items"], score, n, originalIndex: i };
    }

    const condMatch = line.match(/^IF\s+(.+?)\s+THEN/);
    if (!condMatch) return { conditions: ["All items"], score, n, originalIndex: i };

    const conditions = condMatch[1].split(/\s+AND\s+/).map(c => c.trim());
    return { conditions, score, n, originalIndex: i };
  });
}

function scoreColor(score: number, minScore: number, maxScore: number): string {
  if (minScore === maxScore) return "#5a8ab8";
  const t = (score - minScore) / (maxScore - minScore);
  if (t <= 0.5) {
    const u = t / 0.5;
    const r = Math.round(212 + (212 - 212) * u);
    const g = Math.round(92 + (160 - 92) * u);
    const b = Math.round(92 + (74 - 92) * u);
    return `rgb(${r},${g},${b})`;
  } else {
    const u = (t - 0.5) / 0.5;
    const r = Math.round(212 + (77 - 212) * u);
    const g = Math.round(160 + (184 - 160) * u);
    const b = Math.round(74 + (146 - 74) * u);
    return `rgb(${r},${g},${b})`;
  }
}

const ScoringRules = ({ rules, ruleSummaries, ruleTransitions, minScore, maxScore, highlightedScore, onRuleClick, selectedRuleIndex, task, onRulesChange }: ScoringRulesProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [expandedScores, setExpandedScores] = useState<Set<number>>(new Set());
  const [fetchedSummaries, setFetchedSummaries] = useState<Record<string, string>>({});
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [editableRules, setEditableRules] = useState<StructuredRule[]>([]);
  const [editingRuleIndex, setEditingRuleIndex] = useState<number | null>(null);
  const summaryFetchedForRef = useRef<string>("");

  const isStructuredRules = Array.isArray(rules) && rules.length > 0 && typeof rules[0] === "object";

  useEffect(() => {
    if (!Array.isArray(rules) || !isStructuredRules) {
      setEditableRules([]);
      setEditingRuleIndex(null);
      return;
    }
    setEditableRules((rules as StructuredRule[]).map((rule) => ({
      ...rule,
      conditions: Array.isArray(rule.conditions) && rule.conditions.length > 0 ? [...rule.conditions] : ["DEFAULT"],
      item_ids: Array.isArray(rule.item_ids) ? [...rule.item_ids] : [],
    })));
    setEditingRuleIndex(null);
  }, [rules, isStructuredRules]);

  const commitRules = useCallback((nextRules: StructuredRule[]) => {
    setEditableRules(nextRules);
  }, []);

  const updateRule = useCallback((ruleIndex: number, updater: (rule: StructuredRule) => StructuredRule) => {
    const nextRules = editableRules.map((rule, idx) => idx === ruleIndex ? updater(rule) : rule);
    commitRules(nextRules);
  }, [editableRules, commitRules]);

  const addRuleAtScore = useCallback((score: number) => {
    const nextRules = [
      ...editableRules,
      {
        conditions: ["NEW_CRITERION = true"],
        score,
        n: 0,
        n_total: 0,
        item_ids: [],
        raw: "",
      },
    ];
    commitRules(nextRules);
  }, [editableRules, commitRules]);

  const deleteRule = useCallback((ruleIndex: number) => {
    const nextRules = editableRules.filter((_, idx) => idx !== ruleIndex);
    commitRules(nextRules);
  }, [editableRules, commitRules]);

  const addCondition = useCallback((ruleIndex: number) => {
    updateRule(ruleIndex, (rule) => ({
      ...rule,
      conditions: [...(rule.conditions || []), "NEW_CRITERION = true"],
    }));
  }, [updateRule]);

  const removeCondition = useCallback((ruleIndex: number, condIndex: number) => {
    updateRule(ruleIndex, (rule) => {
      const nextConditions = (rule.conditions || []).filter((_, idx) => idx !== condIndex);
      return {
        ...rule,
        conditions: nextConditions.length > 0 ? nextConditions : ["DEFAULT"],
      };
    });
  }, [updateRule]);

  const updateCondition = useCallback((ruleIndex: number, condIndex: number, value: string) => {
    updateRule(ruleIndex, (rule) => {
      const nextConditions = [...(rule.conditions || [])];
      nextConditions[condIndex] = value;
      return {
        ...rule,
        conditions: nextConditions,
      };
    });
  }, [updateRule]);

  const updateScore = useCallback((ruleIndex: number, value: string) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return;
    updateRule(ruleIndex, (rule) => ({ ...rule, score: parsed }));
  }, [updateRule]);

  const summaries = (ruleSummaries && Object.keys(ruleSummaries).length > 0) ? ruleSummaries : fetchedSummaries;

  const hasDraftChanges = useMemo(() => {
    if (!isStructuredRules || !Array.isArray(rules)) return false;
    const normalize = (arr: StructuredRule[]) => arr.map((rule) => ({
      conditions: (rule.conditions || []).map(c => c.trim()).filter(Boolean),
      score: rule.score,
    }));
    return JSON.stringify(normalize(editableRules)) !== JSON.stringify(normalize(rules as StructuredRule[]));
  }, [editableRules, isStructuredRules, rules]);

  const handleApply = useCallback(() => {
    if (!hasDraftChanges) return;
    onRulesChange?.(editableRules);
    setEditingRuleIndex(null);
  }, [editableRules, hasDraftChanges, onRulesChange]);

  const handleCancel = useCallback(() => {
    if (!Array.isArray(rules) || !isStructuredRules) return;
    setEditableRules((rules as StructuredRule[]).map((rule) => ({
      ...rule,
      conditions: Array.isArray(rule.conditions) && rule.conditions.length > 0 ? [...rule.conditions] : ["DEFAULT"],
      item_ids: Array.isArray(rule.item_ids) ? [...rule.item_ids] : [],
    })));
    setEditingRuleIndex(null);
  }, [rules, isStructuredRules]);

  const parsedRules = useMemo(() => {
    if (!rules) return [];
    const sourceRules = isStructuredRules ? editableRules : rules;
    const parsed = normalizeRules(sourceRules as StructuredRule[] | string | string[]);
    parsed.sort((a, b) => a.score - b.score);
    return parsed;
  }, [rules, editableRules, isStructuredRules]);

  const scoreGroups = useMemo<ScoreGroup[]>(() => {
    const groupMap = new Map<number, ParsedRule[]>();
    parsedRules.forEach(rule => {
      const existing = groupMap.get(rule.score) || [];
      existing.push(rule);
      groupMap.set(rule.score, existing);
    });
    return [...groupMap.entries()]
      .sort(([a], [b]) => a - b)
      .map(([score, groupRules]) => ({
        score,
        rules: groupRules,
        totalItems: groupRules.reduce((sum, r) => sum + r.n, 0),
      }));
  }, [parsedRules]);

  const fetchSummaries = useCallback(async () => {
    if (ruleSummaries && Object.keys(ruleSummaries).length > 0) return;
    if (!isStructuredRules) return;
    if (!rules || !Array.isArray(rules) || rules.length === 0) return;
    const fingerprint = JSON.stringify(
      (rules as StructuredRule[]).map(r => `${r.score}:${r.conditions.join(',')}`)
    );
    if (summaryFetchedForRef.current === fingerprint) return;
    summaryFetchedForRef.current = fingerprint;

    setSummaryLoading(true);
    try {
      const response = await apiFetch("/summarize-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task: task || "",
          rules,
          min_score: minScore ?? 1,
          max_score: maxScore ?? 10,
        }),
      });
      const data = await response.json();
      if (data.summaries) {
        setFetchedSummaries(data.summaries);
      }
    } catch (e) {
      console.error("Failed to fetch rule summaries:", e);
    } finally {
      setSummaryLoading(false);
    }
  }, [rules, ruleSummaries, task, minScore, maxScore, isStructuredRules]);

  useEffect(() => {
    fetchSummaries();
  }, [fetchSummaries]);

  useEffect(() => {
    if (highlightedScore == null || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-score-rule="${highlightedScore}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [highlightedScore]);

  useEffect(() => {
    if (highlightedScore != null) {
      setExpandedScores(prev => {
        const next = new Set(prev);
        next.add(highlightedScore);
        return next;
      });
    }
  }, [highlightedScore]);

  const scoreRange = useMemo(() => {
    const uniqueScores = [...new Set(parsedRules.map(r => r.score))];
    const min = minScore ?? (uniqueScores.length > 0 ? Math.min(...uniqueScores) : 0);
    const max = maxScore ?? (uniqueScores.length > 0 ? Math.max(...uniqueScores) : 10);
    return { min, max };
  }, [parsedRules, minScore, maxScore]);

  const toggleExpanded = useCallback((score: number) => {
    setExpandedScores(prev => {
      const next = new Set(prev);
      if (next.has(score)) next.delete(score); else next.add(score);
      return next;
    });
  }, []);

  const transitionSummaries = useMemo(() => {
    const normalized: Record<string, string> = {};
    if (!ruleTransitions) return normalized;

    Object.entries(ruleTransitions).forEach(([key, value]) => {
      if (!value) return;
      normalized[key] = value;

      const [rawFrom, rawTo] = key.split("->").map(part => part.trim());
      if (!rawFrom || !rawTo) return;

      const from = Number(rawFrom);
      const to = Number(rawTo);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        normalized[`${from}->${to}`] = value;
      }
    });

    return normalized;
  }, [ruleTransitions]);

  if (!rules || parsedRules.length === 0) {
    return null;
  }

  return (
    <div ref={containerRef} className="space-y-0 px-2">
      {isStructuredRules && hasDraftChanges && (
        <div className="sticky top-0 z-10 bg-white/95 backdrop-blur-sm py-1.5 mb-1 flex items-center justify-end gap-2 border-b border-gray-100">
          <button
            type="button"
            onClick={handleCancel}
            className="px-2 py-1 text-[11px] rounded border border-gray-300 text-gray-600 hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleApply}
            className="px-2 py-1 text-[11px] rounded border border-[#4baeae] bg-[#4baeae] text-white hover:bg-[#3d9999]"
          >
            Apply
          </button>
        </div>
      )}
      {scoreGroups.map((group, groupIndex) => {
        const color = scoreColor(group.score, scoreRange.min, scoreRange.max);
        const isHighlighted = highlightedScore != null && group.score === highlightedScore;
        const isExpanded = expandedScores.has(group.score);
        const summary = summaries[String(group.score)];

        const prevGroup = groupIndex > 0 ? scoreGroups[groupIndex - 1] : null;
        const transitionKey = prevGroup ? `${prevGroup.score}->${group.score}` : null;
        const transitionSummary = transitionKey
          ? transitionSummaries[transitionKey] || transitionSummaries[`${group.score}->${prevGroup?.score}`]
          : undefined;
        const hasBoundaryContent = Boolean(transitionSummary);

        return (
          <div key={group.score}>
            {prevGroup && hasBoundaryContent && (
              <div className="relative py-1.5 my-0.5">
                <div className="absolute inset-x-0 top-1/2 border-t border-dashed border-gray-200" />
                <div className="relative flex flex-wrap items-center justify-center gap-1 px-2">
                  {prevGroup && (
                    <span
                      aria-label="Downward transition"
                      className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-slate-50 text-slate-500 border border-slate-200 text-xs font-semibold"
                    >
                      ↓
                    </span>
                  )}
                  {transitionSummary && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] bg-amber-50 text-gray-700 border border-amber-200 font-medium">
                      {transitionSummary}
                    </span>
                  )}
                </div>
              </div>
            )}
          <div
            data-score-rule={group.score}
            className={`rounded-lg border transition-colors duration-300 ${
              isHighlighted
                ? 'border-blue-300 bg-blue-50 ring-1 ring-blue-200'
                : 'border-gray-100 bg-white'
            }`}
          >
            <button
              onClick={() => toggleExpanded(group.score)}
              className="w-full px-2.5 py-2 text-left hover:bg-gray-50/50 rounded-lg transition-colors"
            >
              <div className="flex items-center gap-2">
                <div
                  className="flex-shrink-0 w-8 h-8 rounded-md flex items-center justify-center text-white text-sm font-semibold"
                  style={{ backgroundColor: color }}
                >
                  {group.score}
                </div>

                <div className="flex-1 min-w-0">
                  {summary ? (
                    <span className="text-sm text-gray-700 leading-snug">{summary}</span>
                  ) : summaryLoading ? (
                    <span className="text-xs text-gray-300 italic">Summarizing...</span>
                  ) : (
                    <span className="text-xs text-gray-400 italic">
                      {group.rules.length} rule{group.rules.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1.5 flex-shrink-0">
                  <span className="text-xs text-gray-400 tabular-nums">n={group.totalItems}</span>
                  <svg
                    width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
                    className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                  >
                    <path d="m6 9 6 6 6-6"/>
                  </svg>
                </div>
              </div>
            </button>

            {isExpanded && (
              <div className="px-2.5 pb-2.5 space-y-2 border-t border-gray-100 pt-2 ml-[42px]">
                {group.rules.map((rule) => {
                  const isDefault = rule.conditions.length === 1 && rule.conditions[0] === "All items";
                  const isSelected = selectedRuleIndex === rule.originalIndex;
                  const hasClickHandler = onRuleClick && rule.itemIds && rule.itemIds.length > 0;
                  const isEditing = editingRuleIndex === rule.originalIndex;

                  return (
                    <div
                      key={rule.originalIndex}
                      onClick={() => {
                        if (hasClickHandler) {
                          onRuleClick(isSelected ? [] : rule.itemIds!);
                        }
                      }}
                      className={`group relative rounded-md border p-2.5 flex items-center gap-2 transition-colors ${
                        hasClickHandler ? 'cursor-pointer hover:border-gray-400' : ''
                      } ${
                        isSelected
                          ? 'border-[#4baeae] bg-[#f0fafa] ring-1 ring-[#4baeae]/30'
                          : 'border-gray-200 bg-gray-50/70'
                      }`}
                    >
                      {isStructuredRules && !isEditing && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingRuleIndex(rule.originalIndex);
                          }}
                          className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-white"
                        >
                          Edit
                        </button>
                      )}

                      <div className="flex-1 min-w-0 space-y-1.5">
                        {isStructuredRules && isEditing ? (
                          <div className="space-y-1.5">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-gray-500 font-medium">Score</span>
                              <input
                                type="number"
                                value={rule.score}
                                onClick={(e) => e.stopPropagation()}
                                onChange={(e) => updateScore(rule.originalIndex, e.target.value)}
                                className="w-16 h-7 px-2 rounded border border-gray-300 bg-white text-xs text-gray-700"
                              />
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  addCondition(rule.originalIndex);
                                }}
                                className="text-[10px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-white"
                              >
                                + Criterion
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteRule(rule.originalIndex);
                                  setEditingRuleIndex(null);
                                }}
                                className="text-[10px] px-1.5 py-0.5 rounded border border-red-200 text-red-600 hover:bg-red-50"
                              >
                                Delete
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setEditingRuleIndex(null);
                                }}
                                className="text-[10px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-600 hover:bg-white"
                              >
                                Done
                              </button>
                            </div>

                            <div className="space-y-1">
                              {(isDefault ? ["All items"] : rule.conditions).map((cond, j) => (
                                <div key={j} className="flex items-center gap-1.5">
                                  {j > 0 && <span className="text-[10px] text-gray-500 font-semibold">AND</span>}
                                  <input
                                    type="text"
                                    value={cond}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) => updateCondition(rule.originalIndex, j, e.target.value)}
                                    className="flex-1 min-w-0 h-7 px-2 rounded border border-gray-300 bg-white text-xs text-gray-700"
                                  />
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      removeCondition(rule.originalIndex, j);
                                    }}
                                    className="text-[10px] px-1.5 py-0.5 rounded border border-gray-300 text-gray-500 hover:bg-white"
                                  >
                                    x
                                  </button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            {isDefault ? (
                              <span className="text-xs text-gray-500 italic">All other items</span>
                            ) : (
                              rule.conditions.map((cond, j) => (
                                <span key={j} className="flex items-center gap-1.5">
                                  {j > 0 && (
                                    <span className="text-xs text-gray-500 font-semibold">AND</span>
                                  )}
                                  <span className="inline-flex items-center px-2 py-0.5 rounded-md bg-white border border-gray-300 text-xs text-gray-800">
                                    {cond}
                                  </span>
                                </span>
                              ))
                            )}
                          </div>
                        )}
                      </div>

                      <span className="flex-shrink-0 text-xs text-gray-500 tabular-nums">
                        {rule.nTotal != null && rule.nTotal !== rule.n
                          ? `${rule.n}/${rule.nTotal}`
                          : `n=${rule.n}`}
                      </span>
                    </div>
                  );
                })}

                {isStructuredRules && (
                  <div className="pt-0.5 flex justify-end">
                    <button
                      type="button"
                      onClick={() => addRuleAtScore(group.score)}
                      className="inline-flex items-center px-2 py-1 rounded border border-gray-200 text-[11px] text-gray-600 hover:bg-gray-50"
                    >
                      + Rule
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
          </div>
        );
      })}
    </div>
  );
};

export default ScoringRules;
