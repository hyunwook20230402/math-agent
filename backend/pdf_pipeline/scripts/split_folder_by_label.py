"""한 폴더에 섞여 있는 문제를 지면번호 범위로 나눠 하위 폴더에 담는다.

왜 필요한가:
  쎈은 한 단원 안에 A/B/C 단계가 이어져 있어, 단원 전체를 한 번에 크롭하면 단계가 한
  폴더에 섞인다. 교재를 단계별로 쌓으려면 지면번호로 갈라 옮겨야 하는데, CMS 에서
  체크박스로 97개를 고르는 건 무리다.

  (앞으로는 업로드할 때 단계 구간만 골라 크롭하므로 이 스크립트가 필요 없다.
   이미 섞여 버린 것을 정리하거나, 실수로 통째 크롭했을 때 쓴다.)

왜 problems 와 problem_staging 을 같이 고치나:
  CMS 의 폴더 이동은 `problems` 만 갱신한다. 그러면 staging 의 folder_id 가 옛 폴더에
  남아, 빠른정답 스코프 추정(`main._job_scope`)이 엉뚱한 폴더를 가리킨다. 둘을 맞춘다.

사용법:
    python -m scripts.split_folder_by_label <source_folder_id> \\
        --into "B단계/나머지정리와 인수분해=0159-0255" \\
        --into "C단계/나머지정리와 인수분해=0256-0278" \\
        --delete-source --apply

  --into "부모/자식=시작-끝"  부모는 교재 바로 아래에, 자식은 그 아래에 만든다(있으면 재사용).
  --apply 없으면 무엇이 어디로 가는지만 보여준다(기본 dry run).
"""
import argparse
import sys
from collections import Counter

from storage.supabase_client import get_client


def _parse_into(spec: str) -> dict:
    """"부모/자식=시작-끝" → {parent, child, lo, hi}"""
    try:
        path, rng = spec.rsplit("=", 1)
        lo, hi = rng.split("-", 1)
        parent, child = path.split("/", 1)
    except ValueError:
        raise SystemExit(f'--into 형식이 잘못됐습니다: {spec!r}\n'
                         '  예: "B단계/나머지정리와 인수분해=0159-0255"')
    return {"parent": parent.strip(), "child": child.strip(),
            "lo": lo.strip(), "hi": hi.strip()}


def _in_range(label: str, lo: str, hi: str) -> bool:
    """지면번호가 범위 안인가. 둘 다 숫자면 숫자로 비교한다(0 패딩 차이 흡수)."""
    if not label:
        return False
    if label.isascii() and label.isdigit() and lo.isdigit() and hi.isdigit():
        return int(lo) <= int(label) <= int(hi)
    return lo <= label <= hi


