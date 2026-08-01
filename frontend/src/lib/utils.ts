import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function randomSampleIndices(arrayLength: number, sampleSize: number): number[] {
  if (sampleSize >= arrayLength) {
    return Array.from({ length: arrayLength }, (_, i) => i)
  }
  
  const indices = Array.from({ length: arrayLength }, (_, i) => i)
  
  for (let i = indices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [indices[i], indices[j]] = [indices[j], indices[i]]
  }
  
  return indices.slice(0, sampleSize)
}

