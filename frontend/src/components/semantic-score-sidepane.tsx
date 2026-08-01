"use client"

import { useState, useEffect } from "react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import {
    Field,
    FieldDescription,
    FieldGroup,
    FieldLabel,
    FieldLegend,
    FieldSet,
  } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea" 
import { LoaderCircle } from "lucide-react"

interface SemanticScoreProps {
    task?: string;
    minScore?: number;
    maxScore?: number;
    availableFields?: string[];
    selectedFields?: string[];
    sampleSize?: number | "";
    onSampleSizeChange?: (size: number | "") => void;
    onScore?: (data: { task: string; min: number | ""; max: number | ""; sampleSize: number | ""; selectedFields: string[] }) => void;
    isScoring?: boolean;
    isApplying?: boolean;
    progress?: number;
    progressStatus?: string;
}

const SemanticScore = ({ 
    task: propTask, 
    minScore, 
    maxScore, 
    availableFields, 
    selectedFields, 
    sampleSize: propSampleSize = 40,
    onSampleSizeChange,
    onScore, 
    isScoring, 
    isApplying, 
    progress, 
    progressStatus 
}: SemanticScoreProps) => {
    const [task, setTask] = useState<string>("");
    const [min, setMin] = useState<number | "">("");
    const [max, setMax] = useState<number | "">("");
    const [selectedFieldsState, setSelectedFieldsState] = useState<string[]>(selectedFields || []);
    const [fieldInput, setFieldInput] = useState<string>("");
    const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
    
    const sampleSize = propSampleSize;
    const setSampleSize = (value: number | "") => {
        onSampleSizeChange?.(value);
    };

    useEffect(() => {
        if (propTask !== undefined) {
            setTask(propTask);
        } else {
            setTask("");
        }
        if (minScore !== undefined) {
            setMin(minScore);
        } else {
            setMin("");
        }
        if (maxScore !== undefined) {
            setMax(maxScore);
        } else {
            setMax("");
        }
        if (availableFields && availableFields.length > 0) {
            setSelectedFieldsState(selectedFields || []);
        }
    }, [propTask, minScore, maxScore, availableFields, selectedFields]);

    const isFormValid = task.trim() !== "" && min !== "" && max !== "" && sampleSize !== "";

    const handleScore = () => {
        const formData = {
            task,
            min,
            max,
            sampleSize,
            selectedFields: selectedFieldsState,
        };
        
        if (onScore) {
            onScore(formData);
        }
    };

    const handleClearAll = () => {
        setTask("");
        setMin("");
        setMax("");
        setSampleSize("");
        setSelectedFieldsState([]);
        setFieldInput("");
    };

    const addField = (field: string) => {
        if (field && !selectedFieldsState.includes(field)) {
            setSelectedFieldsState([...selectedFieldsState, field]);
        }
        setFieldInput("");
        setShowSuggestions(false);
    };

    const removeField = (field: string) => {
        setSelectedFieldsState(selectedFieldsState.filter(f => f !== field));
    };

    const filteredFields = availableFields?.filter(
        field => 
            field.toLowerCase().includes(fieldInput.toLowerCase()) &&
            !selectedFieldsState.includes(field)
    ) || [];

    return (
        <div className="w-full h-full overflow-y-auto">
            <div className="max-w-2xl mx-auto p-6">
                <FieldGroup>
                    <FieldSet>
                    <FieldLegend>Scoring Task</FieldLegend>
                    <FieldDescription className="text-xs text-muted-foreground">
                        Define your scoring task
                    </FieldDescription>
                    <FieldGroup>
                        <Field>
                        <FieldLabel htmlFor="task">
                            Task <span className="text-red-500">*</span>
                        </FieldLabel>
                        <Textarea
                            id="task"
                            placeholder="Describe your scoring task..."
                            className="resize-none min-h-[100px]"
                            value={task}
                            onChange={(e) => setTask(e.target.value)}
                        />
                        </Field>

                        
                        <Field>
                            <FieldLabel>Field(s) to Score</FieldLabel>
                            
                            {selectedFieldsState.length > 0 && (
                                <div className="flex flex-wrap gap-2 mb-2">
                                    {selectedFieldsState.map((field) => (
                                        <div
                                            key={field}
                                            className="inline-flex items-center gap-1 px-2 py-1 bg-[#f0f8ff] text-[#003953] rounded-md text-sm"
                                        >
                                            <span>{field}</span>
                                            <button
                                                type="button"
                                                onClick={() => removeField(field)}
                                                className="rounded-full p-0.5 cursor-pointer"
                                            >
                                                <svg
                                                    className="w-3 h-3"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    viewBox="0 0 24 24"
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        strokeWidth={2}
                                                        d="M6 18L18 6M6 6l12 12"
                                                    />
                                                </svg>
                                            </button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="relative">
                                <Input
                                    type="text"
                                    placeholder="Type to search fields..."
                                    value={fieldInput}
                                    onChange={(e) => {
                                        setFieldInput(e.target.value);
                                        setShowSuggestions(true);
                                    }}
                                    onFocus={() => setShowSuggestions(true)}
                                    onBlur={() => {
                                        setTimeout(() => setShowSuggestions(false), 200);
                                    }}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter' && filteredFields.length > 0) {
                                            e.preventDefault();
                                            addField(filteredFields[0]);
                                        }
                                    }}
                                />
                                
                                {showSuggestions && fieldInput && filteredFields.length > 0 && (
                                    <div className="absolute z-10 w-full mt-1 bg-white border border-[#0c5c84] rounded-md shadow-lg max-h-48 overflow-y-auto">
                                        {filteredFields.map((field) => (
                                            <button
                                                key={field}
                                                type="button"
                                                onClick={() => addField(field)}
                                                className="w-full text-left px-3 py-2 hover:bg-[#d3dfe6] text-sm"
                                            >
                                                {field}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </Field>

                        <div className="grid grid-cols-3 gap-4">
                        <Field>
                            <FieldLabel htmlFor="min">
                            Min Score <span className="text-red-500">*</span>
                            </FieldLabel>
                            <Input
                            id="min"
                            type="number"
                            value={min}
                            onChange={(e) => setMin(e.target.value === "" ? "" : Number(e.target.value))}
                            />
                        </Field>

                        <Field>
                            <FieldLabel htmlFor="max">
                            Max Score<span className="text-red-500">*</span>
                            </FieldLabel>
                            <Input
                            id="max"
                            type="number"
                            value={max}
                            onChange={(e) => setMax(e.target.value === "" ? "" : Number(e.target.value))}
                            />
                        </Field>

                        <Field>
                            <FieldLabel htmlFor="sample">
                            Sample<span className="text-red-500">*</span>
                            </FieldLabel>
                            <Input
                            id="sample"
                            type="number"
                            value={sampleSize}
                            onChange={(e) => setSampleSize(e.target.value === "" ? "" : Number(e.target.value))}
                            onBlur={(e) => {
                                const value = e.target.value === "" ? "" : Number(e.target.value);
                                if (typeof value === "number" && value > 50) {
                                    setSampleSize(50);
                                    toast.error("Sample size cannot exceed 50", {});
                                }
                            }}
                            />

                        </Field>
                        </div>

                        
                    </FieldGroup>
                    </FieldSet>
                    
                    <Field orientation="horizontal" className="mt-1">
                    <Button onClick={handleScore} disabled={!isFormValid || isScoring} className="bg-[#4baeae] text-white hover:bg-[#3d9999] cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed">
                        {isScoring ? <><LoaderCircle className="animate-spin" /> Running</> : "Run"}
                    </Button>
                    <Button variant="outline" onClick={handleClearAll} className="cursor-pointer border-[#0c5c84] text-[#003953] hover:bg-[#d3dfe6]">
                        Clear All
                    </Button>
                    </Field>
                </FieldGroup>

                {isScoring && progress !== undefined && (
                    <div className="mt-4 space-y-2">
                        <div className="flex justify-between text-sm text-[#003953]">
                            <span>{progressStatus || "Processing..."}</span>
                            <span>{progress}%</span>
                        </div>
                        <div className="w-full bg-gray-200 rounded-full h-2.5">
                            <div 
                                className="h-2.5 rounded-full transition-all duration-300 bg-gradient-to-r from-[#4baeae] to-[#fccddd]"
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                    </div>
                )}

            </div>
        </div>
    )

}

export default SemanticScore;