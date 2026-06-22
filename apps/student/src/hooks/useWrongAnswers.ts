import { useEffect, useState } from 'react';
import { studentAnswerApi, distributionApi } from '@shared/lib/api';

// 한 배포 안에서 "첫 시도에 틀린" 문제 한 건을 표현.
// 최종 상태(isStillWrong)와 실제 시도 횟수(attemptCount)를 같이 담아
// 화면에서 전체 / 아직 틀림 / 정정됨 으로 분기할 수 있게 한다.
export interface WrongAnswerItem {
  id: string;            // problem_id
  title: string;         // "3번" 같은 표시용 라벨
  firstAnswer: string;   // 첫 시도 답안
  lastAnswer: string;    // 마지막 시도 답안
  correctAnswer: string; // 정답 (없으면 "정답 정보 없음")
  attemptCount: number;  // 실제 시도 횟수 (하드코딩 아님)
  isStillWrong: boolean; // 마지막 시도도 틀렸나 (= 아직 못 푼 오답)
  firstAttemptAt: string;
  lastAttemptAt: string;
}

export interface WrongAnswerDistributionInfo {
  id: string;
  title: string;
  problemSetName: string;
}

interface UseWrongAnswersResult {
  items: WrongAnswerItem[];
  distributionInfo: WrongAnswerDistributionInfo | null;
  loading: boolean;
  error: string | null;
}

/**
 * 한 배포의 "첫 시도 오답" 목록을 불러온다.
 * - 문제별 모든 시도를 시간순 정렬 → 첫 시도가 틀린 문제만 포함
 * - 각 항목에 실제 시도 횟수와 최종 정답 여부(isStillWrong)를 함께 계산
 *
 * 기존 WrongAnswerNote / StillWrongAnswerNote 의 중복 로직을 한 곳으로 모은 것.
 * StillWrong 의 "attemptCount=2 고정", "첫 2회만 보고 3회+ 무시" 버그를 해소한다.
 */
export function useWrongAnswers(
  distributionId: string | undefined,
  studentId: string | undefined,
): UseWrongAnswersResult {
  const [items, setItems] = useState<WrongAnswerItem[]>([]);
  const [distributionInfo, setDistributionInfo] = useState<WrongAnswerDistributionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!distributionId || !studentId) return;

    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const distribution = await distributionApi.getDistributionById(distributionId);
        const answers = await studentAnswerApi.getStudentAnswers(studentId, distributionId);

        // 문제별로 시도 묶기
        const byProblem = new Map<string, any[]>();
        answers.forEach((a: any) => {
          if (!byProblem.has(a.problem_id)) byProblem.set(a.problem_id, []);
          byProblem.get(a.problem_id)!.push(a);
        });

        const problems = distribution.problem_set?.problems || [];
        const result: WrongAnswerItem[] = [];

        problems.forEach((problem: any, index: number) => {
          const tries = byProblem.get(problem.id);
          if (!tries || tries.length === 0) return; // 미시도 제외

          const sorted = [...tries].sort(
            (a, b) => new Date(a.submitted_at).getTime() - new Date(b.submitted_at).getTime(),
          );
          const first = sorted[0];
          const last = sorted[sorted.length - 1];

          // 첫 시도가 틀린 문제만 오답 목록에 포함
          if (first.is_correct) return;

          result.push({
            id: problem.id,
            title: `${index + 1}번`,
            firstAnswer: first.answer,
            lastAnswer: last.answer,
            correctAnswer: problem.correct_answer || '정답 정보 없음',
            attemptCount: sorted.length,
            isStillWrong: !last.is_correct,
            firstAttemptAt: first.submitted_at,
            lastAttemptAt: last.submitted_at,
          });
        });

        if (!cancelled) {
          setItems(result);
          setDistributionInfo({
            id: distribution.id,
            title: distribution.title,
            problemSetName: distribution.problem_set?.name || '',
          });
        }
      } catch (e: any) {
        console.error('오답 목록 조회 실패:', e);
        if (!cancelled) setError('오답 목록을 불러오지 못했습니다.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [distributionId, studentId]);

  return { items, distributionInfo, loading, error };
}
