import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { supabase } from '@shared/supabase/client';
import { Button } from '@shared/ui/button';
import { toast } from '@shared/hooks/use-toast';
import { Printer, X, Minus, Plus } from 'lucide-react';

interface PrintProblem {
  id: string;
  title: string;
  problem_number: number;
  source_label: string | null;
  unit: string | null;
  image_url: string | null;
  correct_answer: string | null;
  answer_type: string | null;
}

interface StudentInfo {
  name: string;
  grade: string | null;
  school: string | null;
}

/**
 * 문제 간격 프리셋 — 기준은 **A4 한 장**.
 * 한 쪽의 행 수만 바꾸면 쪽당 문항 수가 정해진다(2열 고정).
 */
type PresetKey = 'tight' | 'normal' | 'loose';

interface Preset {
  key: PresetKey;
  label: string;
  sub: string;
  rows: number;
  perPage: number;
  rowGap: number;    // mm — 행 사이
  workMin: number;   // mm — 문제 아래 최소 풀이 공간
}

const PRESETS: Preset[] = [
  { key: 'tight',  label: '좁게',   sub: '한 쪽 6문제',            rows: 3, perPage: 6, rowGap: 6,  workMin: 16 },
  { key: 'normal', label: '적당히', sub: '한 쪽 4문제',            rows: 2, perPage: 4, rowGap: 8,  workMin: 22 },
  { key: 'loose',  label: '넓게',   sub: '한 쪽 2문제 · 모의고사형', rows: 1, perPage: 2, rowGap: 11, workMin: 28 },
];

const DEFAULT_PRESET: PresetKey = 'normal';
const DEFAULT_MARGIN = 12;
const PREFS_KEY = 'print_sheet_prefs';

// 인쇄 창은 매번 새로 열리므로 선택을 기억해 둔다
const loadPrefs = (): { preset?: PresetKey; margin?: number } => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
  } catch {
    return {};
  }
};

// CMS 가 "이미지 없음" 으로 쓰는 플레이스홀더는 인쇄에서 걸러낸다
const isPlaceholder = (url: string | null) => !url || url.includes('via.placeholder.com');

/** 단원 배지 문구. '미분류'처럼 정보가 없는 값은 배지를 안 단다. */
const unitBadge = (unit: string | null): string | null => {
  if (!unit) return null;
  const last = unit.split('>').pop()?.trim();
  if (!last || last === '미분류' || last === '미정' || last === '기타') return null;
  return last;
};

/** -/+ 스테퍼. 지면 여백을 눈으로 맞추며 조절한다. */
const Stepper = ({
  label, value, unit, step, min, max, onChange,
}: {
  label: string; value: number; unit: string; step: number; min: number; max: number;
  onChange: (v: number) => void;
}) => (
  <div className="flex items-center gap-1.5">
    <span className="text-sm text-muted-foreground">{label}</span>
    <div className="flex items-center border rounded-md overflow-hidden">
      <button
        className="px-2 h-8 hover:bg-muted disabled:opacity-40"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - step))}
        aria-label={`${label} 줄이기`}
      >
        <Minus className="h-3.5 w-3.5" />
      </button>
      <span className="px-2 text-sm tabular-nums min-w-[3.5rem] text-center">{value}{unit}</span>
      <button
        className="px-2 h-8 hover:bg-muted disabled:opacity-40"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + step))}
        aria-label={`${label} 늘리기`}
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
);

/** 프리셋 미리보기 — 지면 한 장에 문제가 몇 칸 들어가는지 그림으로 보여준다. */
const PresetThumb = ({ rows }: { rows: number }) => {
  const top = 13;                     // 머리글 아래부터
  const cellH = (62 - top) / rows;
  const cells = Array.from({ length: rows * 2 }, (_, i) => (
    <rect
      key={i}
      x={i % 2 === 0 ? 4 : 25}
      y={top + Math.floor(i / 2) * cellH + 1.2}
      width={19}
      height={Math.max(cellH - 2.4, 2)}
      rx={1.2}
    />
  ));
  return (
    <svg viewBox="0 0 48 66" width={38} height={52} aria-hidden="true">
      <rect x={0.5} y={0.5} width={47} height={65} rx={2} fill="#fff" stroke="#d4d4d8" />
      <rect x={4} y={4} width={13} height={4} rx={1} fill="#93c5fd" />
      <line x1={24} y1={11.5} x2={24} y2={62} stroke="#e4e4e7" strokeWidth={0.7} />
      <g fill="#c7d2fe">{cells}</g>
    </svg>
  );
};