def _find_or_create(sb, textbook_id: str, name: str, parent_id, sort_order: int,
                    apply: bool) -> str:
    q = (sb.table("problem_folders").select("id,name")
         .eq("textbook_id", textbook_id).eq("name", name))
    q = q.is_("parent_id", "null") if parent_id is None else q.eq("parent_id", parent_id)
    found = q.execute().data
    if found:
        print(f"    폴더 있음: {name!r} ({found[0]['id'][:8]})")
        return found[0]["id"]
    if not apply:
        print(f"    폴더 새로 만듦: {name!r} (dry run — 아직 안 만듦)")
        return f"<새폴더:{name}>"
    row = sb.table("problem_folders").insert({
        "name": name, "textbook_id": textbook_id,
        "parent_id": parent_id, "sort_order": sort_order,
    }).execute().data[0]
    print(f"    폴더 만듦: {name!r} ({row['id'][:8]})")
    return row["id"]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("source_folder_id")
    ap.add_argument("--into", action="append", required=True,
                    help='"부모/자식=시작-끝" (여러 번 줄 수 있음)')
    ap.add_argument("--delete-source", action="store_true",
                    help="다 옮긴 뒤 원본 폴더가 비었으면 지운다")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    sb = get_client()
    rows = sb.table("problem_folders").select("id,name,textbook_id,parent_id") \
        .eq("id", args.source_folder_id).execute().data
    if not rows:
        raise SystemExit(f"폴더를 찾을 수 없습니다: {args.source_folder_id}")
    src = rows[0]
    tb = sb.table("textbooks").select("name").eq("id", src["textbook_id"]).execute().data
    print(f"원본 폴더: {src['name']!r}  (교재 {tb[0]['name'] if tb else '?'})\n")

    specs = [_parse_into(s) for s in args.into]

    problems = sb.table("problems").select("id,source_label,title") \
        .eq("folder_id", src["id"]).execute().data
    staging = sb.table("problem_staging").select("id,source_label,problem_number") \
        .eq("folder_id", src["id"]).execute().data
    print(f"옮길 대상: problems {len(problems)}건 / staging {len(staging)}건")

    # 어디로 갈지 가른다 — 범위 밖이 하나라도 있으면 중단(조용히 빠뜨리는 것보다 낫다).
    def bucket(rows):
        out, orphan = {i: [] for i in range(len(specs))}, []
        for r in rows:
            lb = (r.get("source_label") or "").strip()
            for i, sp in enumerate(specs):
                if _in_range(lb, sp["lo"], sp["hi"]):
                    out[i].append(r)
                    break
            else:
                orphan.append(r)
        return out, orphan

    pb, p_orphan = bucket(problems)
    sb_, s_orphan = bucket(staging)

    print()
    for i, sp in enumerate(specs):
        print(f"  [{sp['lo']}~{sp['hi']}] → {sp['parent']}/{sp['child']}"
              f"   problems {len(pb[i])}건 / staging {len(sb_[i])}건")
    if p_orphan or s_orphan:
        print(f"\n범위 밖 problems {len(p_orphan)} / staging {len(s_orphan)}:")
        for r in (p_orphan + s_orphan)[:10]:
            print(f"    {r.get('source_label')!r} {r.get('title') or r.get('problem_number')}")
        raise SystemExit("범위 밖 문제가 있어 중단합니다 — --into 범위를 고쳐 주세요.")

    if not args.apply:
        print("\n[DRY RUN] 실제로 옮기려면 --apply 를 붙이세요.")
        return

    print("\n폴더 준비:")
    targets = []
    parents: dict = {}
    for i, sp in enumerate(specs):
        if sp["parent"] not in parents:
            parents[sp["parent"]] = _find_or_create(
                sb, src["textbook_id"], sp["parent"], None, len(parents) + 1, True)
        child = _find_or_create(
            sb, src["textbook_id"], sp["child"], parents[sp["parent"]], 1, True)
        targets.append(child)

    print("\n옮기는 중:")
    for i, sp in enumerate(specs):
        fid = targets[i]
        for table, rows in (("problems", pb[i]), ("problem_staging", sb_[i])):
            ids = [r["id"] for r in rows]
            for j in range(0, len(ids), 200):      # 요청이 커지지 않게 나눠 보낸다
                sb.table(table).update({"folder_id": fid}) \
                    .in_("id", ids[j:j + 200]).execute()
            print(f"    {sp['parent']}/{sp['child']} ← {table} {len(ids)}건")

    left_p = sb.table("problems").select("id", count="exact") \
        .eq("folder_id", src["id"]).limit(1).execute().count
    left_s = sb.table("problem_staging").select("id", count="exact") \
        .eq("folder_id", src["id"]).limit(1).execute().count
    print(f"\n원본 폴더에 남은 것: problems {left_p} / staging {left_s}")

    if args.delete_source:
        if left_p or left_s:
            print("  비어 있지 않아 원본 폴더를 지우지 않습니다.")
        else:
            kids = sb.table("problem_folders").select("id") \
                .eq("parent_id", src["id"]).execute().data
            if kids:
                print(f"  하위 폴더가 {len(kids)}개 있어 지우지 않습니다.")
            else:
                sb.table("problem_folders").delete().eq("id", src["id"]).execute()
                print(f"  원본 폴더 {src['name']!r} 삭제")

    print("\n결과 분포:")
    for table in ("problems", "problem_staging"):
        rows = sb.table(table).select("folder_id") \
            .eq("textbook_id", src["textbook_id"]).execute().data
        names = {f["id"]: f["name"] for f in sb.table("problem_folders")
                 .select("id,name").eq("textbook_id", src["textbook_id"]).execute().data}
        c = Counter(names.get(r["folder_id"], "(폴더 없음)") for r in rows)
        print(f"  {table}: {dict(c)}")


if __name__ == "__main__":
    sys.exit(main())
