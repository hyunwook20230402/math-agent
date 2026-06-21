"""B 작업: 페이지 걸친 해설 조각을 새 정렬 코드로 다시 병합 → Storage 재업로드(덮어쓰기).

옛 merged 이미지는 정렬 전(2p가 위)으로 잘못 합쳐져 있었다. solution_parser 의 정렬
수정 이후, 같은 fragments 로 다시 병합하면 1p(위)→2p(아래) 순으로 새로 생성된다.
Storage 경로(파일명 merged_NNNN.png)가 같아 upsert 로 덮어써지므로 solution_image_url 은
그대로 유효하고 이미지 내용만 교체된다.

사용:
  python -m scripts._remerge_solution <solution_job_id>
"""
import sys
from pathlib import Path

from dotenv import load_dotenv
load_dotenv()

from storage.supabase_client import get_client
from storage.image_uploader import upload_cropped_images
from pipeline.solution_parser import merge_cross_page_solutions


def main():
    if len(sys.argv) < 2:
        print("usage: python -m scripts._remerge_solution <solution_job_id>")
        sys.exit(1)
    sj = sys.argv[1]

    client = get_client()
    row = client.table("solution_jobs").select("progress, pdf_path").eq("id", sj).single().execute()
    progress = row.data["progress"] or {}
    pdf_path = row.data.get("pdf_path")
    fragments = progress.get("fragments", {})

    # 조각 2개 이상(페이지 걸침 또는 같은 페이지 분할)인 번호만 재병합 대상
    targets = {int(k): v for k, v in fragments.items()
               if str(k).isdigit() and isinstance(v, list) and len(v) >= 2}
    if not targets:
        print("재병합 대상 없음(조각 2개 이상 번호 없음)")
        return
    print(f"재병합 대상 {len(targets)}개: {sorted(targets)}")

    merged_dir = str(Path(pdf_path).parent / "solution_merged")
    page_bboxes = progress.get("page_bboxes", {})  # 2단 조판 읽기순서 정렬용 좌표
    merged = merge_cross_page_solutions(targets, merged_dir, 10, pdf_path, page_bboxes)
    print(f"병합 완료 {len(merged)}개")

    # Storage 재업로드(덮어쓰기). job_id 형식은 _run_solution_upload_and_tag 와 동일.
    upload_items = [{"number": num, "cropped_path": path} for num, path in merged.items()]
    uploaded = upload_cropped_images(upload_items, f"solution_{sj}")
    print(f"Storage 재업로드 완료 {len(uploaded)}개")
    for u in sorted(uploaded, key=lambda x: x["number"]):
        print(f"  {u['number']}번 -> {u['source_image_url'][:90]}")


if __name__ == "__main__":
    main()