/** 문항 한 칸. 칸 높이는 CSS 격자가 정하고, 이미지는 넘치면 축소된다(자르지 않음). */
const ProblemItem = ({ p, no }: { p: PrintProblem; no: number }) => {
  const badge = unitBadge(p.unit);
  return (
    <div className="print-item">
      <div className="item-head">
        <span className="item-no">{String(no).padStart(2, '0')}</span>
        <span className="item-src">원본 {p.source_label || p.problem_number}번</span>
        {badge && <span className="item-badge">{badge}</span>}
      </div>
      <div className="item-figure">
        {!isPlaceholder(p.image_url)
          ? <img src={p.image_url as string} alt={`문제 ${no}`} />
          : <p>{p.title}</p>}
      </div>
      {/* 풀이 공간은 .print-item 의 padding-bottom 이 담당한다(요소 없음) */}
    </div>
  );
};

const PrintWrongAnswerSheet = () => {
  const [searchParams] = useSearchParams();
  const studentId = searchParams.get('student') || '';
  const problemIds = (searchParams.get('problems') || '').split(',').filter(Boolean);
  const sheetTitle = searchParams.get('title') || '오답 시험지';

  const [problems, setProblems] = useState<PrintProblem[]>([]);
  const [student, setStudent] = useState<StudentInfo | null>(null);
  const [loading, setLoading] = useState(true);

  // 조판 설정 — CSS 변수로 흘려보내 화면 미리보기와 인쇄가 같이 움직인다
  const [presetKey, setPresetKey] = useState<PresetKey>(() => loadPrefs().preset ?? DEFAULT_PRESET);
  const [margin, setMargin] = useState<number>(() => loadPrefs().margin ?? DEFAULT_MARGIN);
  const [withAnswerKey, setWithAnswerKey] = useState(true);

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify({ preset: presetKey, margin }));
    } catch {
      /* 사생활 보호 모드 등에서 저장 실패해도 인쇄는 되어야 한다 */
    }
  }, [presetKey, margin]);

  useEffect(() => {
    if (problemIds.length === 0) {
      setLoading(false);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const [{ data: probs, error: pErr }, { data: prof }] = await Promise.all([
          supabase
            .from('problems')
            .select('id, title, problem_number, source_label, unit, image_url, correct_answer, answer_type')
            .in('id', problemIds),
          studentId
            ? supabase.from('profiles').select('name, grade, school').eq('id', studentId).maybeSingle()
            : Promise.resolve({ data: null } as any),
        ]);
        if (pErr) throw pErr;
        if (!alive) return;

        // URL 에 적힌 순서를 유지한다(선생님이 고른 순서 = 시험지 순서)
        const byId: Record<string, PrintProblem> = {};
        (probs || []).forEach((p: any) => { byId[p.id] = p; });
        setProblems(problemIds.map((id) => byId[id]).filter(Boolean));
        if (prof) setStudent(prof as StudentInfo);
      } catch (error: any) {
        toast({ title: '문제 조회 오류', description: error.message, variant: 'destructive' });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // 이미지가 다 로드되기 전에 print() 하면 빈 칸으로 출력된다 — 반드시 기다린다
  const printNow = async () => {
    const imgs = Array.from(document.querySelectorAll<HTMLImageElement>('.sheet-page img'));
    await Promise.all(imgs.map((img) => (
      img.complete ? Promise.resolve(null) : new Promise((res) => { img.onload = img.onerror = () => res(null); })
    )));
    window.print();
  };

  const printedAt = new Date();
  const printedAtStr = `${printedAt.getFullYear()}.${String(printedAt.getMonth() + 1).padStart(2, '0')}.${String(printedAt.getDate()).padStart(2, '0')}`;

  if (loading) {
    return <div className="py-20 text-center text-muted-foreground">불러오는 중...</div>;
  }

  if (problems.length === 0) {
    return (
      <div className="py-20 text-center text-muted-foreground">
        인쇄할 문제가 없습니다.
        <div className="mt-4">
          <Button variant="outline" onClick={() => window.close()}>닫기</Button>
        </div>
      </div>
    );
  }

  const preset = PRESETS.find((p) => p.key === presetKey) ?? PRESETS[1];

  const cssVars = {
    '--sheet-margin': `${margin}mm`,
    '--row-gap': `${preset.rowGap}mm`,
    '--work-min': `${preset.workMin}mm`,
    // 문자열로 넘긴다 — 숫자를 그냥 주면 렌더러가 단위를 붙일 여지가 있다
    '--rows': String(preset.rows),
  } as React.CSSProperties;

  // 쪽당 문항 수가 고정이라 나눔은 이 한 줄이면 끝난다.
  // 격자가 가로 우선(1 2 / 3 4 / 5 6)으로 흘려 준다.
  const pages: PrintProblem[][] = [];
  for (let i = 0; i < problems.length; i += preset.perPage) {
    pages.push(problems.slice(i, i + preset.perPage));
  }

  // 정답지는 마지막 장 뒤에 한 장 더
  const totalPages = pages.length + (withAnswerKey ? 1 : 0);

  return (
    <div className="bg-muted/40 min-h-screen">
      {/* 화면 조작 바 — 인쇄물에는 안 나온다 */}
      <div className="no-print sticky top-0 z-10 border-b bg-card">
        <div className="container mx-auto px-4 py-3 flex flex-wrap items-center gap-x-5 gap-y-3">
          <Button onClick={printNow}>
            <Printer className="h-4 w-4 mr-2" />
            인쇄
          </Button>

          {/* 문제 간격 — A4 한 장 기준 프리셋 */}
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">문제 간격</span>
            <div className="flex items-center gap-1.5">
              {PRESETS.map((p) => {
                const on = p.key === preset.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => setPresetKey(p.key)}
                    aria-pressed={on}
                    className={`flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                      on ? 'border-primary ring-1 ring-primary bg-primary/5' : 'hover:bg-muted'
                    }`}
                  >
                    <PresetThumb rows={p.rows} />
                    <span className="leading-tight">
                      <span className={`block text-sm font-medium ${on ? 'text-primary' : ''}`}>{p.label}</span>
                      <span className="block text-[11px] text-muted-foreground">{p.sub}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <Stepper label="여백" value={margin} unit="mm" step={2} min={4} max={30} onChange={setMargin} />

          <label className="flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={withAnswerKey} onChange={(e) => setWithAnswerKey(e.target.checked)} />
            정답지
          </label>

          <span className="text-sm text-muted-foreground ml-auto">
            총 {problems.length}문항 · <span className="font-medium text-foreground">{totalPages}페이지</span>
          </span>
          <Button variant="ghost" size="sm" onClick={() => window.close()}>
            <X className="h-4 w-4 mr-1.5" />
            닫기
          </Button>
        </div>
      </div>

      <div className="sheet-root py-6" style={cssVars}>
        {pages.map((pageItems, pi) => (
          <div className="sheet-page" key={pi}>
            {pi === 0 && (
              <div>
                <div className="sheet-header">
                  <div className="sheet-header-title">
                    <h1>{sheetTitle}</h1>
                    <p>
                      {student
                        ? `${student.name}${student.grade ? ` · ${student.grade}` : ''}${student.school ? ` · ${student.school}` : ''}`
                        : ''}
                      {' · '}출력일 {printedAtStr}
                    </p>
                  </div>
                  <div className="sheet-scoretable">
                    {['오답회차', '채점회차', '오답갯수', '확인'].map((cap) => (
                      <div key={cap}>
                        <div className="cap">{cap}</div>
                        <div className="box" />
                      </div>
                    ))}
                  </div>
                </div>
                <div className="sheet-subtitle">
                  총 {problems.length}문항
                  <span style={{ float: 'right' }}>이름 ____________　점수 ________</span>
                </div>
              </div>
            )}

            <div className="page-body">
              <div className="page-divider" />
              {pageItems.map((p, ci) => (
                <ProblemItem key={p.id} p={p} no={pi * preset.perPage + ci + 1} />
              ))}
            </div>

            <div className="page-foot">{pi + 1} / {totalPages}</div>
          </div>
        ))}

        {/* 정답지 — 마지막 장 */}
        {withAnswerKey && (
          <div className="sheet-page">
            <div className="sheet-header">
              <div className="sheet-header-title">
                <h1>{sheetTitle} — 정답</h1>
                <p>{student ? `${student.name} · ` : ''}총 {problems.length}문항 · 출력일 {printedAtStr}</p>
              </div>
            </div>
            <div className="answer-grid">
              {problems.map((p, idx) => (
                <div key={p.id}>
                  <span className="no">{String(idx + 1).padStart(2, '0')}</span>
                  <span className="ans">{p.correct_answer || '-'}</span>
                </div>
              ))}
            </div>
            <div className="page-foot">{totalPages} / {totalPages}</div>
          </div>
        )}
      </div>
    </div>
  );
};

export default PrintWrongAnswerSheet;
