"use client"

import ScoringCriteria from "@/components/scoring-criteria";
import ScoringRules from "@/components/scoring-rules";
import ScoringDistribution, { DistributionTemplate } from "@/components/scoring-distribution";
import { BarChart3, Scale, ListChecks } from "lucide-react";

import {
    Accordion,
    AccordionContent,
    AccordionItem,
    AccordionTrigger,
  } from "@/components/ui/accordion"

const Inspector = (
    { data, criteria, otherCriteria, rules, ruleSummaries, ruleTransitions, minScore, maxScore, onCriteriaChange, onAddCriterion, mappedFeatures, selectedCriterion, selectedNodeIds, onCriterionSelect, onNodeSelect, selectedDistributionTemplate, onDistributionTemplateChange, highlightedScore, onRuleClick, selectedRuleIndex, task, loadingCriteria, onRulesChange }: {
      data: Record<string, any>[],
      criteria: any[],
      otherCriteria?: any[],
      rules: any[],
      ruleSummaries?: Record<string, string>,
      ruleTransitions?: Record<string, string>,
      minScore?: number | null,
      maxScore?: number | null,
      onCriteriaChange?: (criteria: any[]) => void,
      onAddCriterion?: (name: string, definition: string) => void,
      mappedFeatures?: Record<string | number, Record<string, boolean>>,
      selectedCriterion?: string | null,
      selectedNodeIds?: Set<string | number>,
      onCriterionSelect?: (criterion: string | null) => void,
      onNodeSelect?: (nodeIds: Set<string | number>) => void,
      selectedDistributionTemplate?: DistributionTemplate | null,
      onDistributionTemplateChange?: (template: DistributionTemplate | null) => void,
      highlightedScore?: number | null,
      onRuleClick?: (itemIds: (string | number)[]) => void,
      selectedRuleIndex?: number | null,
      task?: string | null,
      loadingCriteria?: string[],
      onRulesChange?: (rules: any[]) => void,
    }
) => {
  return (
    <div className="h-full overflow-y-auto p-1">
      <Accordion type="multiple" defaultValue={["distribution", "criteria", "rules"]}>
        <AccordionItem value="distribution" className="border-b border-[#d3dfe6]">
            <AccordionTrigger className="text-sm font-medium text-[#003953] px-3 py-2">
                <span className="flex items-center gap-2"><BarChart3 className="h-4 w-4" /> Score Distribution</span>
            </AccordionTrigger>
            <AccordionContent>
                <ScoringDistribution
                  data={data}
                  minScore={minScore}
                  maxScore={maxScore}
                  selectedTemplate={selectedDistributionTemplate}
                  onTemplateChange={onDistributionTemplateChange}
                />
            </AccordionContent>
        </AccordionItem>
        <AccordionItem value="criteria" className="border-b border-[#d3dfe6]">
            <AccordionTrigger className="text-sm font-medium text-[#003953] px-3 py-2">
                <span className="flex items-center gap-2"><ListChecks className="h-4 w-4" /> Scoring Criteria</span>
            </AccordionTrigger>
            <AccordionContent>
                <ScoringCriteria
                  criteria={criteria}
                  onCriteriaChange={onCriteriaChange}
                  onAddCriterion={onAddCriterion}
                  mappedFeatures={mappedFeatures}
                  selectedCriterion={selectedCriterion}
                  selectedNodeIds={selectedNodeIds}
                  onCriterionSelect={onCriterionSelect}
                  onNodeSelect={onNodeSelect}
                  rules={rules}
                  otherCriteria={otherCriteria}
                  loadingCriteria={loadingCriteria}
                />
            </AccordionContent>
        </AccordionItem>
        <AccordionItem value="rules">
            <AccordionTrigger className="text-sm font-medium text-[#003953] px-3 py-2">
                <span className="flex items-center gap-2"><Scale className="h-4 w-4" /> Scoring Rules</span>
            </AccordionTrigger>
            <AccordionContent>
                <ScoringRules rules={rules} ruleSummaries={ruleSummaries} ruleTransitions={ruleTransitions} minScore={minScore} maxScore={maxScore} highlightedScore={highlightedScore} onRuleClick={onRuleClick} selectedRuleIndex={selectedRuleIndex} task={task} onRulesChange={onRulesChange} />
            </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
};

export default Inspector;
