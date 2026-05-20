# vsr-server/main.py
import asyncio
import os
import shutil
import subprocess
import uuid
from pathlib import Path

from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse

app = FastAPI(title="VSR Server", version="1.0.0")

WORK_DIR = Path(os.environ.get("VSR_WORK_DIR", "/tmp/vsr"))
VSR_SOURCE = Path(os.environ.get("VSR_SOURCE", "/app/vsr"))
INPAINT_MODE = os.environ.get("VSR_INPAINT_MODE", "sttn-auto")
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500MB
PROCESS_TIMEOUT = int(os.environ.get("VSR_TIMEOUT_SECONDS", "3600"))  # 1시간

# 동시 처리 1개 제한 (OOM 방지)
_semaphore = asyncio.Semaphore(1)


@app.get("/health")
async def health():
    vsr_main = VSR_SOURCE / "backend" / "main.py"
    vsr_ready = vsr_main.exists()
    return {
        "status": "ok" if vsr_ready else "error",
        "model": INPAINT_MODE,
        "vsr_ready": vsr_ready,
    }


def _run_vsr(input_path: Path, output_path: Path) -> subprocess.CompletedProcess:
    """블로킹 subprocess 실행 — run_in_executor에서 호출."""
    vsr_main = VSR_SOURCE / "backend" / "main.py"
    return subprocess.run(
        [
            "python",
            str(vsr_main),
            "-i", str(input_path),
            "-o", str(output_path),
            "--inpaint-mode", INPAINT_MODE,
        ],
        capture_output=True,
        text=True,
        cwd=str(VSR_SOURCE),
        timeout=PROCESS_TIMEOUT,
    )


@app.post("/remove-subtitles")
async def remove_subtitles(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
):
    # 파일 타입 검증
    content_type = file.content_type or ""
    if not content_type.startswith("video/"):
        raise HTTPException(status_code=400, detail="video/* 파일만 허용됩니다.")

    # VSR 소스 존재 확인
    vsr_main = VSR_SOURCE / "backend" / "main.py"
    if not vsr_main.exists():
        raise HTTPException(
            status_code=503,
            detail=(
                f"VSR 소스를 찾을 수 없습니다: {vsr_main}. "
                "vsr-server/vsr/ 에 video-subtitle-remover 를 클론해주세요."
            ),
        )

    job_id = str(uuid.uuid4())
    job_dir = WORK_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    input_path = job_dir / "input.mp4"
    output_path = job_dir / "output.mp4"

    try:
        # 파일 크기 체크하며 저장
        written = 0
        with open(input_path, "wb") as f:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > MAX_FILE_SIZE:
                    raise HTTPException(
                        status_code=413, detail="파일 크기가 500MB를 초과합니다."
                    )
                f.write(chunk)

        # Semaphore로 동시 처리 제한 + thread pool에서 실행
        async with _semaphore:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None, _run_vsr, input_path, output_path
            )

        if result.returncode != 0:
            stderr = result.stderr[-1000:] if result.stderr else "알 수 없는 오류"
            raise HTTPException(status_code=500, detail=f"VSR 처리 실패: {stderr}")

        if not output_path.exists():
            raise HTTPException(
                status_code=500, detail="출력 파일이 생성되지 않았습니다."
            )

        # 응답 전송 완료 후 BackgroundTasks로 cleanup (best-effort)
        background_tasks.add_task(shutil.rmtree, str(job_dir), True)

        return FileResponse(
            path=str(output_path),
            media_type="video/mp4",
            filename="output.mp4",
        )

    except HTTPException:
        shutil.rmtree(str(job_dir), ignore_errors=True)
        raise
    except Exception as e:
        shutil.rmtree(str(job_dir), ignore_errors=True)
        raise HTTPException(status_code=500, detail=str(e)) from e


if __name__ == "__main__":
    import uvicorn
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    uvicorn.run(app, host="0.0.0.0", port=8001)
