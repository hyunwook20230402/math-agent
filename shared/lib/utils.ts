import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export type DifficultyLabel = 'very_easy' | 'easy' | 'medium' | 'hard' | 'very_hard';

export function scoreToDifficultyLabel(score: number): DifficultyLabel {
  if (score <= 2) return 'very_easy';
  if (score <= 4) return 'easy';
  if (score <= 6) return 'medium';
  if (score <= 8) return 'hard';
  return 'very_hard';
}

const _LABEL_KO: Record<DifficultyLabel, string> = {
  very_easy: '아주 쉬움',
  easy: '쉬움',
  medium: '보통',
  hard: '어려움',
  very_hard: '최상위',
};

export function formatDifficultyScore(score: number): string {
  const label = scoreToDifficultyLabel(score);
  return `${_LABEL_KO[label]} · ${score}/10`;
}

export function getDifficultyColor(score: number): string {
  if (score <= 2) return 'text-green-600 bg-green-50';
  if (score <= 4) return 'text-blue-600 bg-blue-50';
  if (score <= 6) return 'text-yellow-600 bg-yellow-50';
  if (score <= 8) return 'text-orange-600 bg-orange-50';
  return 'text-red-600 bg-red-50';
}
