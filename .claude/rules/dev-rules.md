# 개발 규칙

## UI 컴포넌트 주의사항

**Radix Portal 컴포넌트 (Dialog, Select, DropdownMenu) 사용 금지.**
Vite + React 18 환경에서 Portal 이 DOM 에 렌더링되나 시각적으로 안 보이는 버그. 이벤트도 안 전달됨.

대신:
```tsx
// Dialog → 순수 HTML/CSS 모달
{isOpen && (
  <div className="fixed inset-0 z-[9999] flex items-center justify-center">
    <div className="fixed inset-0 bg-black/80" onClick={() => setIsOpen(false)} />
    <div className="relative z-[10000] bg-background border rounded-lg shadow-lg w-full max-w-lg p-6">
      {/* 내용 */}
    </div>
  </div>
)}

// Select → native <select>
```

Button, Input, Card 등 Portal 안 쓰는 Radix 컴포넌트는 정상 동작.

### ⚠️ Tailwind content 에 `shared/` 포함 필수 (2026-07-01, 달력 UI 깨짐 원인)

**각 앱 `tailwind.config.ts` 의 `content` 배열에 반드시 `../../shared/**/*.{ts,tsx}` 를 넣는다.**
안 넣으면 `@shared/ui/*` 컴포넌트가 쓰는 클래스를 Tailwind 가 스캔 못 해 **CSS purge** → 스타일이
통째로 사라져 레이아웃이 깨진다. 증상: 달력(`@shared/ui/calendar`, react-day-picker)이 `flex`·`w-9`·
`h-9`·`head_row`·`row` 클래스를 잃어 요일·날짜가 셀 없이 한 줄로 흐름(학생 대시보드 달력 붕괴).
- 흔한 클래스(`bg-primary`·`px-4` 등)는 앱 자체 파일에도 있어 우연히 살아남지만, 달력의 `w-9 h-9`
  같은 특수 조합은 앱 어디에도 없어 purge 된다 → shared 컴포넌트만 골라 깨지는 것처럼 보임.
- **3개 앱(student/teacher/cms) 모두** content 에 shared 없었음(공통 결함). student·teacher 가
  `@shared/ui/calendar` 를 써서 깨짐 — 셋 다 `../../shared/**` 추가로 해결. 새 앱 추가 시 이 줄 필수.
- 검증: 앱 빌드 후 `dist/assets/index-*.css` 에 `.w-9{width:2.25rem}` 등 존재하면 purge 안 된 것.

### ⚠️ 화면이 통째로 백지면 코드 말고 '선언 순서'부터 (2026-08-27, TDZ)

**실제 사고**: `TextbookManagementNew.tsx` 246줄에 넣은 파생 상수가 539줄의 `useState` 를
참조했다 — 렌더할 때마다 TDZ `ReferenceError` 가 나서 **그 라우트가 통째로 백지**가 됐다.

```tsx
246:  const draggingTextbookId = draggingFolderId ? ... : null      // 여기서 읽는데
539:  const [draggingFolderId, setDraggingFolderId] = useState(null) // 선언은 여기
```

- **`tsc --noEmit` 도 `npm run build` 도 못 잡는다** — TDZ 는 실행시 오류다. 둘 다 통과했다.
  **"빌드 통과" 를 "화면 정상" 으로 읽지 말 것** — 화면은 브라우저로 봐야 확인이다.
- **규칙**: 컴포넌트 안에서 **렌더 때 바로 계산되는 파생 `const`** 는 그 값이 쓰는
  `useState`/`useRef` **아래**에 둔다. 안전한 건 **그 상수 자체가 함수인 경우**
  (`const onClick = () => setFoo(bar)`)뿐이다 — 나중에 실행되므로 순서와 무관하다.
  ⚠️ "`=>` 가 어딘가 들어 있으면 안전" 이 아니다. 사고 코드도
  `dragId ? all.find(f => ...) : null` 이었다 — `.find`·`.filter` 안 화살표는 **지금** 실행된다.
- **기계적 방어**: `.claude/tsx_tdz_hook.py`(PostToolUse) 가 `.tsx` 를 고칠 때마다 자동으로
  스캔한다. 전체 훑기는 `/cms-dev-check` 5단계. 산문 규칙만으로는 안 지켜진다는 게
  이 파일이 이미 내린 결론이다(19차).

### ⚠️ uvicorn 워커가 `python.exe` 가 아니라 `python3.12.exe` 로 뜬다 (2026-08-27)

`/server-check` 와 ★체크리스트가 안내하는
`Get-CimInstance Win32_Process -Filter "Name='python.exe'"` 는 **이 워커를 못 잡는다**.
실측: 8001 을 물고 있던 것은 `python3.12` (PID 12440) 였고, 위 필터에는 한 건도 안 나왔다.
그 상태에서 "살아있는 python 없음 + netstat 은 PID 8384 표시 + HTTP 는 200" 이라는
모순된 그림이 나와, 자칫 "죽은 소켓인데 200이 나온다"는 잘못된 결론으로 샐 뻔했다.

→ **이름으로 거르지 말고 이름 패턴으로 본다**:
```powershell
Get-Process | Where-Object { $_.ProcessName -like '*python*' -or $_.ProcessName -eq 'node' } |
  Select-Object Id, ProcessName, StartTime
```
`Get-NetTCPConnection -LocalPort 8001 -State Listen` 의 `OwningProcess` 도 같이 본다.
`taskkill /F /PID <워커>` 후 `Test-NetConnection 8001` 이 **False** 여야 진짜 해제다.

### ⚠️ `--reload` 를 믿지 말 것 — 새 라우터는 404 로 확인된다 (2026-08-27)

`main.py` 에 `include_router` 를 추가했는데도 uvicorn 이 옛 코드를 서빙 중이었다
(`/api/messages/config` 가 **404**). 재기동 후 같은 요청이 **422**(Authorization 누락)로
바뀌어야 새 코드다. **엔드포인트 하나를 골라 404→(401/422) 전환을 눈으로 확인**하는 것이
"재기동했다"를 검증하는 가장 싼 방법이다.

## 프로젝트 격리 원칙 (필수)

