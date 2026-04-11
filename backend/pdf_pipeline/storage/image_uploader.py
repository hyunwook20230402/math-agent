"""크롭된 문제 이미지를 Supabase Storage에 업로드"""
from pathlib import Path
from typing import List, Dict

from storage.supabase_client import get_client

BUCKET = "problem-images"


def upload_page_image(job_id: str, page_num: int, image_path: str) -> str:
  """원본 페이지 이미지를 Supabase Storage에 업로드하고 public URL 반환

  Args:
    job_id: 작업 ID
    page_num: 페이지 번호 (1-based)
    image_path: 로컬 이미지 경로

  Returns:
    public URL
  """
  client = get_client()
  storage_path = f"page_images/{job_id}/page_{page_num:03d}.png"

  with open(image_path, "rb") as f:
    file_bytes = f.read()

  client.storage.from_(BUCKET).upload(
    path=storage_path,
    file=file_bytes,
    file_options={"content-type": "image/png", "upsert": "true"},
  )

  return client.storage.from_(BUCKET).get_public_url(storage_path)


def upload_replacement_image(image_bytes: bytes, staging_id: str, job_id: str) -> str:
  """개별 문제 이미지를 교체 업로드하고 public URL 반환

  Args:
    image_bytes: 이미지 바이너리
    staging_id: staging 레코드 ID
    job_id: 작업 ID (Storage 경로 구분용)

  Returns:
    새 이미지의 public URL
  """
  client = get_client()
  storage_path = f"staging/{job_id}/{staging_id}_replaced.png"

  client.storage.from_(BUCKET).upload(
    path=storage_path,
    file=image_bytes,
    file_options={"content-type": "image/png", "upsert": "true"},
  )

  return client.storage.from_(BUCKET).get_public_url(storage_path)


def upload_cropped_images(cropped_items: List[Dict], job_id: str) -> List[Dict]:
  """크롭된 이미지를 Supabase Storage problem-images 버킷에 업로드

  Args:
    cropped_items: [{"number": 38, "cropped_path": "...", "page": 1}, ...]
    job_id: 작업 ID (Storage 경로 구분용)

  Returns:
    각 item에 source_image_url 추가하여 반환
  """
  client = get_client()
  results = []

  for item in cropped_items:
    file_path = item["cropped_path"]
    filename = Path(file_path).name
    storage_path = f"staging/{job_id}/{filename}"

    with open(file_path, "rb") as f:
      file_bytes = f.read()

    client.storage.from_(BUCKET).upload(
      path=storage_path,
      file=file_bytes,
      file_options={"content-type": "image/png", "upsert": "true"},
    )

    public_url = client.storage.from_(BUCKET).get_public_url(storage_path)

    results.append({
      **item,
      "source_image_url": public_url,
    })

  return results
