// 정답 판정 정규화 유틸
//
// 배경: problems.correct_answer 는 객관식이 "1"~"5" 숫자로 저장되는데,
// 학생 풀이 화면(SolveProblem)의 라디오는 choices 가 없으면 "1번"~"5번" 라벨을
// value 로 쓴다. 단순 문자열 비교(`answer === correct_answer`)로는
// "3번" !== "3" 이라 정답을 골라도 항상 오답으로 기록되는 버그가 있었다.
// → 비교 직전에 양쪽을 정규화해 형식 차이를 흡수한다.

export type AnswerType = 'multiple_choice' | 'short_answer';

// 원문자(①②③…) → 숫자 매핑
const CIRCLED_TO_NUMBER: Record<string, string> = {
  '①': '1', '②': '2', '③': '3', '④': '4', '⑤': '5',
  '⑥': '6', '⑦': '7', '⑧': '8', '⑨': '9', '⑩': '10',
};

/**
 * 답안을 비교 가능한 표준형으로 정규화한다.
 * - 객관식: "③" / "3번" / " 3 " / "3" → "3" (보기 번호만 추출)
 * - 주관식: 앞뒤 공백 제거 + 연속 공백 1칸으로
 * 정규화 불가(빈 값 등)면 null.
 */
export function normalizeAnswer(
  answer: string | null | undefined,
  answerType: AnswerType,
): string | null {
  if (answer == null) return null;

  let s = String(answer).trim();
  if (!s) return null;

  if (answerType === 'multiple_choice') {
    // 원문자 → 숫자
    for (const [circled, num] of Object.entries(CIRCLED_TO_NUMBER)) {
      s = s.split(circled).join(num);
    }
    // "3번", "3 번" 의 '번' 제거
    s = s.replace(/(\d+)\s*번/g, '$1');
    // 남은 숫자만 추출
    const match = s.match(/\d+/);
    return match ? match[0] : null;
  }

  // 주관식: 공백 정규화 (대소문자·특수문자는 함부로 건드리지 않음)
  return s.replace(/\s+/g, ' ');
}

export interface AnswerCheckResult {
  /** 정답 여부. 정답 정보가 없으면 false(오답으로 박제하지 않도록 hasCorrectAnswer 로 구분). */
  isCorrect: boolean;
  /** correct_answer 가 비어 있어 판정 자체가 불가능한 경우 false */
  hasCorrectAnswer: boolean;
}

/**
 * 학생 답안과 정답을 정규화해 비교한다.
 * correct_answer 가 빈 값이면 판정 불가 → { isCorrect: false, hasCorrectAnswer: false }.
 * 호출부는 hasCorrectAnswer=false 인 경우를 "정답 정보 없음"으로 다뤄,
 * 정답을 골랐는데 오답으로 저장되는 일이 없게 처리할 수 있다.
 */
export function checkAnswer(
  studentAnswer: string | null | undefined,
  correctAnswer: string | null | undefined,
  answerType: AnswerType,
): AnswerCheckResult {
  const normalizedCorrect = normalizeAnswer(correctAnswer, answerType);
  if (normalizedCorrect == null) {
    return { isCorrect: false, hasCorrectAnswer: false };
  }

  const normalizedStudent = normalizeAnswer(studentAnswer, answerType);
  return {
    isCorrect: normalizedStudent != null && normalizedStudent === normalizedCorrect,
    hasCorrectAnswer: true,
  };
}