- **`math/` 외부 파일 절대 수정/삭제 금지** — 읽기/복사만 허용
- `C:\potenup3\pj3_deep_learning\` 는 특히 절대 금지 (YOLO 학습 결과물 — 삭제 시 복구 불가)
- 외부 파일 건드려야 할 것 같으면 **반드시 사용자에게 먼저 확인**
- YOLO predict/train 시 `project` 파라미터에 반드시 절대경로 사용 (글로벌 runs_dir 이 외부 경로를 가리킴)

## YOLO / bbox 규칙

- **bbox 자동 보정 코드 추가 금지** — 사용자가 CMS 편집기에서 수동 수정
- YOLO 추론 conf 현재 0.3 (main.py L141)

## 문제 PDF 크롭 — 앵커 기반 분할 (2026-08-26 스캔본 개편)

크롭은 **문제번호 앵커 사이를 자르는 것**이지 YOLO 로 박스를 추론하는 게 아니다.
YOLO 는 모의고사 판형으로만 학습돼 다른 교재에서 심하게 과검출한다(실측 300dpi:
교육청 23문항에 100박스). 앵커는 두 곳에서 온다 — 코드 `pipeline/text_anchor_segmenter.py`.

| PDF | 앵커 공급원 | 모듈 |
|-----|-------------|------|
| 디지털(텍스트 레이어 있음) | 텍스트 span 좌표 | `text_anchor_segmenter.spans_from_doc` |
| 스캔본(레이어 0) | **색 라벨** → 위치, OCR → 번호 | `ocr_anchor_provider.collect_color_labels` |
| 둘 다 실패 | YOLO 폴백 | `yolo_detector` |

### 스캔본은 "번호를 읽어서 위치를 찾지" 말 것 — 색으로 찾는다

옛 방식(단 왼쪽 띠를 통째로 OCR)은 쎈 17쪽에서 120문항 중 70~75개만 잡았다. 원인 셋:

1. **단 왼쪽을 `w*0.03` 으로 고정**했는데 교재는 펼침면이라 쪽마다 여백이 반전된다
   (실측: 짝수쪽 63~65pt / 홀수쪽 25~31pt). OCR 띠가 번호를 반으로 잘라 **짝수쪽 좌단이 전멸**.
2. **신뢰도로는 안 갈라진다** — 진짜 번호 conf 0.582~1.000(0193=0.702), 잡음 '3410'=0.893.
3. **`대표 문제` 배지(주황 바탕 흰 글씨)는 OCR 이 못 읽는다** — 200/300/400dpi 전부 실패,
   반전 OCR 도 절반만. 못 읽은 18개가 **전부** 배지였다.

그런데 이 판형들은 문제번호가 **예외 없이 채도 높은 색**이고 본문은 검정이다. 그래서
**단 왼쪽 35% 창에서 색 덩어리를 찾으면 위치가 정확히 나온다**(OCR 이 못 읽는 배지까지).
번호는 그 라벨 패치만 3배 확대해 읽어 정렬·중복제거에만 쓴다. 결과 **120/120, 잡음 0**.

실측으로 정한 값 (200dpi 기준, `ocr_anchor_provider.py` 상수):
- `_LABEL_WINDOW=0.35` — 이 창이 유형 헤더·세로 색인 탭·우측정렬 상호참조를 자동 배제한다.
  창을 안 씌우면 그것들이 라벨 띠와 합쳐져 높이 필터에 걸려 번호가 통째로 사라진다.
- `_LABEL_H_MIN/MAX=10/45` — 평문 번호 24~30px, 배지 37~38px, 쪽 로고 148~171px.
- 번호를 못 읽은 라벨은 **앞뒤 번호 사이에 빈 자리가 있을 때만** 채택(오검출 2개 정확히 탈락).

### 단 경계는 잉크가 아니라 **문제번호 라벨**에서 잡는다 (2026-08-26 2차)

1차 개선 후 교사가 120개를 검수했더니 **63개(52%)를 손봐야 했고, 그중 59개가 같은 원인**이었다:
단 사이 **세로 괘선**이 잉크라 `detect_columns` 의 경계가 거기까지 벌어진다. 괘선이 쪽마다
좌단 오른쪽에 붙기도 우단 왼쪽에 붙기도 해서 "우단이 가운데를 넘어옴 / 가끔 좌단도" 로 보인다.

**잉크 기준으로는 못 고친다** — 괘선의 세로 연속 길이가 쪽마다 129~502px 로 널뛰어 임계값을
낮춰도 절반은 안 잡힌다(6·8·10·11·14쪽 실측). 대신 **문제번호는 정의상 그 단 텍스트의 왼쪽 끝**
이므로 라벨 위치를 쓰면 장식에 전혀 흔들리지 않는다.

- `col_x0 = min(라벨 왼쪽 x) − _LABEL_LEFT_MARGIN(2.9pt)`
  실측: 교사 경계와 **34개 단 전부** +4~+25px(중앙 +12px) 일치.
- `col_x1` = 마지막 단이면 잉크 경계, 아니면 **다음 단 경계 − `_COLUMN_CLEARANCE`(14pt)**.
  괘선은 다음 단 라벨보다 44~63px(300dpi) 왼쪽에 있어 14pt 를 비우면 정확히 빠진다.
- **라벨 경계에는 `x_pad` 를 더하지 말 것** — 8pt 를 더 벌리면 괘선이 다시 범위에 들어와
  `tighten_by_ink` 가 거기에 고정된다(실측 p9 #64).

### 탈락시킨 색 라벨도 버리지 말고 다음 문제의 시작으로 쓴다

☆**사고의 기술** 배지처럼 번호 위에 얹힌 표식은 색 라벨로 잡히지만 번호가 안 읽혀
"빈 번호 규칙" 으로 탈락한다. 그런데 그냥 버리면 **앞 문제 크롭이 배지까지 내려온다**
(실측: 0276 이 82pt → 233pt, 세 배). `_attach_to_next` 로 바로 아래(40pt 이내) 같은 단 앵커의
시작을 라벨 위치로 끌어올린다 — 교사도 배지를 다음 문제 쪽에 포함시켰다(0277 위변 291→280pt).

### 같이 배운 함정 3가지

- **`_content_rect` 는 스캔 쪽에서 쓰면 안 된다** — 벡터 좌표가 없어 우연히 걸린 장식 이미지
  하나가 크롭을 지배한다(실측: 15pt×52pt 조각으로 붕괴). `_has_vector_content` 로 걸러
  스캔 쪽은 `tighten_by_ink`(실제 잉크) 에 맡긴다. 전면 배경 래스터도 무시한다
  (쪽 높이 50% 초과 이미지 — 디지털 PDF 4종엔 그런 이미지가 0개라 회귀 위험 없음).
- **단 경계에 괘선·색인 탭이 딸려 온다** — 세로로 쪽 높이 10% 이상 연속인 잉크 열은 본문이
  아니다(`_vertical_furniture`). 탭 글자는 세로쓰기라 획이 짧아 이걸로 안 잡히므로,
  **넓은 흰 틈(쪽 폭 3% 이상) 너머의 좁은 조각**도 잘라낸다(본문 내부 틈은 최대 36px,
  탭 앞 틈은 61~69px — 그 사이로 가름).
- **분할 하단(`bottom_ratio`)을 `_MARGIN_BOTTOM`(0.85) 으로 쓰면 각 단의 마지막 문제가 잘린다.**
  그 상수는 '이 아래 숫자는 문제번호가 아니다' 를 위한 값이지 본문 하단이 아니다.
  실측: 본문 마지막 줄 88.1% / 꼬리말 95.6% → 단의 잉크 하단을 직접 재서 쓴다
  (`column_ink_bottom`). 얼룩을 집지 않게 행 임계는 단 폭의 1.5%.

### 검증 방법 (이 작업에서 통한 것)

**회귀는 `scripts/crop_regression.py` 로 돌린다** (크롭 코드를 건드렸으면 반드시):

```bash
cd backend/pdf_pipeline && venv/Scripts/python.exe -m scripts.crop_regression
```

고정 데이터 `tests/fixtures/ssen_user_boxes.json` = 교사가 CMS 에서 검수한 120개 bbox.
⚠️ **120개가 다 정답이 아니다** — 교사는 거슬리는 것만 고치므로 `corrected_by_user=false` 인
57개는 알고리즘 원본이 남은 것이다. 그걸 정답으로 채점하면 "옛 버그를 그대로 재현해야 만점" 이
된다. 스크립트가 두 집합을 갈라 본다.

합격 기준 셋(하나라도 어기면 반영 금지):
- **내용 손실 0건** — 교사 박스 안 글자급 잉크가 새 박스 밖으로 나가면 실패. 박스가 넓은 건
  사람이 줄이면 되지만 잘린 문제는 못 쓴다. **이게 수치보다 중요하다.**
- **악화 20px 초과 0건** / **개선이 악화의 5배 이상**

2차 개선 실적: 중앙 오차 60→12px, 손봐야 할 박스(40px 초과) 50→**1개**, 개선 51/악화 6
(악화는 전부 24px 이하 = 6pt), 내용 손실 2건→**0건**, 디지털 PDF 4종 rect 완전 동일.


- **교사가 손으로 고친 bbox 가 정답 기준**이다. `problem_staging.bbox`(300dpi 픽셀)를 꺼내
  새 알고리즘 결과와 네 변 오차를 비교한다. 이번엔 15개 중 15개가 15pt 이내(평균 5.3pt).
- **회귀는 `git stash` 로 전/후를 같은 스크립트로 돌려 rect 까지 비교**한다. 디지털 PDF
  4종(교육청 2·수능특강·바이블)이 anchors/regions/rect 전부 동일해야 통과.
- 수치만 맞고 내용이 잘릴 수 있으니 **크롭 PNG 를 반드시 눈으로 본다**.

### 빠른정답은 스캔본이라 VL 로 읽는다 (2026-08-27)

교재 빠른정답 PDF 는 **텍스트 레이어가 0자**다(실측: 쎈 공통수학1 6쪽 전부). 그래서
기존 `solution_parser.extract_quick_answers`(PyMuPDF 텍스트 + `"N. [정답] X"` 형식)로는
한 글자도 못 읽는다 — 그건 해설지용이라 이 판형과 무관하다. `answer_key_reader` 가 담당한다.

- **단(column) 단위로 자른다** — 한 쪽에 2단이고 한 단이 한 대단원이다. 쪽을 통째로 넣으면
  항목이 빽빽해 누락 위험이 크다. 단 검출은 `ocr_anchor_provider.detect_columns` 재사용.
- **두 번 읽어 대조한다** — 정답은 틀리면 학생이 맞는 답을 쓰고도 오답이 된다.
  실측: 164개 중 다른 것 4개였고 **전부 공백 차이**였다(`(1) -1  (2) 74` vs `(1) -1 (2) 74`).
  공백을 지우고 비교하면 164/164 일치. 다른 것만 검수 표에 표시한다.
- **매칭은 지면번호(`source_label`)로** 한다. 순번(problem_number)은 크롭 순서라 교재 번호와
  다르다. 크롭이 이미 앵커로 읽어 둔 값을 저장해 쓴다(못 읽은 것은 `infer_labels` 가 보간).
- 실측: 교재 전체 1316개를 6분에 읽고, 대상 단원 120/120 매칭, 손볼 것 5개.

#### 답지 유일성은 교재가 아니라 **스코프**로 건다 (2026-08-27, 029)

028 은 `UNIQUE(textbook_id, label)` 이었다. 쎈은 번호가 책 전체에서 유일해 문제없지만,
**모의고사·내신은 한 교재 안에서 번호가 겹친다**(실측):

```
[고3 모의고사] 평가원 6월 24년 / 25년 / 26년 — 세 폴더 모두 problem_number 1~30
[내신 기출]    대장중 / 태원고 / 이매고      — 같은 문제
```

25년 답지를 넣으면 24년 답지를 **말없이 덮어쓴다**. 그래서 `answer_keys.folder_id` 를 달고
유일성을 `scope_id = COALESCE(folder_id, textbook_id)` 로 옮겼다.

- **`(textbook_id, folder_id, label)` 로 걸면 안 된다** — Postgres 는 UNIQUE 안의 NULL 을
  서로 다르게 봐서 folder_id IS NULL(교재 전체) 쪽에 제약이 **전혀 안 먹는다**.
  `profiles.user_id` 중복 21개 사고와 같은 부류다. COALESCE 로 NULL 을 없애야 실제로 막힌다.
- 조회는 `get_answer_keys(textbook_id, folder_id)` 가 **폴더 답지로 교재 전체 답지를 덮어** 준다.
  덕분에 쎈은 교재 전체 한 벌로 모든 단원이 채워지고, 모의고사는 회차 것만 붙는다.
- 스코프는 **지금 선 자리**를 따른다(추측 안 함): 폴더를 고르고 열면 폴더, 교재면 교재,
  job 에서 열면 그 job 문제들의 폴더(`_job_scope` — 섞여 있으면 교재 전체).

#### 돈 쓰기 전에 첫 쪽만 읽어 본다

`POST /api/answer-key/{id}/probe` — 1쪽 1회만 읽고 **저장하지 않는다**. 판형이 안 맞는 PDF 에
권당 비용을 통째로 날리는 걸 막는다. 견적은 `plan_read()` 가 VL 없이 계산한다
(실측 검증: 쎈 6쪽 → `calls_max` 24, 실제 22회 — 정답 없는 단은 2차를 건너뛰므로 상한이 맞다).
같은 PDF 재업로드는 `source_hash`(sha256)로 걸러 되묻는다.

⚠️ **`cross_check`(2회 읽기)는 전체 읽기에서 끄지 말 것.** 비용이 반이 되지만 그게 오답
정답표를 막는 유일한 장치다(실측: 164개 중 4개가 달랐다).

#### 모델은 `ANSWER_KEY_MODEL`(기본 gpt-5.2) — 싼 모델로 바꾸지 말 것 (2026-08-27)

`_read_column` 은 `call_vl(..., model=_ANSWER_KEY_MODEL)` 로 **명시 주입**한다.
예전엔 이 호출부만 `model=` 이 없어 `.env` 의 `OPENAI_MODEL`(튜터용)로 떨어졌다 —
튜터 모델을 바꾸면 정답 읽기 모델이 **말없이 같이 바뀌는** 자리였다. 정답이 틀리면 학생이
맞는 답을 쓰고도 오답이 되므로 조용한 변경이 특히 위험하다.

**"비용 아끼자" 며 싼 모델로 갈아끼우면 비용도 정확도도 나빠진다.** 같은 단 이미지 1장 실측:

| 모델 | 시간 | 입력 | 출력 | 읽은 항목 |
|---|---|---|---|---|
| **gpt-5.2** | **15.7s** | **1,955** | **1,557** | **128** |
| gpt-4o | 30.3s | 1,941 | 2,783 | 128 |
| gpt-4o-mini | 19.3s | 48,665 | 1,642 | 109 |

- gpt-4o 는 2배 느리고 출력 토큰 1.8배 → **더 비싸다**(출력이 비용의 대부분이라 그대로 비용차).
- gpt-4o-mini 는 **입력이 25배**(이미지 타일 계산 방식이 다름)에 `\frac` 이 깨지고 19개 누락.
- `gpt-5.2-mini` 는 없다(400 model does not exist).

**비용 구조**: 6쪽 × 2단 = 12단, 그중 10단을 2번 읽어 **한 권에 22회 호출**
(입력 ~44k / 출력 ~33k 토큰). **비용의 약 85%가 출력** — 정답 1,316개를 두 번 뱉기 때문이다.
한 번 읽으면 `answer_keys` 에 저장되므로 **같은 교재의 다른 단원은 추가 비용 0**.
`cross_check`(2회 읽기)를 끄면 비용이 반이지만 **끄지 말 것** — 그게 오답 정답표를 막는 유일한 장치다.

⚠️ OpenAI 조직 사용량 API(`/v1/organization/costs`)는 프로젝트 키로 **403**
(`api.usage.read` 스코프 없음). 항목별 청구는 대시보드에서 봐야 한다.

#### 실제 판형 4종으로 검사한 결과 (2026-08-27)

교육청 모의·낙생고 내신·야탑고 내신·쎈 수학1 로 검사해 세 가지를 고쳤다. 넷 다 정확히 읽힌다
(교육청 23/23, 낙생고 22/22, 야탑고 21/21, 쎈수학1 학습플래너 쪽 0개).

| PDF | 쪽 | 텍스트 레이어 | 단 | 번호 | 견적 |
|---|---|---|---|---|---|
| 교육청 모의 | 1 | 315자(**PUA**) | 1 | `1.`~`23.` | 2회 |
| 낙생고 내신 | 1 | 155자(번호만, 정답은 이미지) | 2 | **`01`~`22`** | 4회 |
| 야탑고 내신 | 1 | 806자(**PUA+DRM**) | 1 | `1)`~`21)` | 2회 |
| 쎈 수학1 | 6 | 0자 | 2씩 | `0001`~ | 24회 |

**① 단 바깥 경계는 잉크 끝까지, 단 사이는 맞붙인다.** `detect_columns` 의 경계가 **본문 끝과
딱 겹치는** 판형이 있다 — 야탑고 실측: 본문 잉크 x117~1208 인데 단 경계가 118~1207 이라
오른쪽 단(20·21번) 답의 끝 5px 이 이미 잘려 나갔다. 답이 두 자리라 살았지 세 자리였으면
통째로 날아간다. 단 사이 틈에도 단원 배지 테두리가 걸친다(쎈 수학1 6쪽 860px).
→ 첫 단은 잉크 왼쪽까지, 마지막 단은 잉크 오른쪽까지 늘리고, 각 단을 다음 단 시작까지 붙인다.
**5종 전부 잉크 손실 0** 확인(`_column_clips`).

**② 번호는 정확 일치 우선 + 숫자 폴백, 단 모호하면 안 쓴다.** 낙생고 답지는 `01`~`22` 인데
문제지는 `1`~`22` 다 — 문자열 일치만 하면 **한 개도 안 맞는다**. 그런데 그냥 숫자로 정규화하면
쎈의 `0001`(문제)과 학습플래너 `01`(대단원)이 둘 다 1 이 되어 **엉뚱한 정답이 들어간다**.
→ `_index_answer_keys`: 같은 숫자에 서로 다른 라벨이 2개 이상이면 그 숫자 별칭은 통째로 버린다.
정확 일치되는 번호는 별칭을 안 타므로 쎈은 동작 불변(120/120 유지).

**③ 대조에서 LaTeX 공백 명령은 무시한다.** VL 은 같은 식을 읽을 때마다 `\;` / `\ ` / `\,` 를
달리 뱉는다(실측: 쎈 한 쪽 269개 중 9개가 이 차이뿐). 안 지우면 '두 번 읽어 다름' 이 헛되이
쌓여 **정작 봐야 할 항목이 묻힌다**. `_squash` 가 `\,\;\:\!\quad\qquad`·백슬래시공백을 지운다.
진짜 오독(`ㄱ,ㄷ,ㅂ` vs `ㄱ,ㄷ,ㄴ`)은 그대로 걸린다.

**④ `가-힣` 은 자모 ㄱㄴㄷ 을 못 잡는다.** 자모는 U+3130~318F 로 별도 블록이라
`ㄱㄷ` 같은 답이 '확인 필요' 를 그냥 통과했다. 실측에서 VL 이 `ㄹ` 을 `ㄴ` 으로 오독했으므로
반드시 사람이 봐야 한다 → `classify` 의 한글 판정에 자모 범위를 넣었다.

**⑤ 대조 임계값을 5→1 로.** 예전엔 한 단에 정답이 5개 미만이면 2차 읽기를 건너뛰어
**문제가 4개 이하인 작은 시험지가 검증 없이 통과**했다. 이제 0개일 때만 건너뛴다.

#### ⚠️ 텍스트 레이어가 있어도 그걸로 읽지 말 것

교육청·야탑고는 텍스트가 있어 "VL 없이 공짜로" 로 보이지만 **안 된다**:

- 숫자 정답이 **사용자 영역 문자(PUA)** 다. 실측 매핑 `U+E034~E03D = 1,2,3,4,5,6,7,8,9,0`
  — 지면엔 `32` 로 찍히는 것이 텍스트로는 두 개의 PUA 문자다. 그대로 뽑으면 깨진 글자가
  정답으로 저장된다.
- 야탑고 텍스트에는 **DRM 워터마크 base64** 가 정답 사이에 섞여 있다(화면엔 안 보임).
- 형식이 `N. [정답] X` 라 **기존 `solution_parser.extract_quick_answers` 정규식에 걸린다**
  — 누가 "텍스트니까 그걸 쓰자" 하면 **조용히 깨진 정답이 들어간다**. 이게 가장 위험하다.

렌더한 이미지에는 정상 숫자로 보이고 워터마크도 안 보인다 → **VL 로 이미지를 읽는 지금 방식이 맞다.**

### 폴더 순서는 드래그로 — `sort_order` 를 다시 매긴다 (2026-08-27)

폴더 목록은 `sort_order` 로 정렬해 가져오는데, 그 값이 만들 때 정해진 뒤로 안 바뀌어
**같은 값이 여럿 생긴다**(실측: 고3 모의고사 세 회차가 1·2·2 → 순서가 들쭉날쭉).
그래서 드래그로 옮길 때 **그 형제 전체를 1부터 다시 매긴다**(`reorderFolder`).

- **한 줄을 삼등분**한다 — 위/아래 가장자리에 놓으면 순서 바꾸기(표시선), 가운데면
  기존처럼 그 폴더 안으로(테두리). `getBoundingClientRect` + `clientY` 로 가른다.
- 다른 부모로 건너뛸 때만 순환 검사를 한다. 같은 부모 안 순서 바꾸기에 `canBeParent` 를
  쓰면 안 된다 — 그 함수는 `candidateId === moving.parent_id` 를 **false** 로 돌려준다.

⚠️ **드래그 대상은 `folderList`(선택된 교재)가 아니라 `allFolders`(모든 교재)에서 찾는다.**
옛 코드는 선택된 교재 목록만 봐서, 다른 교재를 펼쳐 놓고 끌면 `find` 가 undefined 를 내고
**아무 일도 일어나지 않았다**("고3 모의고사는 이동이 안 된다"의 정체). 에러도 안 나서 더 헷갈린다.
같은 부류로 삭제(`descendantIds`)·폴더 이동 모달·이동 후 `fetchFolders` 도 선택된 교재를
가정하고 있었다 — 전부 **그 폴더가 속한 교재**를 쓰도록 고쳤다.

**폴더는 교재 경계를 넘지 못한다**(사용자 결정). 넘게 하면 하위 폴더·문제·staging 의
`textbook_id` 를 전부 다시 붙여야 하고 하나만 빠져도 브레드크럼이 엉뚱한 교재를 띄운다
(실측 전례: 쎈 120문제가 folder=쎈 / textbook=내신 기출). `sameTextbook` 이 막고,
**다른 교재 위에서는 드롭 표시선 자체를 안 띄운다** — 될 것처럼 보였다가 거부되면 더 나쁘다.

⚠️ **최상위(parent=null) 형제를 `allFolders` 에서 거르면 안 된다** — 다른 교재의 최상위
폴더까지 형제가 된다. `siblingsIn(textbookId, parentId)` 로 교재별로 가른다.

⚠️ **`sort_order` 만 담아 `upsert` 하면 안 된다.** PostgREST 가 INSERT 로 취급해
`null value in column "textbook_id" ... violates not-null constraint`(23502)로 통째 실패한다.
형제는 많아야 열 몇 개이므로 **바뀐 것만 개별 `update`** 로 보낸다(실측 확인).

### 단계 배너로 PDF 를 구간 나누기 (2026-08-27)

쎈은 한 단원 안에 A/B/C단계가 이어져 있다. 통째로 크롭하면 단계가 한 폴더에 섞이므로,
**단계가 바뀌는 쪽을 찾아 그 구간만 자른다**(`pipeline/stage_sections.py`,
`POST /api/pdf/sections`). 크롭 자체는 이미 쪽 범위를 지킨다 — `extract_images_from_pdf` 가
그 범위만 렌더하고 `_run_text_anchors` 가 "렌더된 페이지만 대상" 으로 거른다. **경계만 찾으면 된다.**

- **배너의 '높이'로 찾는다.** 단계가 바뀌는 쪽 맨 위에 큰 배너가 있다. 왼쪽 위 구석
  (가로 0~22%, 세로 0~11%)에서 채도 높은 행의 길이를 재면 실측(200dpi, 17쪽):
  **배너 쪽 6.4~6.5% / 나머지 1.0~2.1%**(문제번호 색 라벨). 3배 차이라 3.5% 로 자른다.
- **높이는 '이어진 구간'의 최대 길이로 재야 한다.** '첫 색행~끝 색행' 으로 재면 색 번호가
  여러 줄인 지면에서 줄 사이 흰 틈까지 합쳐진다 — 실측: 쎈 수학1 **빠른정답표가 6쪽 중
  4쪽이나 배너로 잡혔다**. 배너는 통글자 하나라 한 덩어리로 이어진다. 고친 뒤 빠른정답 4종
  전부 오검출 0.
- ⚠️ **배너 글자(A/B/C)는 읽지 않는다.** 입체 일러스트라 OCR 이 못 읽는다 — `대표 문제`
  배지가 200/300/400dpi 전부 실패한 것과 같은 부류. 대신 **배너 조각을 그림으로 돌려주고
  화면에서 고르게** 한다. 초록 `B`·청록 `C` 가 그대로 보이므로 헷갈릴 여지가 없고,
  서버가 몰래 판단해 엉뚱한 폴더에 넣는 일도 없다.
- 배너가 1개 이하면 **빈 목록**을 준다 → 화면은 지금처럼 손으로 쪽을 넣는다(graceful).
- **VL 을 안 부른다 → 비용 0.**

### 폴더를 옮길 땐 problem_staging 도 같이

CMS 의 `handleMoveToFolder` 는 **`problems` 만** 갱신한다. staging 의 folder_id 가 옛 폴더에
남으면 빠른정답 스코프 추정(`main._job_scope`)이 엉뚱한 폴더를 가리킨다.
`scripts/split_folder_by_label.py` 는 둘 다 맞춘다.
(쎈은 답지가 교재 전체 스코프라 지금은 표가 안 나지만, 모의고사 답지를 폴더 단위로 쓰면 드러난다.)

### 이미 올라간 job 을 다시 자를 때

`python -m scripts.recrop_job <job_id> --keep-pages N [--apply]`.
`--keep-pages` 까지는 기존 행을 손대지 않는다(교사가 고친 bbox 보존). `--apply` 없으면 dry run.

## YOLO 재학습 기본 방침 (2026-04-21 결정)

- 기본 모델: **YOLO11m** (11n 대비 mAP50-95 소폭 우위, 레거시와 동급 capacity)
- HP 튜닝: **Optuna TPE + MedianPruner** 로 소량 데이터 파인튠 lr 발산 방지
- 이유: 11m 은 소량 데이터 (<200장) 에서 ultralytics 기본 `optimizer='auto'` (AdamW lr=0.002) 로 epoch 2~5 에 발산 — 감으로 lr 잡기 어려움
- 데이터셋별 best HP 영역 다름 — 문제(~102장): AdamW lr~1e-5 wd~4e-2 / 해설(~19장): AdamW lr~1e-3 wd~1e-4. **새 데이터 분포 크게 바뀌면 Optuna 재실행**
- 템플릿 스크립트 (모두 `backend/pdf_pipeline/yolo_training/`):
  - `optuna_search_problem.py`, `optuna_search_solution.py` — HP search (SQLite 에 study 저장)
  - `train_problem_11m.py`, `train_solution_11m.py` — best HP 고정 full train
- 실행 시 반드시 `cd backend/pdf_pipeline/yolo_training` — yaml 내 `../uploads/...` 가 CWD 기준으로 해석됨
- 학습 후 `models/problem_detector.pt` / `solution_detector.pt` **자동 덮어쓰기 금지** — metric 확인 후 수동 `cp`

## VL 모델 정책 (2026-06-22 갱신 — 모델 분리, 검증 폐기 / 2026-06-19 gemma4 폐기·OpenAI화)

- **VL 은 OpenAI.** gemma4(ollama)·gemini 는 폐기. Call A(메타)·튜터(막힌 지점 찾기/힌트 만들기/노드추출) 모두 OpenAI.
  - 옛 시간대 분기(`provider_selector`)·난이도 분기(`_route_call_b_provider`, `CALL_B_HARD_THRESHOLD`)·gemma4 반복 폭주 방어 코드는 모두 제거됨.
- **모델 분리 (2026-06-22).** 메타 Call A 는 `META_MODEL`(기본 **gpt-4o**, `solution_tagger.py`). 풀이 노드 추출(`rag_node_extractor.py`)은 **난이도(`difficulty_score`)로 분기** — `_pick_node_model()`: **Lv1~2(score 1~2)→gpt-4o(`NODE_MODEL_EASY`)**, **Lv3~4(score 3~4)→gpt-5.2(`NODE_MODEL_HARD`)**. score 가 없거나(None)·범위 밖(옛 1~10 데이터의 5~10 등)이면 안전하게 **상위(hard=gpt-5.2)**. `call_vl(model=...)` 로 분기 결과를 명시 주입하므로 `OPENAI_MODEL` env 무관. env(`META_MODEL`/`NODE_MODEL_EASY`/`NODE_MODEL_HARD`)로 덮어쓸 수 있다(옛 `NODE_MODEL` env 는 hard 기본값으로 하위호환 흡수). 난이도 분기 근거: 쉬운 문제는 논리 분해가 단순해 gpt-4o 로 충분, 어려운 문제만 도형 언어화·경우분리가 무거워 gpt-5.2 필요.
- **태깅 검증 폐기 (2026-06-22).** 옛 2-layer 검증(`tag_validator.py` + `solution_tagger._apply_suggested_fixes`)은 통째 제거. 파일 삭제 + 호출부 제거(`solution_tagger`/`solution_matcher`) + CMS 검증 배너 제거(`ProblemDetail.tsx`). `problem_staging` 의 `validation_status/score/issues` 컬럼은 **DB 보존이나 항상 NULL**(되돌리기 쉽게 DROP 안 함). 메타는 Call A 결과를 그대로 저장. "검수완료 - 전체 AI" 한 번에 메타(gpt-4o) + 백그라운드 노드 추출(난이도 분기: Lv1~2 gpt-4o / Lv3~4 gpt-5.2)이 같이 돈다(노드 자동추출은 이미 `approve_all` 에 묶여 있음).
- **해설 태깅 = Call A(메타) 한 번** (2026-06-20, 4차). 옛 단계별풀이 Call B(2-Pass)와 4필드(solution_summary/pitfall/solution_steps/common_mistakes)는 추출·저장·검증·DB컬럼까지 전부 제거. 풀이 그래프는 별도 추출기 `rag_node_extractor.py` 가 담당.
- **임베딩은 그대로** — bge-m3(ollama, 1024차원) 유지. OpenAI 임베딩(1536)으로 바꾸면 전체 재임베딩 필요라 안 바꿈. `EMBED_PROVIDER=openai` 로만 강제 전환 가능.
- 그 외 유료 API (Gemini / Anthropic / 다른 모델) 도입은 금지.
- 품질 개선은 VL 교체 대신 프롬프트 튜닝, 후처리 강화, 구조화 스키마 (Pydantic structured output) 로 접근.
- **노드 role 라벨링**(`rag_node_extractor.py`): 각 노드에 `role` 필드 (5종: condition_analysis / equation_setup / case_split / computation / conclusion). 1회 통합 추출로 전체 노드 배열을 받고, 노드마다 `uses`(이전 node_index 참조 = 전이 근거 DAG)·`whys`({question,reason} = 논리 완결성)를 포함. role 별로 hint·formula·whys 톤을 조정(유형별 프롬프트 라우팅). reject 시 재시도 없음 (CMS 노드 편집기에서 수동 보정).

## 모델 파일 동기화

- 학습 기본은 **서버** (평일 GPU 접근 가능). 주말 등 서버 미사용 시 **로컬 학습** 허용 — 기능적으로 동일
- `backend/pdf_pipeline/yolo_training/models/` 에 **문제/해설 2개 .pt 파일만 존재** — .gitignore 대상 (git 동기화 불가)
- 재학습 직후 반대편으로 `scp` 덮어쓰기:
  - 서버→로컬 (PowerShell): `scp wanted-1@wanted-1:/home/wanted-1/WantedPotenUp/personal/hyunwook/math/math-agent/backend/pdf_pipeline/yolo_training/models/*.pt C:\Users\user\workspaces\math\backend\pdf_pipeline\yolo_training\models\`
  - 로컬→서버: 경로 반대로
- 학습 위치는 커밋 메시지나 `runs/` 디렉토리명에 기록 (혼선 방지)

## 오답 복습 = 날짜가 아니라 **횟수** (2026-08-27)

**한 번 틀린 문제는 무조건 총 5회 푼다**(최초 1회 + 복습 4회). **정답 여부와 무관** —
3회차에 맞아도 4회차를 푼다. 회차 수는 `REVIEW_TARGET_ROUNDS`(shared/lib/api.ts) 한 줄.

### ★ 5회는 맞지만 **배포는 4개**다 — 자동 생성 (2026-08-28 개편)

```
1회차 처음 풀기      ← 원본 배포
2회차 당일 재풀이    ← **같은 원본 배포 안에서** 오답만 (배포를 안 만든다)
3회차 다음 수업 (빨) ┐
4회차 2주      (주) ├ 학생이 다 풀면 **자동 생성**되는 복습 배포 3개
5회차 4주      (노) ┘
```

선생님 루틴이 정해져 있다 — 학원에 오면 1회 풀고, 그날 오답을 바로 다시 풀리고 퇴원시킨다.
**정해진 일을 매번 손으로 누르는 게 문제**였고 바쁘면 놓쳤다. 그래서
`auto_create_reviews_for_distribution`(035)이 자동 채점 직후 3개를 만든다.
**[복습 예약] 버튼은 화면에서 뺐다**(모달·API 는 남겨 둠 — 되살리려면 버튼만 복구).

- **호출은 학생 화면에서** 한다(`SolveProblem.handleSubmit` 성공 직후). teacher_id·오답 목록은
  RPC 가 DB 에서 파생하므로 클라이언트가 못 속인다. 넘기는 건 날짜뿐.
- **담기는 문제 = 첫 시도에서 틀린 것**(`DISTINCT ON … ORDER BY submitted_at ASC`).
  당일 재풀이로 맞혀도 이 묶음은 안 바뀐다 — 3번 그대로 반복하는 게 선생님 요구다.
  덕분에 **나중에 언제 불러도 결과가 같아** 멱등이 성립한다.
- **⚠️ 실패해도 제출은 성립시킨다.** 여기서 throw 하면 학생이 "제출 실패"로 읽고 다시 눌러
  `student_answers` 에 행이 더 쌓여 **회차가 두 칸 뛴다**. `try/catch` 로 감싸고 경고만.
- **안전망**: 학생 브라우저가 죽으면 RPC 가 안 돈다 → `find_missing_review_batches` 가
  최근 2주 중 "풀어서 오답이 났는데 복습이 없는" 원본을 찾아 오답 관리 배너로 알린다.
  **몰래 만들지 않는다** — 선생님 모르게 학생 화면에 과제가 뜨면 안 된다.
- 중복은 코드(EXISTS) + **부분 유니크 인덱스**(`uq_distributions_auto_review`) 두 겹으로 막는다.
  탭이 두 개면 동시에 들어올 수 있어 코드 검사만으로는 부족하다.

⚠️ **`review_stage` 번호를 다시 매기지 말 것.** 타임라인이 `표 회차 = 예약 stage + 1` 로
매핑한다(`buildReviewTimeline`). 숙제(stage 1)를 없앴다고 2·3·4 를 1·2·3 으로 당기면
**5칸이 통째로 밀린다** — 032 주석에 같은 실수로 4칸이 전부 어긋난 실측이 있다.
없어진 stage 1 자리는 '당일 재풀이'(배포 없음)가 차지한다. 단위테스트 20건이 이걸 지킨다.

**색은 `REVIEW_KIND_STYLE`(reviewSchedule.ts) 한 곳에서만** 정의한다 —
원본 파랑 / 다음수업 **빨** / 2주 **주** / 4주 **노** / 보충 회색.
⚠️ 진한 배경 + 흰 글씨 금지(주황·노랑은 대비가 나빠 안 읽힌다) → 연한 배경 + 진한 글씨.
배포하기 달력은 칩 색에 더해 **날짜 옆 색 점**으로 그날 구성을 요약한다 — 칩이 넘쳐
`+N개` 가 돼도 "원본+주황+노랑" 이 보인다(실측: 6건인 칸에서 칩 4 + 점 5).

### 왜 날짜로 설계하면 안 되는가
학원엔 결석·숙제 미이행·보강이 있다. 예약을 날짜에 못 박으면 학생이 빠진 회차는
**그냥 안 푼 채로 지나간다**. 그래서 시스템이 추적하는 건 날짜가 아니라 **문제별 시도 횟수**다.

- **진행도**는 `get_student_wrong_answers.total_attempts` (n/5) — 화면 기본 필터가 "5회 미달".
- **선생님 신호**는 `get_teacher_wrong_answer_counts.under_target` (좌측 학생 목록).
- **빈 회차는 `kind='makeup'` 보충 배포**로 아무 날짜에나 메운다(예약 4건과 별개, 횟수 제한 없음).
- **밀린 예약은 날짜를 옮긴다** — 예약 현황의 date input, 또는 배포하기 달력에서 드래그.

⚠️ **`attempt_count` 를 진행도에 쓰지 말 것.** 그건 조회 기간(`p_from`/`p_to`) 안의 시도만 센다
— "최근 3개월" 로 보는 순간 실제 3/5 가 1/5 로 보인다(실측 확인). 진행도는 반드시
기간 무관인 **`total_attempts`**.

ℹ️ 예약 4건은 **모두 같은 문제 목록**을 담는다 → 한 회차를 걸러도 다음 배포에 그 문제가 또 나온다
(이월은 자동). 부족한 건 회차 수뿐이고, 그건 위의 진행도·보충으로 메운다.

### 학생 오답 숙제 — 회차를 학생이 직접 민다 (2026-08-28)

학생 대시보드 문제집 카드는 **"오답 숙제하기 (N회차)" 버튼 하나**다(옛 전체 다시 풀기 /
오답만 다시 풀기 / 오답 분석 3개를 대체). 월요일에 틀린 것을 그날 바로 숙제로 내보내려는 것 —
선생님이 예약을 안 걸어도 회차가 돈다.

- **회차 계산은 `planWrongHomework`(reviewSchedule.ts)** — `buildReviewTimeline` 과 **같은 파일**에
  둔다. 규칙을 학생 화면에 따로 두면 학생은 2회차를 푸는데 선생님 표는 3회차 칸이 차는 식으로
  갈라진다. N = **문제별 전체 시도 횟수 + 1**(최소 2).
- **시도 횟수는 배포로 거르지 말 것** — `studentAnswerApi.getProblemAttemptCounts` 는 그 학생의
  `student_answers` 를 통째로 센다. 선생님 쪽 `total_attempts`(034)가 그렇게 세기 때문이다.
  배포별로 세면 복습 예약 배포에서 푼 회차가 빠져 학생 화면만 2회차에 머무른다.
- **대상은 "지금도 틀린 문제" 가 아니라 "한 번이라도 틀린 문제"** — 위의 "정답 여부와 무관하게
  5회" 규칙 때문이다. 최근 시도 기준으로 거르면 3회차에 맞힌 문제가 4회차에서 사라져
  선생님 표의 4·5회차 칸이 영영 안 채워진다.
- **결과 화면(`SolveProblem`)의 "전체 다시 풀기" 는 없앴다.** 그 자리에서 또 제출하면 행이
  하나 더 쌓여 **회차가 그냥 넘어간다** — 2·3·4회차가 전부 같은 날짜로 채워져 "며칠에 걸쳐
  다시 푼다"는 설계가 무너진다. 다시 푸는 길은 대시보드 버튼 하나로 모은다.

#### 하루에 복습 한 회차만 — 카드 상태 4가지

`planWrongHomework` 는 `state` 를 돌려주고 카드는 그것만 보고 그린다:

| state | 화면 | 조건 |
|---|---|---|
| `due` | **오답 숙제하기 (N회차)** 버튼 + 회차 이름 | 오늘 풀 회차가 있다 |
| `resting` | **수고하셨습니다** (버튼 없음) | 오늘 이미 복습 회차를 끝냈다 |
| `completed` | 복습 5회 완료(비활성) | 오답을 전부 5회까지 채웠다 |
| `none` | 오답 없음 · 모두 맞혔어요(비활성) | 틀린 문제가 없다 |

- **`resting` 의 판정은 `count>=2 && lastAt 이 오늘`.** 제출 직후 버튼이 "(3회차)" 로 바뀌어
  한자리에서 2·3·4·5회차를 다 태우는 걸 막는다.
- ⚠️ **처음 풀기(count===1)는 이 제한에서 빼야 한다.** "오늘 푼 문제는 전부 제외" 로 두면
  월요일에 채점하자마자 버튼이 안 뜨고 다음 날까지 기다려야 한다 — **그날 바로 숙제로 내는
  것**이 이 기능의 출발점인데 그게 막힌다(테스트로 잡은 실제 회귀).
  같은 이유로 예정일(다음 수업·2주·4주)로도 막지 않는다.

#### ⚠️ 버튼을 감추는 것은 가드가 아니다 — 뒤로가기로 그대로 뚫린다

"하루 한 회차" 를 대시보드 렌더 조건(`state==='resting'` 이면 버튼 안 그림)으로만 걸었더니,
**제출 → "대시보드로" → 브라우저 뒤로가기 한 번**이면 `/student/problems/…?wrongOnly=…` 가 다시
열리고 화면이 새로 마운트돼(`answers={}`, `submitted=false`, ref 초기화) 또 제출할 수 있었다.
반복하면 하루에 5회차까지 다 태워 선생님 표의 네 칸이 전부 같은 날짜가 된다.
(적대적 검토에서 **3개 관점이 각각 독립적으로** 같은 구멍을 짚었다.)

→ **`SolveProblem` 자신이 `canAttemptToday`(reviewSchedule.ts)를 본다.** 진입 시 전 문항이
막혀 있으면 "수고하셨습니다" 화면으로 대체하고, `handleSubmit` 에서 한 번 더 막는다.
규칙은 `planWrongHomework` 와 **같은 함수**를 쓴다 — 두 군데 두면 갈라진다.
통계를 못 읽었으면 막지 않는다(학생이 숙제를 못 하는 게 더 나쁘다).

#### ⚠️ 예약이 이미 푼 칸을 노리면 stage 매핑을 버리고 날짜순으로

당일 오답 숙제를 허용하면서 칸2가 `done` 이 되자, `byStage.get(2)` 를 조회할 일이 없어져
선생님이 잡아 둔 **숙제 예약(stage=1)이 표에서 소리 없이 사라졌다**(실측). stage 를 붙들면
나머지도 한 칸씩 밀린 라벨로 들어간다 → **예약이 done 칸을 노리면 stage 를 통째로 버리고
날짜순으로 남은 칸을 채운다.** 5칸이라 '푼 회차 + 예약'이 5를 넘으면 늦은 예약은 넘치는데,
5회를 채우면 거기서 끝이므로 정상이다. 중요한 건 **임박한 예약이 먼저** 보이는 것.

#### 제출은 전 문항을 채워야 된다

- ⚠️ **옛 검사 `!answers[id]` 는 공백 한 칸(`" "`)을 그냥 통과시켰다** — truthy 라서.
  빈 답이 `student_answers` 에 박히면 그게 곧 오답 이력이 되고 **회차가 한 칸 넘어간다**.
  `isAnswered` 가 `trim()` 해서 본다.
- 제출 버튼 조건도 **현재 문제 하나**(`!answers[currentProblem.id]`)에서 **전 문항**
  (`allAnswered`)으로 바꿨다. 안 채운 문제가 있으면 배너로 번호를 알려주고 "이동" 으로 데려간다.

#### 회차를 행 수로 세면 중복 insert 가 곧 데이터 손상이다

`student_answers` 한 행 = 회차 한 칸이므로, 아래 셋을 같이 막아야 한다:

- **부분 실패 후 재제출** — `Promise.all` 은 하나만 실패해도 성공분을 잃는다. `allSettled` +
  성공한 문제를 `recordedRef` 에 남겨 재제출 때 건너뛴다. 건너뛰는 문제는 답을 **고칠 수도 없게**
  막는다(고쳐도 반영이 안 되는데 되는 것처럼 보이면 조용히 답이 버려진다).
- **이중 제출** — `loading` 은 다른 effect(auth 갱신 등)가 되돌릴 수 있어 못 믿는다 → `submittingRef`.
- ⚠️ **`attempt_number: attemptCounts[id] + 1` 의 NaN** — 키가 없으면 `undefined+1=NaN` →
  JSON 에서 `null` → `attempt_number INTEGER NOT NULL`(baseline) 위반(23502)으로 **제출이 전건
  실패**하고 재시도해도 계속 실패한다. `?? 0` 필수. 그 값을 채우는 effect 는 deps 에 `problems` 가
  있어 **두 번 발사**되므로(빈 배열일 때 1차) **취소 플래그**로 늦은 응답이 덮어쓰는 걸 막는다.
- **로딩 중 화면** — 데이터가 오기 전엔 진행률이 0 이라 **다 푼 문제집도 "문제 풀기"** 로 보인다.
  누르면 세트 전체가 열려 모든 문제의 회차가 한 칸씩 뛴다 → `cardsReady` 전에는 버튼을 안 낸다.

### ⚠️ 회차 번호 체계가 둘이다 — 잇는 자리에서 +1 (2026-08-28)

```
예약 distributions.review_stage (032 주석) : 1 숙제 / 2 다음수업 / 3 2주 / 4 4주
오답 표의 회차 STAGE_LABELS             : 1 첫오답 / 2 숙제 / 3 다음수업 / 4 2주 / 5 4주
```

첫 오답이 한 칸을 먹으므로 **표의 회차 = 예약 stage + 1**. `buildReviewTimeline` 이 변환 없이
stage 를 그대로 키로 쓰고 있었다. 실측(월 첫오답 + 4단계 예약): 숙제 예약(9/1)은 1회차 칸을
노렸다가 **이미 푼 날에 막혀 통째로 버려지고**, 2회차 '숙제' 칸엔 다음수업 예약(9/2)이
들어갔다 — **4칸 전부 어긋남**. 학생이 실제로 푼 날(`done`)은 위치 기반이라 멀쩡해서, 예약을
건 학생에서만 날짜가 이상해 보인다.

### 다음 수업일 = 월수금 / 화목토 격일 (일요일 수업 없음)
월→수, 화→목, 수→금, 목→토, **금→월, 토→화**(금·토만 +3일). 계산은
`shared/lib/reviewSchedule.ts` — **DB 가 아니라 프론트**에 둔다. 학원 운영 규칙이라 바뀔 수 있고
예약 모달이 날짜를 미리 보여줘야 한다. RPC 는 받은 날짜대로 만들기만 하므로 규칙이 바뀌어도
마이그레이션이 필요 없다.

### 달력 드래그(배포하기)
칩 `draggable` + 셀 `onDrop`(HTML5 DnD, 라이브러리 없음). **셀은 `<button>` 이 아니라 `<div>`** —
버튼 안에 draggable 요소가 있으면 드래그와 클릭이 충돌한다. 월 경계는 두 갈래:
앞뒤 빈 칸을 **이웃 달 날짜로 채우고**(8월 격자에 7/26~31·9/1~5), 월 네비 버튼 위에
드래그한 채 0.6초 머무르면 자동 전환.

## 인쇄 / 문자 발송 규약 (2026-08-27, 선생님 대시보드 개편)

### A4 시험지는 브라우저 인쇄로 만든다 (백엔드 PDF 생성 안 함)

`/teacher/print/wrong-answers?student=…&problems=<id,id,…>` 인쇄 전용 라우트 +
`apps/teacher/src/print.css`. 백엔드 PyMuPDF 로 PDF 를 짜지 않는 이유: 한글 폰트 임베딩과
크롭 재조판 부담이 큰데, 브라우저 "PDF로 저장"으로 같은 결과가 나온다.

- **상태가 아니라 URL 로 넘긴다** — 새로고침·재인쇄가 그대로 재현된다(40문제 상한).
- **`window.print()` 전에 이미지 로드를 기다린다.** 안 기다리면 문제 이미지가 **빈 칸으로**
  인쇄된다(`img.complete` 전부 대기 후 print).
- 화면 조작 바에는 `.no-print` 를 붙인다.

### ⚠️ 페이지 나눔은 **쪽당 문항 수 고정 격자**로 (2026-08-28, 측정 방식 폐기)

**CSS 다단(`column-count`)은 쓰지 않는다** — 페이지 경계에서 브라우저마다 다르게 흘러
미리보기와 인쇄가 어긋난다. 그런데 **JS 로 높이를 재서 채우는 방식도 폐기**했다(하루 만에):
쪽마다 문항 수가 달라지고 **번호가 세로로 흘러**(왼쪽 단을 다 채우고 오른쪽으로) `01 02` 아래에
`04 05` 가 왔다. 선생님이 원한 건 `1 2 / 3 4 / 5 6` 가로 우선 + **한 쪽에 딱 2·4·6문제**다.

**지금 방식은 CSS Grid 한 줄이다**(`print.css` `.page-body`):

```css
grid-template-columns: repeat(2, 1fr);
grid-template-rows: repeat(var(--rows), 1fr);   /* 프리셋: 3 / 2 / 1 */
```

- **가로 우선은 grid 기본 흐름(row)이 그냥 준다** — 순서 코드가 필요 없다.
- **첫 쪽 머리글도 `1fr` 이 알아서 흡수**한다(첫 쪽 칸만 조금 낮아짐). 머리글 높이를 재거나
  mm 로 못 박을 필요가 없다 → `measure-pane`·`headerRef`·mm→px probe·그리디 배치 **전부 삭제**.
- 페이지 나눔은 `chunk(problems, perPage)` 한 줄, 번호는 `pi * perPage + ci + 1`.
- 프리셋(`PRESETS`): 좁게 3행=6문제 / 적당히 2행=4문제 / 넓게 1행=2문제(모의고사형).

**⚠️ 이미지는 줄이되 절대 자르지 않는다** — 잘린 문제는 못 쓴다(크롭의 "내용 손실 0건" 과 같은 원칙).
`object-fit: contain` + `max-height:100%` 로 비율을 지키며 축소한다.

**⚠️ 풀이 공간은 비율이 아니라 `--work-min`(최소값)으로 잡는다.** 처음엔 칸을
`62fr : 38fr`(문제:풀이)로 나눴는데, **칸 아래에 빈자리가 남는데도 이미지가 상한에 걸려 줄었다**
(실측: 좁게에서 59mm 문제가 50mm 로, 17개 중 17개가 축소). 최소값 방식으로 바꾸니
같은 조건에서 **17개 중 3개만** 축소되고 최소 풀이 공간 16mm 는 그대로 확보된다.
구현은 `.print-item { grid-template-rows: auto 1fr; padding-bottom: var(--work-min) }`.

`@page { margin: 0 }` 로 두고 **지면 여백은 `.sheet-page` 의 padding** 이 담당한다.
그래야 화면(고정 210×297mm)과 인쇄가 1:1 이 된다.

- **`box-sizing: border-box` 를 print.css 에 명시**한다. 기본값(`content-box`)이면 padding 이
  210mm **밖에** 더해져 지면이 234×321mm 로 커진다. 앱에서는 Tailwind preflight 가 깔아주지만
  **거기에 기대면 안 된다** — 실측으로 잡은 실제 버그다(정적 미리보기에서 재현).
- **배경으로 선을 그리지 말 것** — 인쇄 설정의 "배경 그래픽" 이 꺼져 있으면 사라진다.
  두 열 사이 구분선은 실제 요소의 `border-left`(`.page-divider`). 번호 색·단원 배지처럼
  꼭 나와야 하는 색은 `.sheet-page` 에 `print-color-adjust: exact` 로 강제한다.
- 조판 값(여백·행 간격·최소 풀이 공간)은 **CSS 변수로 주입**해 미리보기와 인쇄가 같이 움직이게 한다.
  단위는 px 가 아니라 **mm** — A4 인쇄물이라 종이 위 실제 길이와 1:1 로 맞는다.
- 단원이 `미분류`·`미정`·`기타`·빈 값이면 **배지를 안 단다**(`unitBadge()`) — 정보가 없는 배지는 소음.
- 여백·프리셋은 `localStorage`(`print_sheet_prefs`)에 남긴다 — 인쇄 창은 매번 새로 열린다.

**검증 방법**(이 작업에서 통한 것): `print.css` 를 그대로 인라인한 **정적 HTML** 을 프리셋별로
찍어 `apps/teacher/public/` 에 두고, **vite 가 이미 서빙 중인 8082** 로 열어 브라우저에서 실측한다.
`file://` 로 열면 브라우저 패널이 **정적 스냅샷**이라 JS 가 안 돌아 측정이 안 된다.
확인 항목: 장 크기 210×297mm / 쪽당 문항 수 / 넘침 0 / **이미지 잘림 0**(렌더 종횡비 ==
`naturalWidth/naturalHeight`) / 첫 쪽 문항 좌표가 같은 행인지(가로 우선). 끝나면 임시 파일 삭제.

