로컬 서버(uvicorn 8001 / vite 8081·8082·8083)가 **진짜 최신 코드를 서빙 중인지** 진단하고, 옛 서버가 포트를 점유 중이면 정리 후 재기동한다.

> **왜 필요한가 (19차에 11번 헛수고로 확정된 함정):** 옛 서버가 포트를 안 놓으면, 새로 띄운
> uvicorn/vite 는 **포트 충돌로 조용히 바인딩 실패**한다(독립 cmd 창이 에러를 먹어 안 보임). 그러면
> 코드를 아무리 고쳐도 화면엔 **옛 서버의 옛 코드**가 응답한다. "코드는 직접 import 실측상 멀쩡한데
> 화면만 계속 실패/느림" = 이 함정. **`netstat` 의 PID 는 죽은 소켓을 캐시**해 못 믿으니, 반드시
> `Get-CimInstance` 로 **살아있는 프로세스**를 봐야 한다. 화면 실패 디버깅 1순위 = '어느 서버가 그
> 포트를 서빙 중인가'.

## 절차

### 1. 포트별 점유 프로세스 실측 (netstat 만 믿지 말 것)

살아있는 python/node 프로세스의 **PID·시작시각·커맨드라인**을 본다. netstat 은 표시만 참고:

```powershell
# 살아있는 서버 프로세스 (시작시각 = 옛 서버 판별 핵심)
Get-CimInstance Win32_Process -Filter "Name='python.exe' or Name='node.exe'" |
  Select-Object ProcessId, @{N='Start';E={$_.CreationDate}},
    @{N='Cmd';E={$_.CommandLine.Substring(0,[Math]::Min(100,$_.CommandLine.Length))}} |
  Format-Table -AutoSize

# 포트별 리스닝 (PID 는 죽은 소켓 캐시일 수 있음 — 위 산 프로세스와 대조)
netstat -ano | Select-String ':8001|:8081|:8082|:8083' | Select-String 'LISTENING'
```

### 2. 옛 서버 감지 (시작시각 vs 코드 수정시각)

서버 시작시각이 **방금 고친 코드 파일의 수정시각보다 오래됐으면 = 옛 코드 서버**:

```powershell
$fileM = (Get-Item 'C:\Users\user\workspaces\math\backend\pdf_pipeline\handlers\stuck_helper.py').LastWriteTime
Write-Output ("stuck_helper.py 수정: {0}" -f $fileM)
# 위 1번 표의 uvicorn 프로세스 Start 와 비교. Start < 수정시각 이면 옛 코드 서빙 중.
```

판정: `시작시각 < 코드 수정시각` → **옛 서버 의심**(`feedback_stale_dev_server`).
포트는 살아있는데(`Test-NetConnection` True) python.exe 가 안 보이거나 시작이 며칠 전이면 → 옛 서버 확정.

### 3. 복구 — 옛 서버 종료 (사용자 확인 후)

옛 프로세스 + 자식(`--reload` 는 multiprocessing 부모/자식 구조라 자식까지) 종료:

```powershell
$parent = <옛PID>
$children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$parent" | Select -Expand ProcessId
foreach ($p in (@($parent) + $children)) { & taskkill /F /PID $p 2>&1 }
# 포트 완전 해제 확인 — False 여야 함(True 면 아직 누가 잡고 있음)
(Test-NetConnection -ComputerName localhost -Port 8001 -WarningAction SilentlyContinue).TcpTestSucceeded
```

> `taskkill`·`Stop-Process` 강제 종료는 평소 금지(dev-rules)지만, **옛 서버 정리/사용자 재기동 요청
> 시는 예외**(13·16·19차 전례). 작업 중 서버가 죽는 것과 다름.

### 4. 재기동 — 독립 cmd 창 (백그라운드 금지)

`Test-NetConnection` False(포트 해제) 확인 후:

```powershell
# 백엔드 8001
Start-Process cmd -ArgumentList '/k','cd /d C:\Users\user\workspaces\math\backend\pdf_pipeline && call venv\Scripts\activate.bat && uvicorn main:app --reload --port 8001' -WindowStyle Minimized
# 프론트 (필요한 것만): cms 8081 / teacher 8082 / student 8083
Start-Process cmd -ArgumentList '/k','cd /d C:\Users\user\workspaces\math\apps\student && npm run dev' -WindowStyle Minimized
```

기동 폴링 (`Test-NetConnection` True 될 때까지). `--reload` 는 포트 충돌 시 **조용히 실패**하니, 반드시 5번으로 "새 서버가 진짜 떴는지" 검증.

