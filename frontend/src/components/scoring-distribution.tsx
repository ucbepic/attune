"use client"

import { useMemo } from 'react';
import { X } from 'lucide-react';

export type DistributionTemplate = 'uniform' | 'gaussian' | 'left-skew' | 'right-skew';

interface ScoringDistributionProps {
  data: Record<string, any>[];
  minScore?: number | null;
  maxScore?: number | null;
  selectedTemplate?: DistributionTemplate | null;
  onTemplateChange?: (template: DistributionTemplate | null) => void;
}

const BAR_MAX_HEIGHT = 80;

export function generateProportions(
  template: DistributionTemplate,
  minScore: number,
  maxScore: number
): Record<number, number> {
  const n = maxScore - minScore + 1;
  const raw: number[] = new Array(n).fill(0);

  switch (template) {
    case 'uniform':
      raw.fill(1);
      break;
    case 'gaussian': {
      const mid = (n - 1) / 2;
      const sigma = Math.max(n / 4, 1);
      for (let i = 0; i < n; i++) {
        raw[i] = Math.exp(-0.5 * ((i - mid) / sigma) ** 2);
      }
      break;
    }
    case 'left-skew': {
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0.5;
        raw[i] = t ** 2.5;
      }
      break;
    }
    case 'right-skew': {
      for (let i = 0; i < n; i++) {
        const t = n > 1 ? i / (n - 1) : 0.5;
        raw[i] = (1 - t) ** 2.5;
      }
      break;
    }
  }

  const sum = raw.reduce((a, b) => a + b, 0);
  const props: Record<number, number> = {};
  for (let i = 0; i < n; i++) {
    props[minScore + i] = sum > 0 ? raw[i] / sum : 1 / n;
  }
  return props;
}

const TEMPLATE_CURVES: { key: DistributionTemplate; label: string; path: string; fill: string }[] = [
  {
    key: 'uniform',
    label: 'Uniform',
    path: 'M5,12 L95,12',
    fill: 'M5,12 L95,12 L95,28 L5,28 Z',
  },
  {
    key: 'gaussian',
    label: 'Normal',
    path: 'M5,22 C15,22 25,20 35,16 C42,12 46,5 50,4 C54,5 58,12 65,16 C75,20 85,22 95,22',
    fill: 'M5,22 C15,22 25,20 35,16 C42,12 46,5 50,4 C54,5 58,12 65,16 C75,20 85,22 95,22 L95,28 L5,28 Z',
  },
  {
    key: 'left-skew',
    label: 'Left skew',
    path: 'M5,22 C15,22 30,21 50,18 C65,14 75,10 82,5 C88,10 92,18 95,22',
    fill: 'M5,22 C15,22 30,21 50,18 C65,14 75,10 82,5 C88,10 92,18 95,22 L95,28 L5,28 Z',
  },
  {
    key: 'right-skew',
    label: 'Right skew',
    path: 'M5,22 C8,18 12,10 18,5 C25,10 35,14 50,18 C70,21 85,22 95,22',
    fill: 'M5,22 C8,18 12,10 18,5 C25,10 35,14 50,18 C70,21 85,22 95,22 L95,28 L5,28 Z',
  },
];

const ScoringDistribution = ({ data, minScore, maxScore, selectedTemplate = null, onTemplateChange }: ScoringDistributionProps) => {

  const scoreCounts = useMemo(() => {
    if (minScore == null || maxScore == null) return {};
    const counts: Record<number, number> = {};
    for (let s = minScore; s <= maxScore; s++) counts[s] = 0;
    data.filter(item => item.score != null && item.score !== '').forEach(item => {
      const score = Number(item.score);
      if (score >= minScore && score <= maxScore) {
        counts[score] = (counts[score] || 0) + 1;
      }
    });
    return counts;
  }, [data, minScore, maxScore]);

  const totalItems = useMemo(() => Object.values(scoreCounts).reduce((a, b) => a + b, 0), [scoreCounts]);

  const currentProportions = useMemo(() => {
    if (totalItems === 0 || minScore == null || maxScore == null) return {};
    const props: Record<number, number> = {};
    for (let s = minScore; s <= maxScore; s++) {
      props[s] = (scoreCounts[s] || 0) / totalItems;
    }
    return props;
  }, [scoreCounts, totalItems, minScore, maxScore]);

  const maxProportion = useMemo(() => Math.max(...Object.values(currentProportions), 0.01), [currentProportions]);

  if (minScore == null || maxScore == null) {
    return (
      <p className="text-sm text-muted-foreground text-center py-4">
        Set min/max score to view distribution.
      </p>
    );
  }

  const scores: number[] = [];
  for (let s = minScore; s <= maxScore; s++) scores.push(s);

  const handleTemplateClick = (key: DistributionTemplate) => {
    const next = selectedTemplate === key ? null : key;
    onTemplateChange?.(next);
  };

  const handleClear = () => {
    onTemplateChange?.(null);
  };

  return (
    <div className="space-y-3 px-2 pt-4 pb-0">
      <div>
        <div className="flex items-end justify-center gap-1 mt-1" style={{ height: BAR_MAX_HEIGHT + 30 }}>
          {scores.map(score => {
            const prop = currentProportions[score] ?? 0;
            const barHeight = maxProportion > 0 ? (prop / maxProportion) * BAR_MAX_HEIGHT : 0;
            const actualCount = scoreCounts[score] ?? 0;

            return (
              <div key={score} className="flex flex-col items-center" style={{ flex: 1, maxWidth: 48 }}>
                <span className="text-xs text-muted-foreground mb-1">
                  {actualCount}
                </span>
                <div
                  className="w-full rounded-t transition-all"
                  style={{
                    height: Math.max(barHeight, 2),
                    backgroundColor: '#4baeae',
                    minWidth: 16,
                  }}
                  title={`Score ${score}: ${actualCount} items`}
                />
                <span className="text-xs mt-1 font-medium">{score}</span>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">Adjust toward a target distribution?</span>
          {selectedTemplate && (
            <button
              onClick={handleClear}
              className="flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              <X className="h-3 w-3" />
              Clear
            </button>
          )}
        </div>
        <div className="flex gap-1.5 mt-1.5">
          {TEMPLATE_CURVES.map(({ key, label, path, fill }) => {
            const isSelected = selectedTemplate === key;
            return (
              <div key={key} className="flex-1 flex flex-col items-center gap-0.5 group relative">
                <button
                  onClick={() => handleTemplateClick(key)}
                  className={`w-full rounded p-1 transition-all cursor-pointer ${
                    isSelected
                      ? 'border border-[#4baeae] bg-[#e0f0f5]'
                      : 'border border-[#d3dfe6] bg-[#f8fbfd] hover:bg-[#e8f4fc] hover:border-[#a0c4d4]'
                  }`}
                >
                  <svg viewBox="0 0 100 32" className="w-full h-4" preserveAspectRatio="none">
                    <path d={fill} fill={isSelected ? '#4baeae' : '#0c5c84'} opacity={isSelected ? 0.2 : 0.08} />
                    <path d={path} fill="none" stroke={isSelected ? '#0c5c84' : '#6b9ab5'} strokeWidth="2" strokeLinecap="round" />
                  </svg>
                </button>
                <span className="absolute -bottom-4 text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ScoringDistribution;
