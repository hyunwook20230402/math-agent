/**
 * 오답 복습 날짜 계산.
 *
 * 실제 운영은 "처음 풀기 + 다시 4회 = 총 5회" 다:
 *
 *   1회차 처음 풀기      ← 원본 배포
 *   2회차 당일 재풀이    ← **같은 원본 배포 안에서** 오답만 다시 푼다(배포를 안 만든다)
 *   3회차 다음 수업 (빨) ┐
 *   4회차 2주      (주) ├ 자동 생성되는 복습 배포 **3개**
 *   5회차 4주      (노) ┘
 *
 * 그래서 달력에 뜨는 네모는 **원본 + 3 = 4개**다.
 * 2회차가 배포가 아닌 근거: `canAttemptToday` 가 처음 2회는 같은 날을 허용하고(count<2),
 * 학생 대시보드에 `?wrongOnly=true` 로 오답만 다시 푸는 통로가 이미 있다.
 *
 * 날짜 계산을 DB(RPC)가 아니라 여기 두는 이유:
 *   "다음 수업날"은 월수금 / 화목토 격일반이라는 **학원 운영 규칙**이라 바뀔 수 있다.
 *   RPC 는 받은 날짜대로 만들기만 하므로 규칙이 바뀌어도 마이그레이션이 필요 없다.
 */
import type { ReviewKind, ReviewStageInput } from '@shared/lib/api';

// 목표 회차 상수는 api.ts 원본을 그대로 내보낸다(순환 import 회피).
// ⚠️ `export { X } from 'y'` 는 **재수출만** 하고 이 모듈의 지역 바인딩을 만들지 않는다.
//    아래에서 REVIEW_TARGET_ROUNDS 를 실제로 쓰므로 import 와 export 를 따로 적어야 한다.
import { REVIEW_TARGET_ROUNDS } from '@shared/lib/api';
export { REVIEW_TARGET_ROUNDS };

const WEEKDAY_KO = ['일', '월', '화', '수', '목', '금', '토'];

/** 'YYYY-MM-DD' → Date (로컬 자정). new Date('YYYY-MM-DD') 는 UTC 로 읽혀 하루 밀린다. */
export const parseDate = (s: string): Date => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

/** Date → 'YYYY-MM-DD'. toISOString 은 UTC 라 밤에 하루 밀린다. */
export const toDateStr = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export const addDays = (dateStr: string, days: number): string => {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + days);
  return toDateStr(d);
};

/** '9/3(수)' — 예약 미리보기에서 격일 규칙을 눈으로 확인하려고 요일을 붙인다. */
export const formatWithWeekday = (dateStr: string): string => {
  const d = parseDate(dateStr);
  return `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAY_KO[d.getDay()]})`;
};

/**
 * 다음 수업일까지의 일수.
 *
 * 월수금 / 화목토 격일반이고 일요일은 수업이 없다:
 *   월→수, 화→목, 수→금, 목→토 (+2)   |   금→월, 토→화 (+3)
 *
 * 기준일이 일요일인 경우(수업이 없어 드물다)는 +2(화)로 둔다 — 필요하면 모달에서
 * 기준일을 실제 수업일로 바꿔 쓰면 된다.
 */
export const nextClassOffset = (dateStr: string): number => {
  const dow = parseDate(dateStr).getDay(); // 0=일 … 6=토
  return dow === 5 || dow === 6 ? 3 : 2;   // 금·토만 +3
};

export interface ReviewStageDef {
  stage: number;
  kind: ReviewKind;
  label: string;
  offsetOf: (baseDate: string) => number;
  hint: string;
}

/**
 * 자동 생성되는 복습 배포 3단계.
 *
 * ⚠️ **stage 번호를 다시 매기지 말 것.** 타임라인이 `표 회차 = 예약 stage + 1` 로 매핑한다
 * (아래 buildReviewTimeline). 숙제(stage 1)를 없앤다고 2·3·4 를 1·2·3 으로 당기면
 * **5칸이 통째로 한 칸씩 밀린다** — 032 주석에 같은 실수로 4칸이 전부 어긋난 실측이 있다.
 * 없어진 stage 1 자리는 '당일 재풀이'(배포 없음)가 그대로 차지한다.
 */
export const REVIEW_STAGES: ReviewStageDef[] = [
  { stage: 2, kind: 'next_class', label: '다음 수업', offsetOf: nextClassOffset, hint: '월수금·화목토 격일' },
  { stage: 3, kind: 'week2',      label: '2주',       offsetOf: () => 14,       hint: '2주 뒤' },
  { stage: 4, kind: 'week4',      label: '4주',       offsetOf: () => 28,       hint: '4주 뒤' },
];