### 5. 재기동 후 검증 (이게 핵심 — "떴다"를 믿지 말 것)

```powershell
# 새 PID 시작시각 > 코드 수정시각 이어야 최신 코드 서빙
# (1번 명령 재실행해 새 PID·시작시각 확인 → 2번 수정시각과 비교)
```
```bash
curl -s -o /dev/null -w "8001 HTTP %{http_code}\n" -X POST http://localhost:8001/api/tutor/hint -H "Content-Type: application/json" -d '{"problem_id":"x","student_blocked_description":"y"}' --max-time 10   # 422 = 인증 살아있음(정상)
curl -s -o /dev/null -w "8083 HTTP %{http_code}\n" http://localhost:8083 --max-time 5   # 200
```

### 6. (선택, 튜터 전용) HTTP 경로 실측 — 직접 import 와 엇갈리면 옛 서버 확정

코드 결백은 직접 `generate_hint` import 로(`/tutor-smoke`), **화면 재현은 실제 HTTP 경로**로. 둘이
엇갈리면(직접 8초인데 HTTP 90초 timeout) = 옛 서버가 범인. JWT 는 admin generate_link → verify 로 발급:

```python
# /tmp/http_check.py (실행 후 삭제). SUPABASE_URL/ANON/SERVICE 는 .env.
import os, requests, time
from pathlib import Path
from dotenv import load_dotenv
PIPE = Path('C:/Users/user/workspaces/math/backend/pdf_pipeline'); load_dotenv(PIPE/'.env')
import sys; sys.path.insert(0, str(PIPE))
from storage.supabase_client import get_client
U=os.environ['SUPABASE_URL']; ANON=os.environ['SUPABASE_ANON_KEY']
SVC=os.environ.get('SUPABASE_SERVICE_KEY') or os.environ.get('SUPABASE_KEY')
c=get_client(); stud=c.table('profiles').select('user_id').eq('role','student').limit(1).execute().data[0]
ah={'apikey':SVC,'Authorization':f'Bearer {SVC}'}
email=requests.get(f"{U}/auth/v1/admin/users/{stud['user_id']}",headers=ah,timeout=10).json()['email']
gl=requests.post(f"{U}/auth/v1/admin/generate_link",headers={**ah,'Content-Type':'application/json'},json={'type':'magiclink','email':email},timeout=10).json()
otp=gl.get('hashed_token') or gl.get('properties',{}).get('hashed_token')
tok=requests.post(f"{U}/auth/v1/verify",headers={'apikey':ANON,'Content-Type':'application/json'},json={'type':'magiclink','token_hash':otp},timeout=10).json()['access_token']
pid=c.table('solution_nodes').select('problem_id').limit(1).execute().data[0]['problem_id']
t0=time.time()
r=requests.post('http://localhost:8001/api/tutor/hint',headers={'Authorization':f'Bearer {tok}','Content-Type':'application/json'},
                json={'problem_id':pid,'student_blocked_description':'아예 모르겠어','revealed_node_index':-1,'conversation_history':[]},timeout=90)
print(f'HTTP {r.status_code} {time.time()-t0:.1f}s | {r.json().get("hint_text","")[:60] if r.status_code==200 else r.text[:80]}')
```
```bash
cd backend/pdf_pipeline && ./venv/Scripts/python.exe -u /tmp/http_check.py; rm -f /tmp/http_check.py
```
합격: HTTP 200 + ~6~16초(90초 timeout 이면 옛 서버/임베딩 터널 의심 → `.env` OLLAMA_URL 11434 확인).

### 7. 리포트 포맷

```
[8001 backend]  PID 7220  기동 08:37 (코드수정 08:29 이후 ✓)  HTTP 422  → 최신 OK
[8083 student]  PID 1880  기동 08:40                          HTTP 200  → OK
[8081 cms]      미기동                                        → 필요시 4번으로 기동
옛 서버: 없음 (또는 "PID 9140 6/21 기동 → 종료함")
```

## 참고

- 서버 기동 명령·격리 규칙: `.claude/rules/dev-rules.md` "로컬 실행 환경" / "에이전트가 서버 띄울 때" / 19차 회고.
- 코드 결백 검증(직접 import): `/tutor-smoke`.
- **함정 요약**: netstat PID ≠ 살아있는 프로세스(죽은 소켓 캐시). `--reload` 는 포트 점유 시 조용히 실패. "재기동했다"를 PID 시작시각 + HTTP 실측으로 검증.