### 로그인 뒤에 있는 화면을 **로그인 없이** 브라우저로 실측하는 법 (2026-08-28)

`/teacher/*` 는 `RequireTeacher` 뒤에 있어 에이전트가 브라우저로 못 연다(사용자 계정으로
로그인하는 건 금지). 그렇다고 "빌드 통과" 를 "화면 정상" 으로 읽으면 안 된다 —
TDZ·purge·이벤트는 실행해야 나온다. **컴포넌트만 떼어 하네스로 띄운다**:

1. esbuild 로 **실제 컴포넌트 파일을 그대로 import** 하는 진입점을 번들
   (`alias: { '@': src, '@shared': shared }`, `jsx:'automatic'`, `format:'iife'`).
   ⚠️ **사본을 만들어 테스트하면 안 된다** — 전례: 단위테스트가 문제의 그 줄을 지역 const 로
   바꿔 놓아 `export { X } from …` 재수출 버그(화면 백지)를 못 잡았다.
2. `npm run build` 산출 CSS(`dist/assets/index-*.css`)를 `public/` 으로 복사해 링크한다.
   → **Tailwind purge 검증이 공짜로 딸려온다**(달력 셀이 36px 이면 `w-9` 가 살아 있는 것).
3. **이미 떠 있는 vite(8082)** 로 연다. `public/` 은 디스크에서 바로 서빙되므로 서버 재기동 불필요.
4. 끝나면 임시 파일 전부 삭제(`public/` 에 남기지 말 것).