/** 자동 생성 대상 — 학생이 과제를 다 풀면 이 3개가 만들어진다. */
export const AUTO_REVIEW_KINDS: ReviewKind[] = ['next_class', 'week2', 'week4'];

/**
 * 배포 종류별 색. **여기 한 곳에서만** 정의한다(달력 칩·예약 현황·배포 내역·학습보고서 공용).
 *
 * 빨(다음 수업) → 주(2주) → 노(4주) 로 갈수록 멀어진다. 원본 배포는 파랑이라
 * 한 날짜에 겹쳐도 네 가지가 구분된다.
 *
 * ⚠️ **진한 배경 + 흰 글씨는 쓰지 않는다** — 주황·노랑은 흰 글씨 대비가 나빠
 * 인쇄물이나 밝은 화면에서 안 읽힌다. 연한 배경 + 진한 글씨로 통일.
 */
export interface ReviewKindStyle {
  label: string;
  chip: string;   // 칩(배경+글씨)
  dot: string;    // 겹침 요약용 색 점(배경만)
}

export const ORIGIN_STYLE: ReviewKindStyle = {
  label: '처음 푸는 문제',
  chip: 'bg-primary/10 text-primary',
  dot: 'bg-primary',
};

export const REVIEW_KIND_STYLE: Record<ReviewKind, ReviewKindStyle> = {
  next_class: { label: '다음 수업', chip: 'bg-rose-100 text-rose-700',       dot: 'bg-rose-500' },
  week2:      { label: '2주',       chip: 'bg-amber-100 text-amber-800',     dot: 'bg-amber-500' },
  // 4주는 노랑이었는데 주황과 잘 안 갈라져 초록으로 바꿨다(사용자 요청).
  week4:      { label: '4주',       chip: 'bg-emerald-100 text-emerald-800', dot: 'bg-emerald-500' },
  makeup:     { label: '보충',      chip: 'bg-slate-100 text-slate-700',     dot: 'bg-slate-400' },
  // 옛 데이터 전용 — 더 이상 만들지 않는다(2회차는 원본 배포 안에서 푼다)
  homework:   { label: '숙제',      chip: 'bg-slate-100 text-slate-700',   dot: 'bg-slate-400' },
};

/** 배포 한 건의 색. review_kind 가 없으면(=원본) 파랑. */
export const styleOfDistribution = (reviewKind?: string | null): ReviewKindStyle =>
  (reviewKind && REVIEW_KIND_STYLE[reviewKind as ReviewKind]) || ORIGIN_STYLE;

/** 기준일 + 선택한 kind 들 → RPC 에 넘길 단계 배열(회차 순). */
export const buildReviewStages = (baseDate: string, kinds: ReviewKind[]): ReviewStageInput[] =>
  REVIEW_STAGES
    .filter((s) => kinds.includes(s.kind))
    .map((s) => ({
      stage: s.stage,
      kind: s.kind,
      label: s.label,
      date: addDays(baseDate, s.offsetOf(baseDate)),
    }));

// ── 회차 타임라인 ────────────────────────────────────────────────────
// 오답 표의 5칸(첫 오답 / 2회차 / 3회차 / 4회차 / 5회차)을 채운다.
// 각 칸 우선순위: 실제로 푼 날 > 예약된 배포 날짜 > 계산된 예상일.

export type CellState = 'done' | 'scheduled' | 'predicted' | 'overdue';

export interface TimelineCell {
  stage: number;              // 1~5
  label: string;              // 첫 오답 / 숙제 / 다음 수업 / 2주 / 4주
  date: string | null;        // 'YYYY-MM-DD'
  state: CellState;
  isCorrect?: boolean;        // state='done' 일 때만
}

/** 회차별 라벨. 1·2회차는 배포가 아니라 원본 컨텐츠 안에서 푸는 회차다. */
export const STAGE_LABELS = ['첫 풀이', '당일 재풀이', '다음 수업', '2주', '4주'];

/**
 * 첫 풀이일 기준 회차 오프셋(일). 3회차만 요일 규칙(월수금·화목토)을 탄다.
 * [1회차, 2회차, 3회차, 4회차, 5회차]
 *
 * 2회차가 **+0(같은 날)** 인 이유: 학원에 와서 1회 푼 뒤 그날 바로 오답을 다시 풀고 퇴원한다.
 * (예전엔 '숙제'라 +1 이었지만, 별도 배포를 없애면서 당일로 옮겼다.)
 */
