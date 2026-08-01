"use client"

import { useMemo } from "react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface StructuredRule {
  conditions: string[];
  score: number;
  n: number;
  n_total?: number;
  item_ids?: (string | number)[];
  raw: string;
}

interface ScoreGroupModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  score: number | null;
  rules?: StructuredRule[];
  minScore?: number | null;
  maxScore?: number | null;
  itemCount?: number;
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

const ScoreGroupModal = ({ open, onOpenChange, score, rules, minScore, maxScore, itemCount }: ScoreGroupModalProps) => {
  const min = minScore ?? 1;
  const max = maxScore ?? 10;

  const rulesForScore = useMemo(() => {
    if (score === null || !rules || !Array.isArray(rules)) return [];
    return rules.filter(r => r.score === score);
  }, [score, rules]);

  const totalItems = useMemo(() => {
    return rulesForScore.reduce((sum, r) => sum + r.n, 0);
  }, [rulesForScore]);

  if (score === null) return null;

  const color = scoreColor(score, min, max);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <div className="flex items-center gap-3 mb-1">
          <div
            className="flex items-center justify-center w-10 h-10 rounded-lg text-white font-bold text-lg"
            style={{ backgroundColor: color }}
          >
            {score}
          </div>
          <div>
            <DialogTitle>Score {score}</DialogTitle>
            <DialogDescription>
              {itemCount != null ? `${itemCount} items` : `${totalItems} items`}
            </DialogDescription>
          </div>
        </div>

        {rulesForScore.length === 0 ? (
          <p className="text-sm text-gray-400 py-4 text-center">
            No rules target this score.
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-gray-500 uppercase tracking-wide font-medium">
              Items receive score {score} when:
            </p>
            {rulesForScore.map((rule, i) => (
              <div key={i} className="rounded-lg border border-gray-100 bg-gray-50 p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1">
                    {rule.conditions.map((cond, j) => (
                      <div key={j} className="flex items-center gap-1.5 py-0.5">
                        {j > 0 && cond !== "DEFAULT" && (
                          <span className="text-[10px] text-gray-400 font-medium uppercase">and</span>
                        )}
                        <span className="text-[13px] text-gray-700">{cond}</span>
                      </div>
                    ))}
                  </div>
                  <span className="text-[11px] text-gray-400 whitespace-nowrap mt-0.5">
                    {rule.n_total != null && rule.n_total !== rule.n
                      ? `${rule.n}/${rule.n_total}`
                      : `n=${rule.n}`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};

export default ScoreGroupModal;