**함정 셋(전부 이번에 실제로 밟음)**:
- **`file://` 로 열면 안 된다** — 브라우저 패널이 *정적 스냅샷*으로 렌더해 **JS 가 안 돈다**
  (`javascript_tool` 이 "No site is open" 을 뱉는다). 반드시 http 로 서빙.
- **`.click()` 직후 같은 호출에서 DOM 을 읽으면 리렌더 전이라 안 보인다** → `await sleep(150)`.
  더 헷갈리는 건, 다음 호출에서 **토글 버튼을 또 누르면 닫힌다** — "안 열린다" 로 두 번 오진했다.
- **shadcn 래퍼는 라이브러리 기본 클래스를 *교체*한다** — `@shared/ui/calendar` 는
  `classNames` 를 통째로 덮어써서 `.rdp-day`·`.rdp-head_cell` 로는 못 찾는다.
  `button[name="day"]`·`th` 같은 **구조 선택자**로 잡을 것.

### 문자는 키가 없으면 "모의발송"으로 떨어진다 (실패가 아니다)

`handlers/sms_sender.py` — 솔라피 SDK 대신 `httpx` 직접 호출(이미 requirements 에 있어
신규 의존성 0, 인증은 HMAC-SHA256 헤더 한 줄). `SOLAPI_API_KEY/SECRET/SENDER_PHONE` 중
하나라도 비면 `is_configured()=False` → 전건 `status='mock'` 으로 `message_logs` 에만 남는다.
화면은 "모의 발송 모드" 배너를 띄운다. **키를 채우면 코드 변경 없이 실발송으로 바뀐다.**

- **클라이언트는 전화번호를 절대 보내지 않는다** — `student_ids` + `template` 만 보내고
  서버가 번호를 조회·치환한다. RLS 가 비활성이라 `routers/messages.py` 의
  **소유권 검증(`profiles.teacher_id == 요청자`)이 유일한 방어선**이다. 빠뜨리면 남의 학생
  학부모에게 문자가 나간다.
- 로그는 **성공·실패·모의·번호없음(skipped) 전부** 남긴다 — "보냈는데 안 왔다"의 유일한 근거.
- `message_logs` insert 가 실패해도 500 을 던지지 않는다(발송은 이미 나갔는데 화면이 실패로
  보이면 선생님이 다시 눌러 **중복 발송**된다).

### ⚠️ 배포 노출은 **날짜 단위** — 시각으로 가리지 말 것 (2026-08-28)

학생 과제는 "그 날짜의 것" 이지 "그 시각부터" 가 아니다. 그런데 두 군데가 **시각**으로 가리고 있었다:

```
getStudentDistributions(hideScheduled)  .lte('distribution_date', now())
getDistributionById 학생 가드           distribution_date > Date.now() → 차단
```

여기에 **저장값까지 9시간 밀려 있어**(아래) 실측으로 이런 일이 났다 —
`2026-08-28T00:00:00+00:00`(= KST 8/28 **09:00**)로 저장된 배포가 KST 08:46 에
학생 화면에서 "배포된 문제집 0개". 선생님 달력은 이 조건을 안 걸어 정상으로 보여
"달력엔 있는데 학생한텐 없다" 가 된다.

→ 경계를 **내일 로컬 자정**(`endOfTodayIso`, api.ts)으로 둔다. 오늘 날짜면 시각과 무관하게
전부 보이고, **미래 '날짜' 예약은 그대로 가려진다**(복습 예약이 그날 되어야 뜨는 규칙 유지).
선생님 쪽 `getScheduledReviews`·`cancelReview` 도 **같은 경계**를 쓴다 — 기준이 어긋나면
"학생은 보이는데 선생님 화면엔 아직 예약" 이 된다.

### ⚠️ timestamptz 에 오프셋 없는 문자열을 보내면 UTC 로 박힌다 (2026-08-28)

`` `${date}T00:00:00` `` 을 그대로 insert 하면 Postgres 가 **서버 시간대(UTC)** 로 읽어
`00:00Z` = **KST 오전 9시**가 된다. `distributions.distribution_date` 가 딱 이랬다.

- 프론트: `new Date(`${date}T00:00:00`).toISOString()` — JS 는 오프셋 없는 **날짜+시각**을
  로컬로 읽으므로 "KST 그날 자정" 이 정확히 저장된다.
  (⚠️ **날짜만** 있는 `new Date('2026-08-28')` 은 반대로 **UTC 자정**이다. 그건 `parseDate` 를 쓴다.)
- SQL: `(...)::timestamptz` 는 DB 시간대로 읽는다 → `(...)::timestamp AT TIME ZONE 'Asia/Seoul'`
  (마이그레이션 **037**, `create_review_distributions` + `auto_create_reviews_for_distribution`).
- ⚠️ **코드를 고쳐도 이미 저장된 행은 안 고쳐진다.** 함수만 바꾸고 끝내면 그전에 만들어진
  미래 배포가 계속 9시간 늦게 뜬다(실측: 복습 3건이 KST 오후 6시로 남아 있었다). 보정은
  `date_trunc('day', col AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul'` — KST 기준
  **날짜는 안 바뀌므로** 달력에서 과제가 다른 날로 튀지 않는다. 지난 배포는 건드리지 말 것.
- 화면(`endOfTodayIso`)은 날짜 단위로 봐서 넘어가지만 **SQL RPC 8곳은 아직 `distribution_date
  <= now()`** 라 시각에 걸린다 → 데이터 자체를 맞추는 게 맞다(읽는 쪽마다 보정하지 말 것).
- 같은 부류로 **날짜 버킷 비교에 `toISOString()` 금지** — 그건 UTC 라 KST 오전 배포가 전날로
  밀린다. 실측: 달력에서 8/28 을 골랐는데 27일 컨텐츠가 뜨고 28일 것은 빠졌다.
  로컬 기준 `toDateStr`(reviewSchedule.ts)을 쓴다. 학생 대시보드·`StudentAnalysis` 둘 다 그랬다.

## 의사결정 규칙

- **근본 해결 우선** — 휴리스틱 땜질 지양. 구조/모델/아키텍처 교체를 중심축으로 두고, 시간/비용 클 때만 단기 완화책 병기
- **UX 결정은 확인받기** — 디렉토리 구조, 폴더명, 파일 경로, UI 텍스트 등 사용자 눈에 보이는 것은 임의 결정 금지. 함수명/정규식/알고리즘은 알아서 판단
- 제안 시 옵션 나열보다 **추천안 + 이유** 명확히 제시

## 서버 규칙

- 서버(`wanted-1@wanted-1`)에서 **Claude Code 사용 금지** — 공용 서버라 다른 유저 코드 파일 건드릴 위험
- 로컬에서만 코드 수정 → commit → push. 서버는 `git pull` + 런타임 명령만
- 예외: `ollama pull`, `pip install`, `uvicorn` 기동 등 런타임 명령은 서버 셸에서 직접 가능

## 로컬 → 서버 Ollama 임베딩 사용 (2026-06-19 갱신)

VL 은 OpenAI 단일이라 더 이상 ollama 터널이 필요 없다. **임베딩(bge-m3)만** 로컬 GPU 대신 서버 GPU 를 쓰고 싶을 때 아래 터널을 건다.

**준비물**
- 서버 ollama 는 `127.0.0.1:11434` 만 바인딩 (`ollama` 유저 소유 프로세스라 건드리지 말 것)
- Tailscale 로 로컬 ↔ 서버 연결 (`100.95.34.69`)
- 로컬 PC 에도 ollama 가 돌고 있어 11434 포트 충돌 — 우회 포트 `21434` 사용