const baseOffsets = (firstWrongDate: string): number[] => [
  0,
  0,
  nextClassOffset(firstWrongDate),
  14,
  28,
];

export interface ScheduledEntry {
  stage: number | null;
  kind: string | null;
  date: string;   // ISO
}

/**
 * 회차 타임라인을 만든다.
 *
 * 밀렸을 때(rolling): **직전에 실제로 푼 날**을 새 기준으로 삼아 남은 회차를 다시 깐다.
 *   - 3회차는 그 기준일의 "다음 수업일"로 다시 잡는다(요일 규칙을 다시 적용해야 의미가 산다).
 *   - 나머지는 원래 간격(baseOffsets 차이)을 그대로 평행이동해 **간격이 유지**된다.
 * 고정식으로 두면 2·3회차가 같은 날에 겹치는 문제가 생긴다.
 *
 * @param attemptDates   실제 시도 날짜(ISO, 시간순)
 * @param attemptResults 각 시도의 정답 여부(같은 순서)
 * @param scheduled      아직 시작 안 된 복습 예약(선생님이 옮겼을 수 있으므로 예상일보다 우선)
 * @param today          'YYYY-MM-DD' (테스트 주입용, 기본 오늘)
 */
export const buildReviewTimeline = (
  attemptDates: string[],
  attemptResults: boolean[],
  scheduled: ScheduledEntry[] = [],
  today: string = toDateStr(new Date()),
): TimelineCell[] => {
  const done = attemptDates.map(toDateStr0);
  const first = done[0] ?? today;
  const offs = baseOffsets(first);

  // 예약을 회차별로 (회차가 비어 있으면 날짜순으로 남은 칸에 채운다)
  //
  // ⚠️ **번호 체계가 둘이다. 여기서 변환해야 한다.**
  //   예약(`distributions.review_stage`, 032 주석)  = 1 숙제 / 2 다음수업 / 3 2주 / 4 4주
  //   이 표의 회차(STAGE_LABELS)                    = 1 첫오답 / 2 숙제 / 3 다음수업 / 4 2주 / 5 4주
  //   첫 오답이 한 칸을 먹으므로 **표의 회차 = 예약 stage + 1**.
  //   변환 없이 stage 를 그대로 키로 쓰면 한 칸씩 밀린다 — 실측(월 첫오답 + 4단계 예약):
  //   숙제 예약(9/1)은 1회차 칸을 노려 이미 푼 날에 막혀 **통째로 버려지고**,
  //   2회차 '숙제' 칸에는 다음수업 예약(9/2)이 들어갔다. 4칸 전부 어긋났다.
  const byStage = new Map<number, string>();
  const loose: string[] = [];
  for (const s of scheduled) {
    const d = toDateStr0(s.date);
    // 예약 stage 는 1 ~ (목표회차-1). 범위 밖이면 회차를 못 믿으니 날짜순으로 흘려보낸다.
    if (s.stage && s.stage >= 1 && s.stage < REVIEW_TARGET_ROUNDS) byStage.set(s.stage + 1, d);
    else loose.push(d);
  }

  // ⚠️ **예약이 이미 푼 칸을 노리면 stage 매핑이 어긋난 것이다 — 통째로 날짜순으로 바꾼다.**
  //   학생이 첫 오답 **당일** 오답 숙제를 풀면(planWrongHomework 의 당일 예외) 칸2가 done 이 되고,
  //   아래 루프는 그 칸에서 continue 하므로 `byStage.get(2)` 를 아예 조회하지 않는다. 그대로 두면
  //   선생님이 잡아 둔 숙제 예약(stage=1)이 **표에서 소리 없이 사라진다**(실측 확인).
  //   이때 stage 를 붙들면 나머지도 한 칸씩 밀린 라벨로 들어가므로, 아예 버리고 **날짜순**으로
  //   남은 칸을 채운다 — 학생은 어차피 날짜순으로 풀기 때문에 그게 실제 순서다.
  //   (총 5칸이라 '이미 푼 회차 + 예약'이 5를 넘으면 늦은 예약은 넘친다. 5회를 채우면 거기서
  //    끝나므로 그건 정상이다 — 대신 **임박한 예약이 먼저** 보여야 한다.)
  if ([...byStage.keys()].some((stage) => stage <= done.length)) {
    for (const d of byStage.values()) loose.push(d);
    byStage.clear();
  }
  loose.sort();

  const cells: TimelineCell[] = [];
  let anchor = first;          // 마지막으로 "확정된" 날짜
  let anchorStage = 1;

  for (let stage = 1; stage <= REVIEW_TARGET_ROUNDS; stage++) {
    const idx = stage - 1;

    // ① 실제로 푼 회차
    if (idx < done.length) {
      cells.push({
        stage,
        label: STAGE_LABELS[idx],
        date: done[idx],
        state: 'done',
        isCorrect: attemptResults[idx],
      });
      anchor = done[idx];
      anchorStage = stage;
      continue;
    }

    // ② 예약된 배포가 있으면 그 날짜 (선생님이 달력에서 옮겼을 수 있다)
    const reserved = byStage.get(stage) ?? loose.shift();
    const date = reserved ?? predictFrom(anchor, anchorStage, stage, offs);

    cells.push({
      stage,
      label: STAGE_LABELS[idx],
      date,
      // 예정일이 지났는데 아직 안 풀었으면 밀린 것
      state: date < today ? 'overdue' : reserved ? 'scheduled' : 'predicted',
    });

    // ★기준점은 "확정된 날짜"(실제로 푼 날 또는 선생님이 잡은 예약)에서만 옮긴다.
    //   예상일로 기준을 옮기면 예상 위에 예상을 쌓게 돼 원래 계획이 밀린다 —
    //   월 첫오답의 "다음 수업"이 수요일이 아니라 목요일로 나오던 버그(단위테스트로 확인).
    if (reserved) {
      anchor = date;
      anchorStage = stage;
    }
  }

  return cells;
};

