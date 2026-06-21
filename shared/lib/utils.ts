import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// 난이도 라벨 — 4단계(Lv1~Lv4) 체계(2026-06-21). 'medium' 은 옛 1~10 데이터 호환용으로
// 타입에만 남기되 새 매핑에선 쓰지 않는다(점수 3 은 hard 로 직행).
export type DifficultyLabel = 'very_easy' | 'easy' | 'medium' | 'hard' | 'very_hard';

// 점수 → Lv(1~4). 옛 1~10 데이터(5 이상)는 모두 Lv4 로 흡수해 표시가 깨지지 않게 한다.
export function scoreToLevel(score: number): 1 | 2 | 3 | 4 {
  if (score <= 1) return 1;
  if (score === 2) return 2;
  if (score === 3) return 3;
  return 4; // 4 이상(옛 5~10 포함) → Lv4
}

// DB 의 difficulty 파생 라벨과 일치(1=very_easy, 2=easy, 3=hard, 4↑=very_hard).
export function scoreToDifficultyLabel(score: number): DifficultyLabel {
  const lv = scoreToLevel(score);
  return (['very_easy', 'easy', 'hard', 'very_hard'] as const)[lv - 1];
}

// Lv1 쉬움 / Lv2 보통 / Lv3 어려움 / Lv4 최고난도
const _LABEL_KO: Record<DifficultyLabel, string> = {
  very_easy: '쉬움',
  easy: '보통',
  medium: '보통',     // 옛 데이터 호환(현 매핑에선 미사용)
  hard: '어려움',
  very_hard: '최고난도',
};

// DB 의 difficulty 라벨(문자열) → 한글 표기. 알 수 없는 값이면 그대로 반환.
export function difficultyLabelKo(label: string | null | undefined): string {
  if (!label) return '-';
  return _LABEL_KO[label as DifficultyLabel] ?? label;
}

// 화면 표기: "Lv2 (보통)" 형태. 옛 "x/10" 표기는 폐기.
export function formatDifficultyScore(score: number): string {
  const lv = scoreToLevel(score);
  const label = scoreToDifficultyLabel(score);
  return `Lv${lv} (${_LABEL_KO[label]})`;
}

// 뱃지용 색상(bg-*-100 / text-*-800 톤). Lv1 초록 → Lv4 빨강.
export function getDifficultyColor(score: number): string {
  switch (scoreToLevel(score)) {
    case 1: return 'bg-green-100 text-green-800';
    case 2: return 'bg-blue-100 text-blue-800';
    case 3: return 'bg-orange-100 text-orange-800';
    case 4: return 'bg-red-100 text-red-800';
  }
}