**1. SSH 포트포워딩 (로컬 PowerShell 새 창, 닫으면 터널 끊김)**
```
ssh -N -L 21434:localhost:11434 wanted-server
```
비번 입력 후 멈춘 듯 가만히 있으면 성공. `curl http://localhost:21434/api/tags` 로 모델 목록 뜨면 OK.

**2. `backend/pdf_pipeline/.env` 패치 (임베딩만)**
```
OLLAMA_URL=http://localhost:21434
EMBED_MODEL=bge-m3
```

**3. VL 은 OpenAI 키만 있으면 됨**
```
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-4o
```

## 알려진 이슈 및 해결책

### Ollama embedder 500 에러 (2026-04-21 해결)
- 증상: `Ollama 접속 실패 → OpenAI fallback (batch): 500 Server Error for url: .../api/embeddings`
- 원인 1: 신버전 ollama 는 `/api/embeddings` (구) 가 긴 한글 텍스트에서 500 — `/api/embed` (신) 사용해야 함
- 원인 2: 파이프라인이 한 번에 수백 개 텍스트 배치 → 서버 OOM
- 해결: `pipeline/embedder.py` 에서 `/api/embed` + 32개 청크 분할

### solution_jobs status 박제 (재발 가능)
- 증상: 태깅 실패/중단 후 `upload-and-tag` 가 400 `태깅 가능 상태 아님: tagging` 반환
- 원인: 실패 경로에서 `status='error'` 복구 업데이트 없음 + uvicorn 메모리 dict 에 상태 남음
- 해결:
  1. Supabase MCP `execute_sql` 로 `UPDATE solution_jobs SET status='reviewing' WHERE id='...'`
  2. `taskkill /F /IM python.exe` (Ctrl+C 안 먹을 때) — **주의: 모든 python 프로세스 죽음**
  3. uvicorn 재기동 (메모리 초기화 필수 — `--reload` 만으론 `solution_jobs` dict 안 비워지는 경우 있음)
  4. 재기동 직후 status 가 `reviewing` 인지 확인 후 샘플 태깅 재시도

### uvicorn 종료 안 됨 (백그라운드 태스크 대기)
- 증상: Ctrl+C 여러 번 눌러도 `Waiting for background tasks to complete. (CTRL+C to force quit)` 에서 멈춤
- 원인: OpenAI fallback 호출 등 긴 요청 대기 중
- 해결: 새 PowerShell 창에서 `taskkill /F /IM python.exe`

## 로컬 실행 환경 (자주 묻는 것)

> ⚠️ **프로젝트 절대경로 (2026-08-26 이전)**: 현재 위치는
> `C:\Users\fpsem\Desktop\math-agent-main\math-agent-main`. 옛 경로
> `C:\Users\user\workspaces\math` 는 더 이상 없다. 문서·커맨드 예시에 옛 경로가 남아 있으면
> 새 경로로 바꿔 읽을 것(`.claude/commands/server-check.md`·`tutor-smoke.md`, 아래 scp 예시 등).
> `.claude/settings.json` 훅 4개와 `check_path_hook.py`·`tutor_import_hook.py` 는 이전 시 정정 완료.
> **훅이 옛 경로를 가리키면 python 이 exit 2 → Edit/Write 도구가 통째로 차단된다**(증상: 모든 파일
> 수정이 `can't open file ... check_path_hook.py` 로 실패). 그땐 Edit 이 막혀 있으니 **Bash 로** 고쳐야 한다.

터미널 2개로 나눠 실행. 혼동 금지.

### ⚠️ venv 신규 생성 시 — pip 이 중간에 끊겨도 "성공"처럼 보인다 (2026-08-26)

**증상**: 새 PC/새 경로에 venv 를 만들고 `pip install -r requirements.txt` 를 돌렸는데, 화면상 에러가
스쳐 지나가고 `uvicorn` 이 안 뜬다. `import torch` 같은 건 되는데 `fastapi` 는 없다.

**원인**: Windows **260자 경로 제한(WinError 206)**. `torch` 의 라이선스 디렉토리가
`...\site-packages\torch-*.dist-info\licenses\third_party\kineto\libkineto\third_party\dynolog\...`
처럼 깊어 260자를 넘기면 압축 해제가 실패하고 **pip 트랜잭션이 그 지점에서 통째로 중단**된다.
그러면 설치 순서상 **torch 뒤에 오는 패키지가 전부 누락**된다 — fastapi·supabase·openai·ultralytics
가 여기 해당해서 `main.py:13 from fastapi import ...` 에서 즉사한다.
(이 프로젝트의 site-packages 경로는 이미 98자라 여유가 없다. `LongPathsEnabled` 은 0.)

**대응**:
1. pip 종료코드를 반드시 확인한다. `pip ... ; echo $?` 처럼 **다른 명령을 뒤에 붙이면 그 명령의
   종료코드가 덮어써서 0 으로 보인다** — 실제로 이 함정에 한 번 걸렸다. `code=$?` 로 먼저 받을 것.
2. torch 는 한 번 들어가면 `pip list` 에 등록되므로, **재실행하면 건너뛰고 나머지만** 설치된다.
   즉 같은 명령을 한 번 더 돌리는 것만으로 복구된다.
3. **완주 검증은 `python -c "import main"`** 으로. 예외 없이 끝나야 기동 가능한 상태다.
4. 근본 해결은 Windows 장문 경로 활성화(관리자 권한 레지스트리 `LongPathsEnabled=1`) 또는
   프로젝트를 짧은 경로로 옮기기.

**`requirements.txt` 는 불완전하다**: `ultralytics`·`openai`·`requests` 가 빠져 있는데 셋 다
**모듈 레벨 import** 다(`pipeline/yolo_detector.py:16`, `handlers/stuck_helper.py:30`).
그 파일만 믿고 설치하면 기동이 안 되니 **설치 명령에 직접 붙여야 한다**:
`pip install -r requirements.txt ultralytics openai`

**백엔드 (Python, venv 필요)**
```
cd backend/pdf_pipeline
venv\Scripts\activate        # (venv) 프롬프트 확인
uvicorn main:app --reload --port 8001
```
- `(venv)` 프리픽스 없으면 전역 Python 으로 돌아 Pillow/ultralytics 꼬임
- `Uvicorn running on http://127.0.0.1:8001` + `Started reloader process` 두 줄 뜨면 정상 기동

**CMS (Node.js, venv 무관)**
```
cd apps/cms
npm run dev                  # http://localhost:8081
```
- Node 앱이므로 venv activate 불필요. 브라우저 접속도 venv 와 무관
- teacher=8082, student=8083 동일 원칙

### ⚠️ 에이전트(Claude)가 서버 띄울 때 — 백그라운드 금지, 독립 창으로 (2026-06-21)

**서버(uvicorn·vite)를 Bash `run_in_background` 로 띄우지 말 것.** 백그라운드 셸은 에이전트
턴이 끝나거나 다음 명령을 시작할 때 harness 가 정리하며 **서버까지 같이 종료**시킨다 → 작업할
때마다 서버가 죽어 "중지됨" 이 반복된다(2026-06-21 다회 발생). 에이전트가 죽인 게 아니라 실행
방식 문제.

**반드시 `Start-Process` 로 세션과 분리된 독립 창에 띄운다:**
```powershell
Start-Process cmd -ArgumentList '/k','cd /d C:\Users\user\workspaces\math\apps\cms && npm run dev' -WindowStyle Minimized
Start-Process cmd -ArgumentList '/k','cd /d C:\Users\user\workspaces\math\backend\pdf_pipeline && call venv\Scripts\activate.bat && uvicorn main:app --reload --port 8001' -WindowStyle Minimized
```
- 이러면 에이전트가 다른 명령을 돌려도 안 죽는다. 작업표시줄 최소화 cmd 창 = 서버.
- 끄려면 그 창을 닫는다. **`taskkill`·`Stop-Process` 등 강제 종료 금지**(사용자 명시 요청).
- 기동 확인은 `netstat` 리스닝 + `Invoke-WebRequest` HTTP 200 으로.

### ⚠️ 에이전트(Claude) 도구 호출 형식 — `antml:` 접두어 필수 (2026-06-21)

**도구 호출 태그는 반드시 `antml:invoke`/`antml:parameter` 정식 형식으로 써야 한다.**
접두어 없이 `<invoke ...>` 로 쓰면 harness 가 파싱 못 해 `malformed and could not be
parsed` 에러가 나고 그 턴이 멈춘다("또 멈췄다" 의 진짜 원인). 서버·환경 문제가 아니라 순전히
출력 형식 실수다(2026-06-21 다회 발생).

재발 방지: 도구를 부를 때 한 호출씩, 접두어를 눈으로 확인하고 보낸다. 여러 도구를 빠르게
연속으로 칠 때 접두어를 빠뜨리기 쉬우니 속도를 줄인다.

### ⚠️ 에이전트: 백슬래시 든 내용은 heredoc·`python -c` 로 쓰지 말 것 (2026-08-27)

LaTeX(`\frac`)·정규식·Windows 경로처럼 **백슬래시가 든 파일**을 셸 heredoc 이나
`python -c` 로 쓰면 **조용히 다른 문자가 박힌다**. 실측 사고 둘:

| 쓰려던 것 | 실제로 박힌 것 |
|---|---|
| 주석 안의 `\frac` | **폼피드 문자(0x0C)** — 화면엔 안 보인다 |
| 정규식 `\\(` (백슬래시 2개) | `\(` (1개) — 컴파일은 되는데 매칭이 달라진다 |

둘 다 **컴파일도 되고 눈으로도 안 보여**, 한참 뒤 "정규식이 왜 안 맞지" 로 드러난다.

⚠️ **따옴표 heredoc(`<<'EOF'`)도 못 막는다.** 이 규칙을 쓰는 도중에 그대로 재현됐다 —
따옴표를 씌웠는데도 위 표의 `\\(` 가 `\(` 로 줄어 파일에 들어갔고, 셸이 만든 임시 파일부터
이미 그랬다. 즉 **셸이 아니라 명령 문자열이 전달되는 단계**에서 뭉개진다. 따옴표·이스케이프로
우회하려 들지 말 것.

- → **Write/Edit 도구로 쓴다.** 이 도구들은 문자열을 그대로 넣는다(위 표를 고친 것도 Edit).
- 셸을 꼭 써야 하면 ① 백슬래시는 `chr(92)` 로 조립하고, ② 쓴 뒤 **반드시 검증**한다:
  `grep -c $'\f' <파일>` 이 0 인지, 백슬래시 개수가 맞는지(연속 개수를 세는 게 확실하다 —
  `sed`/`repr` 출력은 이스케이프가 겹쳐 보여 오히려 헷갈린다).

### ⚠️ 에이전트: FastAPI 엔드포인트를 파이썬에서 직접 부르지 말 것 (2026-08-27)

`await upload_answer_key(...)` 처럼 함수를 그냥 부르면 **`Form(...)`·`File(...)` 기본값이
안 풀린다**. 실측: `force: bool = Form(False)`(main.py) 가 `FormInfo` **객체**로 들어왔고,
객체는 truthy 라 "이미 읽은 PDF 는 되묻는다" 가드가 **반대로** 동작했다(중복 읽기 = 돈).