/** anchorStage 의 날짜 anchor 로부터 target 회차 예상일. */
const predictFrom = (anchor: string, anchorStage: number, target: number, offs: number[]): string => {
  // 2회차는 **당일 재풀이** — 같은 날이 정답이다. 아래 '최소 하루' 규칙의 예외.
  // (루프가 회차 순으로 돌아 target=2 일 때 anchorStage 는 항상 1 이다.)
  if (target === 2) return anchor;
  // 3회차는 "다음 수업"이라 요일 규칙을 기준일에 다시 적용해야 한다
  if (target === 3) return addDays(anchor, nextClassOffset(anchor));
  const gap = offs[target - 1] - offs[anchorStage - 1];
  return addDays(anchor, Math.max(gap, 1));   // 최소 하루는 벌어지게
};

/** ISO 또는 'YYYY-MM-DD' → 'YYYY-MM-DD' (로컬 기준) */
function toDateStr0(iso: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return iso;
  return toDateStr(new Date(iso));
}

/** 아직 안 푼 첫 회차 = "다음 회차". 날짜 필터가 이걸 기준으로 뽑는다. */
export const nextPendingCell = (cells: TimelineCell[]): TimelineCell | null =>
  cells.find((c) => c.state !== 'done') ?? null;

// ── 학생 화면: 오답 숙제 ──────────────────────────────────────────────
// 학생이 누르는 "오답 숙제하기 (N회차)" 의 N 과 대상 문제.
// **회차 규칙을 학생 화면에 따로 두지 않는 이유**: 여기(buildReviewTimeline)와 셈이 어긋나면
// 학생은 "2회차" 를 푸는데 선생님 표는 3회차 칸이 차는 식으로 갈라진다. 한 파일에 둔다.

/** 문제별 시도 요약. 회차 수와 "마지막으로 푼 날" 만 있으면 된다. */
export interface ProblemAttemptStat {
  /** 전체 시도 횟수(배포 무관) = 선생님 표의 total_attempts */
  count: number;
  /** 마지막 제출 시각(ISO). 없으면 null */
  lastAt: string | null;
}

export type WrongHomeworkState =
  | 'due'        // 지금 풀 회차가 있다 → 버튼을 보여준다
  | 'resting'    // 오늘 몫을 이미 끝냈다 → "수고하셨습니다"
  | 'completed'  // 오답을 전부 5회까지 채웠다
  | 'none';      // 틀린 문제가 없다

export interface WrongHomeworkPlan {
  /** 지금 풀 문제. 5회를 채웠거나 오늘 이미 푼 문제는 빠진다. */
  problemIds: string[];
  /** 한 번이라도 틀린 문제 수 (5회를 채운 것 포함) */
  wrongTotal: number;
  /** 이번에 채울 회차 (2 ~ REVIEW_TARGET_ROUNDS) */
  round: number;
  state: WrongHomeworkState;
}

/**
 * 오답 숙제 대상과 회차를 정한다.
 *
 * @param everWrongProblemIds 그 배포에서 **한 번이라도 틀린** 문제 (풀 순서대로)
 * @param statsByProblem      문제별 전체 시도 요약(배포 무관)
 * @param today               'YYYY-MM-DD' (테스트 주입용, 기본 오늘)
 *
 * ⚠️ "지금도 틀린 문제" 가 아니라 "한 번이라도 틀린 문제" 를 받아야 한다.
 *    한 번 틀린 문제는 **정답 여부와 무관하게** 5회를 채우는 게 이 시스템의 규칙이라
 *    (REVIEW_TARGET_ROUNDS 주석), 3회차에 맞혔다고 빼면 4·5회차 칸이 영영 안 채워진다.
 *
 * ★**하루에 복습 한 회차만.** 오늘 이미 **복습 회차를 푼**(count>=2) 문제는 빼고 `resting`
 *   으로 돌린다. 안 그러면 제출하자마자 버튼이 "(3회차)" 로 바뀌어 한자리에서 2·3·4·5회차를
 *   다 태울 수 있고, 선생님 오답 표의 네 칸이 **전부 같은 날짜**로 채워져 "며칠에 걸쳐 다시
 *   푼다" 는 설계가 통째로 무너진다.
 *
 * ⚠️ **처음 풀기(count===1)는 이 제한에서 빼야 한다.** 월요일에 처음 풀어 틀린 것을 **그날
 *    바로** 숙제로 내는 게 이 기능의 출발점이다. "오늘 푼 문제는 전부 제외" 로 두면 채점 직후
 *    버튼이 안 뜨고 다음 날까지 기다려야 한다(테스트로 잡은 실제 회귀).
 *    같은 이유로 예정일(다음 수업·2주·4주)로도 막지 않는다.
 *
 * 회차는 **가장 덜 푼 문제 기준**이다. 문제마다 진도가 다를 수 있는데(보충 배포 등) 그중
 * 제일 뒤처진 것이 지금 채워야 할 회차다. 앞선 문제까지 같이 풀리므로 손해가 없다.
 */
export const planWrongHomework = (
  everWrongProblemIds: string[],
  statsByProblem: Record<string, ProblemAttemptStat>,
  today: string = toDateStr(new Date()),
): WrongHomeworkPlan => {
  const countOf = (id: string) => statsByProblem[id]?.count ?? 0;
  const nextRound = (ids: string[]) =>
    // +1 = "이번에 풀면 몇 회차가 되는가". 1회차(처음 풀기)는 끝난 상태이므로 최소 2.
    Math.max(2, Math.min(...ids.map(countOf)) + 1);

  const wrongTotal = everWrongProblemIds.length;
  if (wrongTotal === 0) return { problemIds: [], wrongTotal: 0, round: 2, state: 'none' };

  const remaining = everWrongProblemIds.filter((id) => countOf(id) < REVIEW_TARGET_ROUNDS);
  if (remaining.length === 0) {
    return { problemIds: [], wrongTotal, round: REVIEW_TARGET_ROUNDS, state: 'completed' };
  }

  const due = remaining.filter((id) => canAttemptToday(statsByProblem[id], today));
  if (due.length === 0) {
    return { problemIds: [], wrongTotal, round: nextRound(remaining), state: 'resting' };
  }

  return { problemIds: due, wrongTotal, round: nextRound(due), state: 'due' };
};

/**
 * 오늘 이 문제를 (또) 풀어 제출해도 되는가.
 *
 * ★**문제 푸는 화면(SolveProblem)도 반드시 이걸 봐야 한다.** 대시보드에서 버튼을 감추는 것만으로는
 *   못 막는다 — 제출 뒤 **브라우저 뒤로가기** 한 번이면 `/student/problems/…?wrongOnly=…` 가 그대로
 *   다시 열리고, 화면이 새로 마운트돼 답을 또 넣을 수 있다. 그러면 같은 날 회차가 계속 올라가
 *   선생님 오답 표의 2·3·4·5회차 칸이 **전부 같은 날짜**로 채워진다(검토에서 3개 관점이 각각 확인).
 *
 * 규칙(= planWrongHomework 의 대상 판정과 동일, 한 곳에만 둔다):
 *   - 5회를 채웠으면 끝.
 *   - 시도 2회 미만이면 허용 — 처음 풀기(1회차)와 **그날 바로 내는 오답 숙제(2회차)** 는 같은 날 가능.
 *   - 그 외에는 오늘 이미 제출했으면 불가(하루에 복습 한 회차).
 */
export const canAttemptToday = (
  stat: ProblemAttemptStat | undefined,
  today: string = toDateStr(new Date()),
): boolean => {
  const count = stat?.count ?? 0;
  if (count >= REVIEW_TARGET_ROUNDS) return false;
  if (count < 2) return true;
  return !stat?.lastAt || toDateStr0(stat.lastAt) !== today;
};