→ 엔드포인트 검증은 **`fastapi.testclient.TestClient`** 로. 실제 HTTP 경로를 타야 의존성
주입·기본값·인증이 정상 해석된다. (★체크리스트 2번 "코드 결백은 직접 import, 화면 재현은
HTTP 경로" 와 같은 부류 — 층을 섞으면 엉뚱한 결론이 난다.)

## 비용 절감 규칙

- 파일 탐색/검색 → Explore subagent 위임
- 단순 CRUD, 컴포넌트 작성에 Opus 사용 금지 (Sonnet으로 충분)
- 대규모 탐색 완료 후 구현 시작 전 `/compact` 실행
- `--no-verify` 사용 금지 (hook으로 차단됨)

## 해설지 파이프라인 — 재발 방지 체크리스트

(2026-04-19 다회 발생한 버그들 → 해결 완료. 자세한 원인/해결은 git log + 커밋 메시지)

- **uvicorn 재시작 전 좀비 확인** → **`/server-check`** 권장. `netstat` PID 만으론 부족(죽은 소켓 캐시) — 살아있는 프로세스는 `Get-CimInstance Win32_Process` 로 확인. 옛 서버가 포트 점유 중이면 새 서버가 조용히 바인딩 실패한다(19차, 위 ★체크리스트).
- **dict 키 타입 불일치**: page_bboxes 같은 key 일치 필수. `dict.get(int) or dict.get(str(int))` 패턴
- **PIL ↔ numpy 변환**: `_trim_whitespace` 같은 cv2/numpy 기대 함수에 PIL Image 직접 전달 금지
- **React useCallback stale closure**: state 의존하는 콜백은 `useRef` 동기화 패턴
- **stage 복구 분기**: 빈 결과여도 stage 업데이트는 early return 전에 호출

(백엔드 포트 8001 / CORS 정책은 루트 README + ARCHITECTURE 참조 — 한 곳에서만 관리)

## ★ "또 화면 실패/헛수고" 방지 체크리스트 (2026-06-24, 19차 — 8~18차 11번 헛수고의 결론)

> **이 체크리스트가 dev-rules 에 산문으로만 있었던 "옛 서버 의심"·"좀비 확인" 규칙을 대체한다 —
> 산문 규칙은 11번 안 지켜졌다(증명됨). 화면 문제 신고 시 코드부터 의심하지 말고 이 순서로.**

**0. 한 방에: `/server-check`** — 아래 1~4 를 자동 수행(옛 서버 진단·정리·재기동·HTTP 검증).

**0-a. 에러 문구로 먼저 층을 가른다 (2026-08-26 추가 — 30초짜리 판별)**
브라우저 토스트/콘솔에 뜬 문구가 **영문 `Failed to fetch`(TypeError)** 인가, **한국어 문장**인가?
- **영문 `Failed to fetch` = 응답을 아예 못 받았다** → 서버 미기동 / 포트 / CORS preflight 차단.
  **Supabase·인증·쿼리는 용의선상에서 빼라** — 거기까지 도달조차 못 한 것이다.
  (`shared/lib/api.ts` 의 `if (!resp.ok)` 는 **응답이 온 경우에만** 한국어 detail 로 바꾼다.
  그래서 영문 원문이 보였다는 것 자체가 "응답 없음"의 증거다.)
- **한국어 문장** = 응답은 왔고 백엔드가 준 detail 이다 → 인증(401)·권한(403, teacher role 강제)·
  데이터 문제. 이때부터 Supabase 를 의심하면 된다.
- 예외 하나: **미처리 500 에는 CORS 헤더가 안 붙어**(Starlette ServerErrorMiddleware 가
  CORSMiddleware 바깥) 브라우저가 차단 → **500 이 `Failed to fetch` 로 위장**될 수 있다.
  그래서 서버가 떠 있는데도 영문이 뜨면 브라우저 말고 **uvicorn 터미널의 500 스택**을 봐야 한다.

**0-b. "○○가 없습니다" 빈 상태를 데이터 부재로 믿지 말 것.**
`SolutionNodeEditorModal.load()` 의 catch 는 `setNodes` 를 건드리지 않아, 조회가 **실패해도**
초기값 `[]` 이 그대로 "노드가 없습니다"로 렌더된다. 실제로 DB 엔 노드가 멀쩡히 있는데
"백필이 안 됐나?" 로 오진하기 쉽다(2026-08-26 실제 발생). **빈 상태 + 에러 토스트가 같이 보이면
데이터가 아니라 통신을 의심**하고, DB 를 직접 조회해 실재 여부부터 확인하라.

**0-c. 화면이 아무것도 없이 하얗다 = 렌더 중 JS 예외다 (2026-08-27 추가).**
0-a·0-b 는 화면에 **뭔가 보이는** 경우를 가른다. 백지는 토스트도 빈 상태 문구도 없다 —
그건 서버·데이터가 아니라 **컴포넌트가 렌더 도중 죽은 것**이다. 브라우저 콘솔 첫 줄이면
끝난다(`ReferenceError: Cannot access 'x' before initialization` = TDZ, `undefined` 접근 등).
**이때 서버 재기동·캐시 삭제로 시간 쓰지 말 것** — 그 둘은 백지를 절대 안 고친다.
실제 사고와 예방책은 위 "화면이 통째로 백지면 코드 말고 '선언 순서'부터" 참조.

1. **옛 서버 포트 점유(핵심, 8~18차 화면 실패의 진짜 정체)**: 내가 "재기동"해도 옛 서버가 포트를
   안 놓으면 새 uvicorn/vite 가 **조용히 바인딩 실패** → 고친 코드가 화면에 반영 안 됨. **`netstat` PID
   는 죽은 소켓 캐시라 못 믿는다** → `Get-CimInstance Win32_Process -Filter "Name='python.exe'"` 로
   **살아있는 프로세스의 시작시각** 확인. 시작시각 < 코드수정시각이면 옛 서버. 정리: 부모+자식
   (`ParentProcessId`) `taskkill /F` → `Test-NetConnection <port>` **False** 확인 후 재기동 →
   **새 PID 시작시각 > 코드수정시각** 재확인. `--reload` 는 포트 충돌 시 조용히 죽으니 의존 금지.

2. **실측 방법론(코드 결백 vs 화면 재현 분리)**: 코드 결백은 **직접 import**(`generate_hint` 호출,
   `/tutor-smoke`)로, 화면 재현은 **실제 HTTP 경로**(JWT 발급 → `/api/tutor/hint`, `/server-check` 6번)로.
   **둘이 엇갈리면(직접 8초·정상인데 HTTP 90초·틀림) = 옛 서버가 범인**(19차 결정타). 반드시 **분산
   실측(5~10회)** — gpt-5.2 간헐성·꼬리 지연(어쩌다 90초)은 1회 측정으로 안 잡힘(16차).

3. **증상별 땜질 회피**: "느림/깨짐/이상" 신고를 한 증상씩 정규식·프롬프트로 막으면 다음 변형이 샘
   (8~18차: 디코딩루프→W→NBSP→MathJax→`\times`→`\,`… 11번). **환경(서버·캐시)부터 가리고 코드는
   마지막.** 근본(구조/위치/서버)을 먼저, 표면 증상 X. 모델 교체로 증상 덮지 말 것(품질 희생, 13차).

4. **캐시/번들 의심**: 화면만 깨지고 **백엔드 raw 는 정상**이면 localStorage 옛 대화 캐시
   (`tutor_chat_*`, `CHAT_CACHE_VERSION`) 또는 옛 번들. Ctrl+Shift+R + `purgeStaleTutorChatCache`
   (앱 진입 시 자동 정리). "퀄리티 저하" 신고도 캐시였던 전례(12~13차) — 코드 추가 수정 전에 캐시부터.

## 막힌 지점 도우미 — 풀이 그래프 위치추적 RAG 튜터 (2026-06-18 재설계)

**deeptutor 폐기.** LangGraph 다중턴 대화튜터(`backend/deeptutor/`)는 전부 삭제. 그 코드/프롬프트는 참고하지 않는다. 막힌 지점 도우미 기능은 `pdf_pipeline` 으로 이전·개선됨.

- **목적**: 학생이 풀다 막힌 "그 지점"을 풀이 노드 그래프 위에 위치추적하고 다음 한 노드만 끌어준다. 막힌 원인 4분류(독해/인출/전이/실행)를 한 흐름으로 흡수. 등록 대상은 수능/모의고사 2점·3점·쉬운 4점.
- **위치**: `backend/pdf_pipeline` FastAPI(포트 8001)에 통합. 별도 서버 없음.
  - 라우터 `routers/tutor.py` → `POST /api/tutor/hint` (`main.py` 에 `include_router(prefix="/api/tutor")`)
  - 핸들러 `handlers/stuck_helper.py` — 막힌 지점 찾기 → 유사 풀이 끌어오기 → 힌트 만들기 3단
  - 노드 추출 `pipeline/rag_node_extractor.py` — 해설 이미지 **1회 통합** VL 분해(전체 노드 배열 1회 structured output). 각 노드에 `uses`(이전 node_index 참조=전이 근거 DAG)+`whys`({question,reason}=논리 완결성) 포함. VL=OpenAI 단일. (`solution_tagger` 의 옛 단계별풀이 Call B 는 4차에서 통째 제거 — 이제 메타 Call A 한 번뿐. 풀이 그래프는 이 추출기만 담당.)
  - 노드 편집(교사) `routers/nodes.py` — CMS `SolutionNodeEditorModal` 용 CRUD(조회·수정·추가·삭제·재추출). 수정 시 `compose_embedding_text()` 재합성 + bge-m3 재임베딩, `uses` DAG acyclic 정제, `node_index` 순번 재매김. 인증 `get_teacher_id`(teacher role 강제).
  - **유형별 프롬프트 라우팅(2026-06-19)**: `_compose_extraction_prompt()` 가 베이스 프롬프트에 [과목 조각 또는 혼합형 패턴 조각] + (difficulty>=7 이면) 난이도 조각을 1개씩 덧붙인다. 거대 프롬프트도 과목별 서브에이전트도 아님 — `problem.unit`(첫 토큰=과목)·`difficulty_score` 가 이미 있어 분류 비용 0. 혼합형 판정은 1차 단순 규칙(difficulty>=8). unit 무매핑/패턴 없음이면 베이스만(graceful). few-shot 예시 주입은 검증 노드 표본이 쌓인 뒤(후속).
  - **answer leakage 방지**: `stuck_helper`가 whys.question만 소크라테스 질문으로 노출(reason은 배경 근거), conclusion 노드 최종 수식 제외, 힌트 보기기호/정답 패턴 경고. uses/whys 컬럼+RPC 는 baseline 에 포함. LaTeX 조합기호 `{}_nC_r` 프롬프트 강화 + `_fix_latex_subscript_escapes`(저장 직전 `\_`→`_`).
  - **RAG 배포 의존성 순서: 마이그레이션 → 코드 → 테스트.** RPC `RETURNS TABLE` 시그니처 변경은 `CREATE OR REPLACE` 불가 → `DROP FUNCTION ... CASCADE` 먼저. 코드 먼저 배포하면 RPC 시그니처 불일치로 런타임 500.
  - 인증 `auth.py` — `get_student_id`(Bearer JWT → profiles.id, student role 강제). `SUPABASE_ANON_KEY` 필요
  - 모델 `models.py` — `HintRequest`/`HintResponse`/`NodeReference`
- **DB**: `solution_nodes` 테이블(uses/whys 포함, baseline 에 반영) + RPC `search_solution_nodes_for_hint`. 임베딩 **bge-m3 1024차원**(problems.embedding 과 동일 — OpenAI 1536 혼입 금지).
- **VL**: `call_vl()` 통일(막힌 지점 찾기/힌트 만들기/노드추출 멀티모달). OpenAI 단일.
- **튜터 힌트 모델·타임아웃 정책 (2026-06-23)**: 힌트(`stuck_helper` _localize/_generate)는 **`OPENAI_MODEL`(gpt-5.2) 유지**(품질 우선, 사용자 결정). 추론 모델이라 느려서 다음으로 대응 — ① VL timeout **90초**(`_VL_TIMEOUT`), `_call_openai` 가 `with_options(timeout=)` 로 실제 적용. ② `_generate` 재시도는 **timeout 예외엔 즉시 실패**(2배 대기 방지), rate limit/5xx 만 1회 재시도. ③ 프론트 `ragHintApi.getHint` 는 AbortController **95초** timeout + 친화 에러. 단계별 시간은 `[TUTOR] ... total=Xs` 로그로 관찰.
- **튜터 gpt-5.2 안정화 (2026-06-23, 8차)**: gpt-5.2(추론 모델)는 **structured output(JSON 강제)에서 같은 문자 반복 디코딩 루프**에 빠져 출력이 깨짐(제어문자·` ` 무한반복→JSON 잘림). 해결:
  - **힌트 생성(_generate)은 structured output 폐기 → 자유 텍스트** `call_vl_text()`(vl_providers, `responses.create`, text_format 없음). 반환 텍스트를 `_fix_latex_subscript_escapes` 후처리 후 `_Hint(hint_text=…, next_step_concept=None)` 로 감쌈(호출부 호환). 자유 텍스트는 루프가 없어 한 방에 정상. `next_step_concept` 는 모델이 안 주므로 None(프론트 개념 배지 생략).
  - **reasoning effort**: 힌트 `low`(짧은 출력, thinking 최소), 위치추적 `_localize` `medium`(대조 추론 정확도). `call_vl(..., reasoning_effort=…)` → `responses.parse` 에 `reasoning={"effort":…}` 주입. `max_tokens=2000`(thinking+출력 합산 여유).
  - **verbosity 미사용**: Responses API 가 `text.verbosity` 로 받는데 `text_format` 과 병합이 까다로워 적용 안 함(프롬프트 "1~2문장" 으로 길이 제어). call_vl 의 verbosity 인자는 받아두되 무시.
  - **_localize 는 structured 유지**(index 정수 짧아 루프 안 깨짐) + CoT 프롬프트(reasoning 필드에 단계 결과식 대조 먼저).
  - 근거 노드 `_retrieve(limit=4)`(5→4 경량화). 7차 재생성 방어·끝 도달 종료 안내는 보조로 유지.
- **튜터 잔존 버그 2종 (2026-06-23, 9차)**: 8차 배포 후 학생 화면(평가원 6월 26년 1번, 5노드)에서 재현된 두 갭 수정.
  - **대문자 `W` 수식 깨짐**: gpt-5.2 가 `\(` 를 소문자 `\w(` 뿐 아니라 **대문자 `\W(`** 로도 깨뜨린다. 8차 보정 정규식 `_LATEX_BROKEN_DELIM`(`vl_providers.py`)이 소문자만 잡아 `\W(` 가 통과→raw 노출→화면에 'W' 만 남음. 정규식을 `r'\\w(?=[\(\[])'` → **`r'\\[wW](?=[\(\[])'`** 로 확대(백엔드 + 프론트 `StuckHelperModal.tsx` renderMath 일괄). lookahead 라 정상 텍스트·정상 명령(`\frac` 등 뒤에 괄호 없음)·영어 단어는 안 건드림. (백슬래시가 통째로 사라지는 변형은 이 정규식으로 못 잡으니, 재발 시 로그 `[latex] 깨진 구분자 복원` 으로 실제 출력 확인.) CMS(`SolutionNodeEditorModal`/`ProblemDetail`)는 노드가 DB 저장 전 백엔드 보정을 거쳐 정상이라 미수정(선택).
  - **멀티턴 마지막 직전 무응답(timeout)**: 끝 도달 가드(`stuck_helper.generate_hint`)가 `current_index >= last_idx`(이미 마지막)만 막아, **마지막 직전**(다음이 conclusion=정답)이면 VL 호출 → conclusion 근거는 output_formula(정답) 제외라 빈약 → gpt-5.2 가 "정답 금지+근거 없음" 모순에서 thinking 폭주 → 90초 timeout → 무응답. 가드를 **`current_index >= last_idx - 1`** 로 확대 → VL 호출 없이 종료 안내로 전환. `revealed_node_index >= 0` 체크 유지로 첫 호출(노드 1개 문제 포함) 보호. 종료 문구를 사용자 결정대로 **"거의 다 왔어요! 마지막 한 걸음만 남았는데, 정답은 직접 알려줄 수 없어요…"** 톤으로 교체(정답 직전이면 마무리). 부작용: 마지막 직전 힌트 1개 덜 주지만 정답 노출/timeout 회피 우선(사용자 명시). 검증: 5노드 문제 멀티턴이 turn별 next_idx 0→1→2→3 정상 힌트, revealed=3 도달 turn에서 종료 안내(ref=0, VL 호출 없음).
- **튜터 정답 인정 + 특수문자 깨짐 (2026-06-23, 10차)**: 9차 후에도 (1) 학생이 정답("1/a라 1/3이네요")을 말해도 인정 안 하고 같은 질문 반복, (2) 힌트에 `▲▲▲`·NBSP(` `) 등 특수문자 노출. 두 갭 수정.
  - **학생 정답 인정(옵션 B)**: 근본 원인 — 멀티턴에서 `_localize` 가 안 돌고(`revealed_node_index` 만 그대로 current_index 로 씀) 학생 발화 판정 로직이 전무. 해결: **매 턴 `_localize` 실행**(첫/멀티 구분 제거)해 학생 발화를 노드 결과식과 대조. `_Localized` 스키마에 **`reached_answer: bool`** 추가(마지막 노드 output_formula 를 프롬프트에 주고 "정답 도달했으면 true, 애매하면 false 보수적"). `generate_hint`: ① 퇴행 방지(localize 결과 < revealed & not reached → revealed 유지, 단 reached 면 정답 점프 허용), ② **정답 인정 경로**(reached_answer & revealed>=0 → VL `_generate` 없이 "정확해요! 잘 따라왔어요…" 마무리, ref=0, 정답 수치 직접 안 말함), ③ 9차 끝 가드 유지(reached 아닐 때). `_generate` 프롬프트에도 "학생 말이 이미 맞으면 또 묻지 말고 인정" 보조 지시. 비용: 멀티턴 매 턴 _localize +5~10s(medium), 정답 도달 턴은 _generate 스킵으로 상쇄. 검증: 평가원 6월 26년 1번 멀티턴에서 턴2 "3^(2/3)까지" → 위치 점프+인정, 턴3 "1/3이 답" → reached_answer 인정+마무리(ref=0).
  - **특수문자 강제 제거 + 프롬프트**: `_strip_control_chars`(vl_providers.py) 확장 — NBSP(`\xa0`)→일반 공백, 제로폭(`​-‏` 등)·방향제어(`‪-‮`,`⁦-⁩`)·BOM 제거, 화살표 `↑↓←→`(U+2190/2/1/3) **4개만** 제거(정상 수식은 `\rightarrow` LaTeX, ▲ 등 도형문자는 보존 — 과잉제거 방지). `_localize`/`_generate` 프롬프트에 "특수공백·화살표·제로폭 금지, 일반 ASCII·LaTeX 명령만" 명시. 프론트 renderMath 도 동일 정리(이중 안전, 캐시 옛 대화 방어). 한글·정상 LaTeX 무손상 단위테스트 통과. 재발 시 로그 `[latex] 제어/특수문자 제거·정규화` 로 실제 문자 확인 후 확대.
- **튜터 힌트 LaTeX 렌더 KaTeX→MathJax 전환 (2026-06-23, 11차)**: 9·10차 후에도 `\sqrt[3]{9}`(세제곱근)가 `✓[3]9` 로 raw 노출. **근본 원인**: gpt-5.2 가 자유텍스트 힌트에서 수식 구분자 `\(...\)` 를 **일관되게 안 붙임**(일부 평문·일부 raw LaTeX). student `StuckHelperModal.renderMath` 가 **KaTeX + 정규식 직접 파싱**이라 구분자 빠진 raw 수식을 못 잡아 `escapeHtml` 로 평문 노출 → `\sqrt`가 `✓`로 보임. 9·10차 정규식 땜질은 표면만 가림. **이중 방어로 근본 해결(사용자 "절대 안 나오게")**:
  - **프론트: KaTeX 정규식 → MathJax(`shared/ui/MathText`) 전환.** MathJax 는 구분자 빠진 raw 수식도 관대하게 렌더(CMS 가 이미 쓰던 컴포넌트). `apps/student/package.json` 에 `better-react-mathjax@^2.3.0` 추가, `App.tsx` 에 CMS 와 동일한 `MathJaxContext`(inline `\(\)`/block `\[\]`/ams) Provider 추가. `StuckHelperModal`: `renderMath`(KaTeX 정규식)·`katex` import 제거 → 경량 `sanitizeHintText`(NBSP/제로폭/화살표만, 캐시 옛 대화 방어) + `<MathText text={...} inline={false} />`. `MathText` 에 `inline` optional prop 추가(기본 true=인라인전용, 힌트는 `inline={false}`=블록허용). EditableMath(유일 기존 사용처)는 인자 안 줘서 무영향. **번들 859kB→606kB 감소**(KaTeX+CSS 제거, MathJax 런타임 로드).
  - **백엔드: `_generate` 프롬프트로 모든 수식 `\(...\)` 강제 + few-shot.** "평문 수식 절대 금지, 답변 뒤 모든 수식에 `\(...\)` 붙었는지 재확인" + 근호/분수/지수/첨자 좋은·나쁜 예. 검증: 평가원 6월 26년 1번 힌트가 `\(\sqrt[3]{9}\)`·`\(3^2\)`·`\((3^2)^{\frac{1}{3}}\)` 등 **모든 수식을 `\(...\)` 로 감쌈**(이전엔 raw 노출).
  - **유지**: 백엔드 `_fix_latex_subscript_escapes` 전체(MathJax 도 `\W(` 는 못 읽고 NBSP 는 공백처리 안 함 — 이중 안전). 프론트 `sanitizeHintText`(특수문자만). **제거**: 프론트 KaTeX 정규식 파싱(`renderMath`).
  - ⚠️ **11차는 잘못된 가정에 기반 — 12차에서 롤백됨(아래 참조).** "MathJax 가 구분자 빠진 raw 도 관대하게 렌더"가 **틀렸다**(실측 반증). 이 항목의 전제·"재발 방지 원칙(MathJax 통일)"은 무효.
- **튜터 힌트 LaTeX — 11차 MathJax 롤백 + 제어문자 차단 (2026-06-23, 12차)**: 11차 MathJax 전환 후 학생 화면이 `▮!19¶` 무한반복·`▲ile000` 로 **완전히 깨짐**. **Preview MCP 로 실제 브라우저 진단(추측 아님, 실측)**:
  - **MathJax 는 KaTeX 보다 관대하지 않다(핵심 반증).** 실측 — 정상 `\(\sqrt[3]{9}\)` 는 둘 다 렌더하지만, **구분자 빠진 raw·중괄호 불균형·제어문자 오염은 KaTeX·MathJax 둘 다 mjx/katex 생성 0, raw 노출**. `\(...\)` 가 정확할 때만 렌더하는 건 동일. → **11차 전환은 이득 0**(MathText.tsx 주석 "KaTeX 보다 관대"도 오류).
  - **화면 깨짐의 `▮`(U+0001)·`¶`(U+0019) 은 제어문자.** 백엔드 `_strip_control_chars` 는 제어문자를 100% 거름(검증). 그런데 보였다 = **localStorage 에 캐시된 옛 대화**(sanitize 적용 전 백엔드 생성분) + 프론트 `sanitizeHintText` 가 제어문자를 안 거름(NBSP/제로폭/화살표만)이 원인.
  - **해결(사용자 결정)**: ① **11차 MathJax 롤백 → KaTeX 복귀**(`git checkout 5956dac` 로 App.tsx·package.json·MathText·StuckHelperModal 4파일 되돌림 + 9차 대문자 `\W` 보정 재적용). better-react-mathjax 의존성 제거, CMS 와 렌더 방식 일관성 회복(student=KaTeX renderMath, CMS=각자). ② **프론트 `sanitizeHintText` 에 제어문자 strip 추가**(`/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/` = C0+C1, `\t\n\r` 보존) — renderMath 맨 앞에서 적용. ③ **localStorage 캐시 version=2**: 복구 시 version 불일치면 폐기(옛 제어문자 캐시 무력화), 저장 시 각 turn.text sanitize. 검증: Preview 실측 — KaTeX `\sqrt[3]{9}` 정상 렌더, 제어문자(U+0001/0019/00a0/200b) sanitize 후 0개, 한글 무손상, window.MathJax=undefined(롤백 확인).
  - **유지**: 11차 백엔드 프롬프트 few-shot(모든 수식 `\(...\)` 강제)은 KaTeX 에도 도움이라 유지. 백엔드 `_fix_latex_subscript_escapes`·`_strip_control_chars` 유지.
  - **올바른 재발 방지 원칙(11차 것 대체)**: **KaTeX·MathJax 둘 다 `\(...\)` 구분자가 정확해야 렌더**한다(렌더러 교체는 구분자 문제 해법 아님). 구분자 누락 대응 = 백엔드 프롬프트 강제 + 백엔드 보정(`_fix_latex_broken_delimiters`). **제어문자는 백엔드+프론트 양쪽 strip**, localStorage 는 sanitize 버전 키로 관리. 미검증 가정("X 가 관대하다") 금지 — Preview 로 실측 후 결론.
  - **12차 후속 — "퀄리티 저하" 신고는 캐시였음(실측 확정)**: 12차 배포 후 "힌트 한글이 사라지고 9 3 9 만 남는다(퀄리티 저하)" 신고. **실측 결과 백엔드·프론트 모두 정상**: 백엔드 raw = `\(\sqrt[3]{9}\)를 \(3\)의 거듭제곱으로 바꿔보면…`(한글 조사 완전, 보정 전후 동일), 프론트 `sanitizeHintText`+`renderMath` 통과 후 한글 42자→42자(손실 0), 수식/한글 정확히 분리. 정규식도 코드포인트 분해상 한글(U+AC00-D7A3) 무관. → 화면 깨짐(한글 사라짐+제목 `†††`)은 **12차 코드로는 안 나오는 출력 = localStorage 옛 캐시**. 해결: 브라우저 Local Storage `tutor_chat_*` 삭제 + Ctrl+Shift+R. **교훈: "화면이 깨졌다" 신고 시 백엔드 raw → 프론트 함수 통과까지 실측으로 코드 결백/유죄부터 가린 뒤, 둘 다 정상이면 캐시/번들을 의심**(코드 추가 수정 말 것).
- **튜터 느림·무응답·수식깨짐 — 모델 유지, 임베딩지연·캐시로 근본해결 (2026-06-23, 13차)**: 또 "호출 오래 걸려 답 안 줌 + 수식 깨짐" 신고. **처음에 "gpt-5.2(추론) 교체"를 근본원인으로 제안했다가 사용자가 정확히 반박** — gpt-5.2 가 더 좋은 모델인데 성능 떨군 모델(gpt-4o)로 가면 **답변 퀄리티 자체**가 나빠질 위험을 저울에 안 올렸다(지금 생긴 문제만 보고 단정). **→ 모델 gpt-5.2 유지 확정.** 추측 대신 실측으로 진짜 원인 분리:
    - **백엔드는 멀쩡(실측).** 실전 `generate_hint` 3턴: 깨진 문자 **0개**, 시간 11~17초(90초 timeout 아님), 수식 전부 `\(...\)` 정상, 정답 인정도 동작. 8~12차 백엔드 수정(자유텍스트+sanitize)이 깨짐을 이미 잡았다 — gpt-5.2 가 느려서/깨져서가 아니다.
    - **느림 주범 = 임베딩 죽은 터널.** `.env` `OLLAMA_URL=21434`(서버터널, **평소 죽음**) → 매 힌트 호출이 21434 에서 **15초 timeout 먹고** 로컬 11434 fallback. 사용자 체감 26~29초의 절반이 이거(모델 무관). **해결(F1): `.env` 의 `OLLAMA_URL`·`OLLAMA_BASE_URL`·`VL_OLLAMA_URL` 을 21434→`http://localhost:11434` 통일.** 실측: retrieve 가 ~17초→**2.5초**, 전체 턴 ~29초→**9~17초**. (서버 GPU 임베딩 필요 시 ssh 터널 켜고 21434 로 되돌릴 것 — .env 주석에 명시.)
    - **수식 깨짐 = 본인 브라우저 옛 localStorage 캐시(12차와 동일).** Preview(깨끗한 프로필, 캐시 0)로 새 힌트 = 깨짐 0. 12차 `CHAT_CACHE_VERSION=2` 는 "그 문제를 다시 열 때만" 그 키를 폐기 → 안 연 문제의 옛 깨진 캐시가 남음. **해결(F2): `StuckHelperModal.purgeStaleTutorChatCache()` 신규 — 앱 진입 시(App.tsx 모듈 평가 시점 1회) version≠2·만료·깨진JSON `tutor_chat_*` 키를 일괄 폐기.** Preview 실측: 옛 캐시 3종(v1/버전없음/깨진JSON) 전부 폐기, v2 정상 캐시만 생존, 콘솔 `[tutor] 옛 대화 캐시 N개 정리`. 사용자가 문제를 일일이 안 열고 **앱만 새로 로드하면** 옛 캐시 자동 제거.
    - **F3(멀티턴 _localize 조건부 스킵)은 보류** — 임베딩 지연 제거로 충분히 빨라졌고(9~17초), 10차 정답인정 로직과 얽혀 건드리면 위험. 실측 근거 없는 추가 수정 안 함(또 땜질 방지, 사용자 강조).
    - **교훈(재확인)**: ① "느리다/깨졌다" 신고 → **백엔드 raw 실측부터**(11~17초·깨짐0 확인). 코드 추가 수정 전에 결백부터 가려라. ② **모델 교체로 증상 잡으려다 품질 버리지 말 것** — 증상별 원인 분리(느림=임베딩터널, 깨짐=캐시)해서 각각 잡는다, 모델은 마지막 수단. ③ Preview(캐시 0 프로필)는 코드 결백 검증의 결정적 도구.
- **수식 깨짐 — 구분자 없는 평문 LaTeX 렌더러 폴백 (2026-06-23, 14차)**: 13차 후에도 스크린샷에 `a^m₩times a^n`(₩=한글폰트 백슬래시). 실제 출력 `a^m\times a^n` = gpt-5.2 가 `\times` 를 `\(...\)` **구분자 없이 평문**으로 흘림. **3중 갭 확정**(서브에이전트 2회): ① 모델이 간헐적으로 구분자 누락(프롬프트 few-shot 에 곱셈 예시 없었음), ② 백엔드 `_fix_latex_subscript_escapes` 는 구분자 **있다고 가정**해 평문 `\times` 안 감쌈, ③ 프론트 `renderMath` 가 `\(...\)` 매칭만 KaTeX, 나머지 escapeHtml raw 노출.
    - **실측 2건(중요)**: ⓐ 곱셈 유발 진술로 2문제×4턴=8턴 돌렸으나 **백엔드 raw 에 평문 `\times` 0회**(항상 `\(...\)` 안에 잘 감쌈) → 스크린샷은 또 옛 캐시 가능성. 그래도 **간헐 재발 방어**로 프론트 폴백 구현. ⓑ KaTeX `renderToString` 기본은 한글을 `strict='warn'` 으로 **그냥 렌더**(거부 안 함!) — `{throwOnError:true, strict:true}` 줘야 한글 섞이면 **throw → 평문 폴백**. 처음 "KaTeX 가 한글 거부"가정이 틀렸고 실측이 반증(미검증 가정 금지 재확인).
    - **해결 = 후보 B(렌더러 폴백, 프론트만, 모델 무관)**: `StuckHelperModal.tsx` `renderMath` 의 **구분자 밖 텍스트**(기존 escapeHtml 평문)를 `renderBareSegment` 로 교체 — 공백 단위 덩어리 중 LaTeX 토큰(`\명령`/지수/첨자) 포함분만 `katex.renderToString(_, {throwOnError:true, strict:true})` 시도, 실패=평문. **한국어 조사 처리**: `splitMathPrefix` 로 덩어리에서 중괄호 밖 한글이 나오는 지점 앞만 수식으로 잘라 렌더하고(`3^{2/3}이다`→`3^{2/3}` 렌더 + `이다` 평문), `\text{한글}` 안 한글은 깊이>0 라 보존. 실측(Node+Preview): 깨졌던 `a^m\times a^n일 때`·`3^{2/3}이다`·`\sqrt[3]{9}를` 모두 렌더+**한글 손실 0**, 순수 한글 문장은 평문 유지. **11차 교훈과 구분**: 렌더러 교체(KaTeX↔MathJax)는 무효였지만, **구분자 밖 조각도 strict 로 렌더 시도하는 폴백**은 유효(렌더러는 그대로 KaTeX).
    - **보조**: 백엔드 `_generate` 프롬프트 few-shot 에 곱셈/나눗셈 예(❌`a^m\times a^n` 평문 → ✅`\(a^m \times a^n\)`) + "`\times`·`\cdot`·`\div`·`\frac` 는 절대 `\(...\)` 밖 금지" 추가. 백엔드 `_fix_latex_subscript_escapes` 는 그대로(구분자 있는 깨짐 계속 보정).
    - **원칙**: gpt-5.2 가 구분자를 빠뜨려도 **프론트가 LaTeX 조각을 strict 로 렌더 시도→실패 시 평문**이라 화면 raw 노출 0("절대 안 나오게"의 코드 보장, 모델 출력 품질 무관). KaTeX 폴백은 **반드시 `strict:true`**(한글 오염 방지 핵심). 미검증 가정 금지 — Node/Preview 실측 후 결론.
- **대화 맥락 주입 + `\,` 깨짐 + 정답직전 인정 (2026-06-23, 15차)**: 사용자 "챗봇인데 대화 이력을 맥락으로 이해하며 답하느냐?" → **현재 답 아니오**(백엔드 무상태, `_localize`/`_generate` 가 이번 턴 발화 1개만 LLM 에 줌). 사용자 결정으로 **대화 맥락 주입**(위치추적 유지) + 스크린샷 2버그 동시 수정.
    - **대화 맥락 주입(7턴, _localize+_generate 둘 다)**: 프론트 `StuckHelperModal.requestHint` 가 현재 발화 추가 **직전** `turns.slice(-7)`(role+text)를 `ragHintApi.getHint(conversationHistory)` 로 전달 → `api.ts` body `conversation_history` → `models.HintRequest.conversation_history`(`ConversationTurn` 리스트) → `routers/tutor` 가 `generate_hint(conversation_history=...)` → `_format_history()`(("지금까지의 대화:\n학생:…/튜터:…")가 `_localize`/`_generate` 프롬프트에 주입. **서버 여전히 무상태**(이력은 매 요청 클라가 보냄, DB 변경 없음). 효과(실측): "그 다음은요?" 같은 맥락 의존 발화가 직전 힌트를 이해해 자연스럽게 이어감. **첫 호출(이력 없음) 회귀 0**(history 빈 문자열→기존 동작). 정답 노출 회귀 0(이력 있어도 끝가드/인정/conclusion 제외 그대로, 최종정답 1/3 안 나옴 실측). 프롬프트에 "이력은 참고용 — 거기 담긴 정답·중간결과 다시 흘리지 마라" 명시.
    - **버그A — `\,` 등 비알파벳 LaTeX 명령 `₩,` raw 노출**: 14차 `renderBareSegment` 의 `LATEX_TOKEN` 정규식 `/\\[a-zA-Z]+|.../` 가 백슬래시+비알파벳(`\,`=얇은공백, `\;\!\:`)을 못 잡아 폴백 후보 탈락→escapeHtml raw. **해결**: 정규식 `/\\(?:[a-zA-Z]+|[,;!:])|[A-Za-z0-9)}\]][\^_]/` 로 확대(프론트만). 실측(Node): `\,3^2`·`\,\sqrt[3]{9}` KaTeX strict 정상 렌더(화면 수식 구조 생성), 한글 손실 0. (KaTeX annotation 숨김 메타에 원본 LaTeX 남는 건 화면 무관 — 오탐 주의.)
    - **버그B — "3^-1맞나요?"(정답 직전) 인정 안 함**: 노드 구조상 학생이 정답 직전 단계(`current_index=last_idx-1`, 결과=`3^{-1}`)를 정확히 맞혀도, 9차 끝 가드가 **맥 빠지는 "정답 못 준다" 종료 안내**로 처리(또는 이전 단계 반복). `reached_answer` 는 **최종정답(노드 끝, `1/3`)에만** true 라 직전 단계 인정 안 됨. **해결(사용자: "정답·정답 직전까지 인정")**: 끝 가드 문구를 **"맞아요! 거기까지 정확하게 잘 왔어요. 이제 마지막 한 걸음만…"** 인정+마무리 톤으로 교체. VL 호출 없는 건 유지(정답 노출·timeout 방어). 실측: 턴3 "3^-1맞나요?" → 인정 문구.
    - **교훈**: 챗봇 "대화 맥락 이해"는 화면 localStorage 가 아니라 **백엔드 프롬프트에 이력을 실제 주입**해야 동작(무상태면 화면에만 쌓일 뿐 LLM 미전달). 5개 지점(프론트→api→model→router→handler) 모두 선택적 인자로 확장 — 첫 호출 회귀 0 보장. 정규식 확장 검증 시 KaTeX annotation 메타를 화면 텍스트로 오인 말 것(실제 렌더는 `katex-html` 구조 유무로 판정).
- **"또 오래 걸림" 회고 + timeout 50초 (2026-06-24, 16차)**: 8~15차 8번 고쳤는데 또 "힌트 오래 걸림"(95초 abort) 신고. **이번엔 분산 실측**(여러 번 돌려 지연 분포)으로 끝장:
    - **분산 실측(총 16회)**: 일반 멀티턴 9~16초, 무거운 이력 7턴 3.5~5.3초, 프론트→백엔드 핑 0.3초. **95초 근처 단 한 번도 없음.** 15차 이력 주입도 +1~5초라 무관(내가 느림 악화시킨 줄 의심했으나 반증). **백엔드 완전 결백**(13차 결론 재확인, 이번엔 분산까지).
    - **사용자 95초 = 그 순간 PC 일시 상태**(백엔드 옛코드/죽음, ollama 21434 간헐 부활로 15초씩 누적, OpenAI 일시 지연). 현재 코드로 재현 불가 → 서버 깨끗 재기동으로 해소.
    - **근본 개선(사용자 결정 timeout 50초)**: 백엔드 max 16초인데 프론트 95초는 과함 → **프론트 `api.ts:getHint` 50초** + **백엔드 `_VL_TIMEOUT` 90→50**(정합, 프론트가 먼저 끊는데 백엔드만 90초 도는 낭비 제거). + **재시도 UX**(`StuckHelperModal`): 실패 시 학생 발화 turns 에서 빼고 `lastFailedDesc` 보관 → "다시 시도" 버튼(재타이핑 불필요). 로딩 문구 "최대 1분"→"보통 10초 안에".
    - **회고 — 8번 실패의 진짜 교훈(명문화)**: ① **증상별 땜질 누적**(8차 디코딩루프→9차 W→10차 NBSP→11차 MathJax헛수고→12차 롤백→13차 임베딩→14차 `\times`→15차 `\,`) = 매번 한 증상만 막고 다음 변형이 샘. ② **실측을 "그 순간 1회"만 함** — gpt-5.2 지연·깨짐은 간헐적이라 작은 표본에 안 잡힘. **반드시 분산 측정**(5~10회 반복)해야 "어쩌다 95초" 같은 꼬리를 잡거나 결백을 증명. ③ "느리다/깨졌다" 신고 = **백엔드 raw·지연 분산부터 실측**, 코드 추가 전 결백/유죄 가리기. ④ timeout 은 실측 분포(max)에 여유 두고 짧게 — 무한 가정 금지.
- **정답직전 마무리 견고화 — reached_near_answer 직접판정 (2026-06-24, 17차)**: 멀티턴에서 학생이 "3^-1 인가??"(정답직전 노드3 결과)라 했는데 튜터가 **턴1~2 앞 단계로 되돌아가** 엉뚱한 힌트(+그 호출 50초 timeout). **근본 원인**: 끝 가드가 `current_index >= last_idx-1`(위치 index 단일 의존)인데, `_localize`(gpt-5.2 추론)가 "3^-1 인가??"를 **간헐적으로 앞 노드(0~1)로 오판** → 끝 가드·정답 인정 둘 다 통과 못 함 → VL `_generate` 가 앞 노드 근거로 앞 힌트 반복.
    - **해결(사용자 결정: _localize 가 정답직전/정답 도달 직접 판정)**: `_Localized` 스키마에 **`reached_near_answer: bool`** 추가(정답 직전 노드 이상 결과 도달, `reached_answer`=최종정답만보다 한 단계 넓음). `_localize` 프롬프트에 **정답직전 노드 결과식**(`nodes[-2]`)도 줘서 "학생 발화가 정답직전 결과에 닿았으면 true" 판정. 반환 3-tuple `(idx, reached_answer, reached_near_answer)`. `near = reached_near_answer or reached_answer`(논리 포함 보정).
    - **generate_hint 마무리 가드 통합**: 옛 "정답 인정"·"끝 가드" 두 블록 → **한 블록**: `reached_answer or reached_near_answer or current_index>=last_idx-1` 중 하나라도 true 면 VL 없이 **종료 유도 마무리**. **②reached_near_answer 가 핵심** — _localize 가 위치 index 를 오판해 앞으로 잡아도, 학생 발화가 정답직전 결과에 닿았으면 잡아서 엉뚱한 앞 힌트 대신 마무리(위치 오판 무력화). revealed>=0 로 첫 호출 보호 유지.
    - **종료 유도 톤(사용자 결정)**: "맞아요! 거기까지 정확..." → **"오케이, 거의 다 왔어요! 여기까지 정말 잘 따라왔어요. 마지막 답은 직접 고민해서 결정해보세요. 충분히 할 수 있어요!"** (정답 수치 안 말함, 스스로 마무리 유도). 종료 후 학생이 또 쳐도 매 턴 _localize 가 reached_near_answer=true 재판정 → 같은 종료 톤 자동 유지(메모리/revealed 없이도).
    - **검증(분산 실측, 16차 교훈)**: "3^-1 인가??" 6회 → **6/6 종료 유도, 엉뚱 앞힌트 0/6**(이전엔 간헐 엉뚱). 회귀: 중간 발화("3^2/3이여", revealed=0)는 2/2 정상 힌트(조기종료 안 함). 정답수치(1/3·3^-1) 마무리 문구 노출 0. 백엔드만 변경(프론트 무관).
    - **교훈**: 추론모델(_localize)의 **위치 index 판정은 간헐 오판**한다 — 마무리 가드를 위치 숫자에만 걸면 취약. "도달 여부"(reached_near_answer)를 **직접 판정**시키면 위치 오판과 무관하게 견고. 같은 부류 가드는 "숫자 임계" 대신 "의미 도달"로 설계.
- **위치추적 DAG 이해 + 마무리 결정론 (2026-06-24, 18차)**: 17차 후에도 학생 "지수끼리 더해서 3^-1이 나올거같아"(정답직전 도달)에 튜터가 **앞 단계(거듭제곱 변환)로 되돌아감**. 사용자 화남 + 핵심 지적 2개로 근본 해결.
    - **사용자 지적 ①: `_localize` 위치 판정 자체가 망가짐**. 학생이 노드3(3^-1) 도달 발화인데 _localize 가 노드0~1 로 오판 → 마무리만의 문제가 아니라 일반 힌트도 엉뚱. 17차 importlib 실측 6/6 통과였으나 사용자 uvicorn 화면 실패 = LLM 간헐성 + 위치 판정이 근본은 안 고쳐짐.
    - **사용자 지적 ②(결정적): 노드 index 는 진행순서가 아니라 DAG 위치다**. 처음에 `max(localize, revealed)` 하한강제(뒤로 안 감)를 제안했으나 사용자가 막음 — **case_split 문제**(평가원 6월 25년 21번 18노드 실측: 노드2,3(x→1)·노드5,6(x→2)은 형제, 둘 다 `uses=[1]`)에서 학생이 노드5(x→2)→노드2(x→1)로 가는 건 **정상 갈래 전환**인데 하한강제가 5로 끌어올려 막음. "index 작음=퇴행" 가정이 분기에서 깨짐.
    - **해결(사용자 확정: LLM 에 DAG 정보 주고 맡김 + 하한강제 제거)**: ⓐ **`_localize` outline 에 role·uses(전이 DAG) 추가** → VL 이 갈래 구조(형제/합류) 이해, 갈래 전환을 퇴행으로 오인 안 함. ⓑ **`revealed_node_index` 주입** → "같은 갈래면 그 이상, 다른 갈래(case_split)면 작아도 정상" 명시. ⓒ **보수규칙 이중기준** → "결과식 명확하면 그 단계로 정확히, 모호할 때만 앞으로 보수적"(정답직전 명확발화 끌어내림 방지). ⓓ **코드 퇴행방지·하한강제 제거** — 위치는 전적으로 VL(DAG 정보로 신뢰도↑)에 맡김. ⓔ **마무리 가드만 결정론**: `revealed >= last_idx-1`(LLM 무관 1순위) OR reached_answer OR reached_near_answer.
    - **검증(분산 실측)**: ① 선형 "지수끼리 더해서 3^-1" revealed=2 **8회 → 앞단계 되돌이 0/8, 마무리 8/8**(스크린샷 버그 소멸). ② **분기 갈래전환**: revealed=5(x→2)에서 "x=1 좌극한" 발화 → localize_idx=**1**(x→1 갈래, 5에 안 막힘 — 하한강제였으면 막혔을 것). ③ 결정론 마무리 revealed=last-1 → 3/3(LLM 무관). ④ 첫 호출(-1) 정상 힌트.
    - **교훈(핵심)**: **노드 index ≠ 진행순서**. solution_nodes 는 `uses` DAG 분기 구조(case_split). 위치를 1차원 정수로 강제(`max`, 퇴행방지)하면 분기에서 깨진다 — **VL 에 role/uses(DAG)를 줘서 갈래를 이해시키는 게** 코드 휴리스틱보다 견고. 단일 케이스(선형 5노드)로 과적합 말 것(사용자 경계). 마무리 같은 안전가드만 결정론(revealed)으로.
- **마무리 가드 위치 index 결정론 보강 (2026-06-24, 19차)**: 18차 후에도 사용자 직접 검사 시 또 "정답직전(3^-1) 도달에 처음으로 되돌아감" 스크린샷. 실패 케이스 재분석 + 분기 마무리 근본 보강.
    - **분산 실측으로 코드 결백/유죄 먼저 가림(13·16차 교훈)**: 18차 현재 코드로 스크린샷과 똑같은 **선형 5노드**(평가원 6월 26년 1번) 흐름을 `generate_hint` 멀티턴 3회 + `_localize` 25회 실측 → "3^-1" 발화 **전부 idx=3·reached_near=True 정확 판정, 마무리 정상**(처음 회귀 0). revealed=-1/0/1/2 어디서도 동일. **→ 18차 코드는 선형에서 결백**. 사용자 화면 실패는 13차부터 살아있던 **옛 서버(8001 PID 13292)** 또는 프론트 옛 캐시(13·16차 반복 패턴).
    - **그러나 분기(case_split)에서 마무리가 LLM 단독 의존 = 실재 약점**: 18차 가드 `revealed >= last_idx-1 OR reached_answer OR reached_near_answer`. 선형은 `revealed`(단조증가) 결정론이 받치지만, **분기는 revealed 가 단조증가 안 함**(갈래 오가며 index 작아짐) → 결정론 무력 → `reached_near_answer`(gpt-5.2) **단독 의존** → LLM 한 번 흔들리면 마무리 실패→엉뚱한 앞 갈래 힌트.
    - **해결(변경 1, 백엔드 1줄): 마무리 가드에 `current_index >= last_idx-1` OR 추가**. 이번 턴 `_localize` 가 잡은 **위치 index** 가 최종/직전 노드면 LLM near 판정 없이 마무리. revealed 와 달리 분기에서도 유효(이번 턴 실제 도달 위치). 위치 index 는 18차에서 DAG(role/uses) 정보로 신뢰도↑. 실측 근거: 분기 18노드(평가원 25년 21번) 최종 도달 시 idx 와 reached_near 가 5/5 일치 → idx 도 신뢰 가능한 결정론 신호. **첫 호출 보호(revealed>=0)·보수판정(틀린발화는 idx 앞이라 ②도 false) 유지**.
    - **폐기(사용자 직전 선택 실측 반증): "모든 conclusion 노드 도달이면 마무리"는 조기종료 버그**. 18노드 case_split 은 conclusion 이 step 4/7/13/16 네 군데(갈래별 중간 결론), 진짜 최종은 step17(role=computation!). 학생이 step7(전체 1/3 지점) 도달을 마무리로 치면 **1/3 지점 종료**. → 마무리 기준은 **"최종 노드(nodes[-1]) 또는 직전(nodes[-2])"** = 18차 reached_near_answer 정의가 의미적으로 옳았음. ②가 `last_idx-1 이상`일 때만 발동하므로 중간 conclusion(idx<last-1)은 안 잡힘(정합).
    - **함께 수정**: `_localize` except fallback 이 `return -1, False`(2-tuple)로 18차에서 **누락** — 호출부 3-tuple 언팩과 불일치라 예외 시 500. `return -1, False, False` 로 교정.
    - **검증(분산 실측)**: ① 선형 멀티턴 5회 → **마무리 5/5, 앞단계 되돌이 0**. ② 분기 최종 step17 도달 5회 → **마무리 5/5**(②로 near 무관 발동). ③ 분기 중간 conclusion step7 5회 → **마무리 0/5**(조기종료 0). ④ 분기 중간 case_split step2 5회 → **마무리 0/5**(정상 힌트). ⑤ /tutor-smoke(평가원 25년 6번) 첫호출·멀티턴 진행 정상. 백엔드만 변경(프론트/DB 무관).
    - **교훈**: **마무리 판정은 LLM 단독 의존 금지.** 선형은 revealed 결정론, **분기는 위치 index 결정론**(revealed 가 단조증가 안 하므로)으로 받치고 LLM(near/answer)은 보조 — 둘 다 OR. "정답직전"은 conclusion 역할 전체가 아니라 **최종/직전 노드 위치**로 정의(분기 중간 결론 마무리 오인=조기종료, 실측 반증). "화면 실패" 신고 = 백엔드 raw 분산 실측부터(코드 결백 25회 확인 후 옛 서버/캐시 의심).
    - **★진짜 근본 원인 발견 (19차-2, 8~18차 화면 실패의 정체)**: 변경 1 배포 후에도 사용자가 같은 스크린샷 재현. **실제 HTTP 경로**(JWT 발급 → `/api/tutor/hint`, 프론트와 100% 동일)로 재현하니 첫 호출이 **3회 모두 90초 timeout**(내 직접 `generate_hint` import 는 8~16초인데!). 동일 코드인데 **uvicorn 경로에서만 극심하게 느림** → 옛 서버 의심 확정 절차:
      - `netstat -ano | findstr :8001` 가 PID **13292**(13차 plan 의 그 PID) LISTENING 표시하나 `taskkill /F /PID 13292`·`tasklist`·`Get-Process` 모두 "프로세스 없음" → **netstat 이 죽은 PID 를 캐시**(소켓 잔류)해 헷갈림. `Test-NetConnection 8001` = **True**(살아있는 서버가 응답) → 누군가 8001 서빙 중.
      - **`Get-CimInstance Win32_Process -Filter "Name='python.exe'"` 가 결정타**: 살아있는 python 은 **PID 9140 단 하나, 시작 시각 2026-06-21**(3일 전!), 커맨드라인 `from multi...`(uvicorn `--reload` multiprocessing). = **6월 21일 띄운 옛 서버가 3일간 포트 8001 점유**. 8~18차 수정 전 코드 + 옛 셸의 죽은 임베딩 터널(21434) 로 돌아 매 임베딩 15초 timeout 누적 → 90초.
      - **내가 "재기동"할 때마다 새 uvicorn 은 포트 8001 이미 점유 → 바인딩 실패 후 조용히 죽음**(에러를 독립 cmd 창이 먹어 안 보임). 사용자 요청은 계속 옛 서버 9140 으로 감. **= 8~18차 내 모든 백엔드 수정이 화면에 단 한 번도 반영된 적 없음.** "코드 결백 실측 통과(직접 import)인데 화면은 계속 실패/느림"의 정체.
      - **해결**: `Get-CimInstance ... ParentProcessId` 로 9140+자식 `taskkill /F` → `Test-NetConnection 8001`=**False**(포트 완전 해제) 확인 후 새 uvicorn 기동(2초 바인딩 성공). **실제 HTTP 멀티턴 재현 = 턴1 15.6s/턴2 12.3s/턴3 6.4s, 턴3 "더하면 3^-1" → "오케이 거의 다 왔어요!" 마무리**(90초 timeout·처음회귀 소멸).
    - **★재발 방지 원칙(최우선, 모든 차수 공통)**: "재기동했다"를 믿지 말 것 — **새 서버가 실제로 그 포트를 잡았는지 PID 로 검증**. 절차: ① 재기동 전 `Get-CimInstance Win32_Process -Filter "Name='python.exe'"`(또는 node) 로 **살아있는 프로세스의 시작시각·PID 확인**(netstat PID 는 죽은 소켓 캐시라 못 믿음). ② 옛 프로세스(시작시각 오래됨)를 `taskkill /F` + 자식까지(`ParentProcessId`). ③ `Test-NetConnection <port>` 가 **False**(포트 해제) 확인 후 재기동. ④ 재기동 후 새 PID 시작시각 > 코드 수정시각 확인(`feedback_stale_dev_server`). ⑤ **HTTP 경로로 실측**(직접 import 아님) — uvicorn 이 실제 서빙하는 코드/속도 검증. `--reload` 는 포트 충돌 시 조용히 실패하니 의존 말 것. **"화면 실패" 디버깅의 1순위는 코드가 아니라 '어느 서버가 그 포트를 서빙 중인가'.**
- **임베딩 로컬 fallback (2026-06-23)**: `embedder._generate_embedding_ollama` 가 `OLLAMA_URL`(서버 터널 21434) 접속 실패 시 **로컬 `http://localhost:11434` 자동 재시도**(같은 bge-m3 1024차원, 차원 호환). timeout 15초. 둘 다 죽으면 예외 → stuck_helper same-problem fallback. OpenAI 임베딩(1536) fallback 은 RAG 검색용으론 부적합이라 차단 유지.
- **백필**: `cd backend/pdf_pipeline && venv\Scripts\activate && python -m scripts.backfill_solution_nodes --limit 5` (`OPENAI_API_KEY` 필수. 임베딩은 OLLAMA_URL 실패 시 로컬 11434 자동 fallback 하므로 수동 override 불필요).
- **도형/그래프 (2026-06-18 결정)**: 해설 도형 자동 crop 안 함. `rag_node_extractor` 는 `figure_image_crop_url=None` 으로 두고(해설 통째 폴백은 정답 노출 위험), `figure_description`(VL 언어화)만 검색·근거로 사용. 정확한 도형 영역은 **CMS 수동 bbox 로 채운다(후속)**. 1차는 도형 이미지 없이 텍스트 힌트만(graceful). stuck_helper 는 같은 문제(`is_same_problem`) crop 은 학생에게 안 보여줌(정답 노출 방어).
- **프론트**: `apps/student` `SolveProblem.tsx` → `components/tutor/StuckHelperModal.tsx` → `shared/lib/api.ts:ragHintApi.getHint`. base URL env `VITE_TUTOR_API_URL`(구 `VITE_DEEPTUTOR_URL` 하위호환 fallback), 기본 `http://localhost:8001`.
- **하네스**:
  - `/solution-nodes-status` — 백필 커버리지·노드 품질·정답노출 위험 조회 + 이어서 백필 명령 (`.claude/commands/solution-nodes-status.md`)
  - `/tutor-smoke` — 샘플 문제로 `generate_hint` end-to-end 1발 검증(실전 핸들러 import) (`.claude/commands/tutor-smoke.md`)
  - PostToolUse hook `.claude/tutor_import_hook.py` — 튜터 스택 파일(stuck_helper/tutor/auth/models/rag_node_extractor) Edit·Write 시 import 스모크 자동 실행, 깨지면 즉시 경고. settings.json `PostToolUse[Edit|Write]` 등록.
  - `vl_raw_dumps/` 는 `.gitignore` 등록됨(`VL_DUMP_RAW=1` 디버그 덤프 — 커밋 금지).

## 메모리 규칙

새 세션에서 기억해야 할 내용은 `~/.claude/projects/.../memory/` 가 아닌 **이 프로젝트의 `.claude/rules/` 파일에 기록**한다.
- 장기 피드백/규칙 → `rules/dev-rules.md` (이 파일)
- 프로젝트 현황/서버 세팅 → `rules/project-status.md`
- DB 규칙 → `rules/db-conventions.md`
- 문제 등록 규칙 → `rules/problem-registration.md`
- 코드 스타일 → `rules/code-style.md`
