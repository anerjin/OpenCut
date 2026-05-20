# VSR × OpenCut 자막 제거 통합 구현 계획

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** OpenCut 미디어 패널 비디오 에셋 우클릭 메뉴에 "자막 제거 (실험적)" 기능을 추가하여 VSR AI 서버와 연동한다.

**Architecture:** VSR FastAPI 서버(포트 8001)를 Docker profile로 격리 실행. VSR은 CLI subprocess (`python backend/main.py`)로 호출하되 `run_in_executor`로 이벤트 루프 블로킹 방지. Next.js API 프록시(`/api/vsr/*`)는 내부 URL(`VSR_INTERNAL_URL`)로 VSR에 접근. 브라우저는 `NEXT_PUBLIC_VSR_BASE_URL`로 기능 노출 여부만 판단.

**Tech Stack:** Python 3.12 + FastAPI + uvicorn (VSR 서버), Next.js App Router API routes (프록시), React + Sonner toast + Zod (프론트엔드)

**Spec:** `docs/superpowers/specs/2026-05-20-vsr-opencut-integration-design.md`

**병렬 실행:** Chunk 1 완료 후 → Chunk 2(백엔드 서버)와 Chunk 4(프론트엔드)를 병렬 진행. Chunk 3(Next.js API)은 Chunk 2 완료 후.

---

## File Map

| 상태 | 경로 | 책임 |
|---|---|---|
| CREATE | `vsr-server/main.py` | FastAPI 앱, /health + /remove-subtitles, subprocess + executor |
| CREATE | `vsr-server/requirements.txt` | FastAPI 서버 Python 의존성 (VSR 의존성 제외) |
| CREATE | `vsr-server/Dockerfile` | Python 3.12-slim + ffmpeg + OpenCV 시스템 의존성 |
| CREATE | `vsr-server/.gitignore` | vsr/ 소스 디렉토리 추적 제외 |
| MODIFY | `docker-compose.yml` | vsr 서비스 추가 (profiles: vsr) |
| MODIFY | `apps/web/.env.local` | VSR 환경변수 추가 (git 추적 제외) |
| MODIFY | `apps/web/.env.example` | VSR 환경변수 주석 예시 추가 |
| CREATE | `apps/web/src/media/vsr-types.ts` | Zod 계약 스키마 (공유 타입) |
| CREATE | `apps/web/src/app/api/vsr/health/route.ts` | VSR 헬스체크 프록시 |
| CREATE | `apps/web/src/app/api/vsr/remove-subtitles/route.ts` | VSR 처리 프록시 |
| CREATE | `apps/web/src/media/vsr-service.ts` | 클라이언트 VSR API 호출 |
| MODIFY | `apps/web/src/components/editor/panels/assets/views/assets.tsx` | MediaItemWithContextMenu 메뉴 추가 |

---

## Chunk 1: 계약 스키마 + 환경 설정 (아키텍트)

### Task 1: Zod 계약 스키마 정의

**Files:**
- Create: `apps/web/src/media/vsr-types.ts`

- [ ] **Step 1: 파일 생성**

```typescript
// apps/web/src/media/vsr-types.ts
import { z } from "zod";

export const vsrHealthResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  model: z.string().optional(),
  vsr_ready: z.boolean().optional(),
});

export const vsrErrorResponseSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});

export type VsrHealthResponse = z.infer<typeof vsrHealthResponseSchema>;
export type VsrErrorResponse = z.infer<typeof vsrErrorResponseSchema>;

export const VSR_MAX_FILE_SIZE_BYTES = 500 * 1024 * 1024; // 500MB
```

- [ ] **Step 2: TypeScript 타입 에러 없는지 확인**

```bash
cd apps/web && bunx tsc --noEmit --skipLibCheck 2>&1 | grep "vsr-types" || echo "OK"
```

Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add apps/web/src/media/vsr-types.ts
git commit -m "feat(vsr): Zod 계약 스키마 정의"
```

---

### Task 2: 환경변수 추가

**Files:**
- Modify: `apps/web/.env.local` (git 추적 안 함)
- Modify: `apps/web/.env.example`

- [ ] **Step 1: .env.local에 VSR URL 추가**

`apps/web/.env.local` 파일 끝에 추가 (파일이 없으면 먼저 `.env.example` 복사):

```
# VSR (Video Subtitle Remover) - 로컬 Docker 서비스
# docker compose --profile vsr up 실행 시에만 활성화
NEXT_PUBLIC_VSR_BASE_URL=http://localhost:8001
VSR_INTERNAL_URL=http://localhost:8001
```

> **Note:** Docker로 web 컨테이너를 실행하는 경우 `VSR_INTERNAL_URL=http://vsr:8001` 로 변경 필요 (Docker 내부 서비스 DNS).

- [ ] **Step 2: .env.example에도 동일한 항목 추가 (신규 기여자 위해)**

`apps/web/.env.example` 파일 끝에 추가:

```
# VSR (Video Subtitle Remover) - optional, requires docker compose --profile vsr up
# NEXT_PUBLIC_VSR_BASE_URL=http://localhost:8001
# VSR_INTERNAL_URL=http://localhost:8001
```

- [ ] **Step 3: 확인**

```bash
grep "VSR" apps/web/.env.local
```

Expected: 두 줄 모두 출력

- [ ] **Step 4: .env.example만 커밋 (.env.local은 gitignored)**

```bash
git add apps/web/.env.example
git commit -m "feat(vsr): VSR 환경변수 예시 추가 (.env.example)"
```

---

## Chunk 2: 백엔드 — VSR FastAPI 서버

### Task 3: Python 의존성 정의

**Files:**
- Create: `vsr-server/requirements.txt`

- [ ] **Step 1: 파일 생성**

```
# vsr-server/requirements.txt
# FastAPI HTTP 레이어 의존성 (VSR 자체 의존성은 vsr-server/vsr/ 별도 설치)
fastapi==0.115.0
uvicorn[standard]==0.30.6
python-multipart==0.0.12
```

- [ ] **Step 2: 커밋**

```bash
git add vsr-server/requirements.txt
git commit -m "feat(vsr): FastAPI 서버 의존성 정의"
```

---

### Task 4: FastAPI 서버 구현

**Files:**
- Create: `vsr-server/main.py`

> **설계 결정:** VSR을 CLI subprocess로 호출 (in-process import 시 PaddleOCR/PyTorch가 FastAPI 프로세스에 로드되어 충돌 위험 + 메모리 격리 불가). `asyncio.to_thread` 대신 `run_in_executor`로 이벤트 루프 블로킹 방지. `Semaphore(1)`로 동시 처리 1개 제한.
> VSR CLI: `python backend/main.py -i <input> -o <output> --inpaint-mode sttn-auto`

- [ ] **Step 1: main.py 작성**

```python
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
```

- [ ] **Step 2: 문법 확인 (Python 설치된 경우)**

```bash
python -m py_compile vsr-server/main.py && echo "OK" || echo "SKIP (python not available locally)"
```

- [ ] **Step 3: 커밋**

```bash
git add vsr-server/main.py
git commit -m "feat(vsr): FastAPI 서버 구현 (/health, /remove-subtitles + executor)"
```

---

### Task 5: Dockerfile 작성

**Files:**
- Create: `vsr-server/Dockerfile`

> VSR 자체 Python 의존성(PaddleOCR, PyTorch 등)은 볼륨으로 마운트된 `vsr/` 디렉토리에서 컨테이너 빌드 시 설치.

- [ ] **Step 1: Dockerfile 작성**

```dockerfile
# vsr-server/Dockerfile
FROM python:3.12-slim

WORKDIR /app

# 시스템 의존성 (VSR + OpenCV 필요)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libgl1 \
    libglib2.0-0 \
    libsm6 \
    libxext6 \
    libxrender1 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# FastAPI 서버 의존성
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# VSR Python 의존성 (vsr/ 가 볼륨 마운트 전에는 없으므로 런타임에 설치 필요)
# 런타임 설치는 entrypoint에서 처리: 빌드 시에는 FastAPI만 설치
# 실제 컨테이너 시작 후 최초 1회: docker exec vsr pip install -r /app/vsr/requirements.txt

COPY main.py .

EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
    CMD curl -f http://localhost:8001/health || exit 1

CMD ["python", "main.py"]
```

- [ ] **Step 2: 커밋**

```bash
git add vsr-server/Dockerfile
git commit -m "feat(vsr): Dockerfile 작성 (Python 3.12-slim + ffmpeg + OpenCV deps)"
```

---

### Task 6: docker-compose.yml에 vsr 서비스 추가

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: `services:` 블록 안에 기존 web 서비스 뒤, 최상위 `volumes:` 키 앞에 vsr 서비스 추가**

현재 파일의 `volumes:` 최상위 키(line 85)는 `services:` 블록과 같은 레벨. 아래 YAML은 `services:` 블록 안에 들어가야 함 (2-space indent):

```yaml
  vsr:
    build: ./vsr-server
    ports:
      - "8001:8001"
    environment:
      - VSR_SOURCE=/app/vsr
      - VSR_WORK_DIR=/tmp/vsr
      - VSR_INPAINT_MODE=sttn-auto
      - VSR_TIMEOUT_SECONDS=3600
    volumes:
      - ./vsr-server/vsr:/app/vsr:ro
    profiles: ["vsr"]
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8001/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s
```

> `/tmp/vsr` 볼륨 마운트 생략 — 컨테이너 내부 ephemeral 공간으로 충분. 재시작 시 정리됨.

- [ ] **Step 2: docker-compose 유효성 확인**

```bash
docker compose config --quiet && echo "OK"
```

Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add docker-compose.yml
git commit -m "feat(vsr): docker-compose에 vsr 서비스 추가 (profiles: vsr)"
```

---

## Chunk 3: 백엔드 — Next.js API 프록시

### Task 7: VSR health API 라우트

**Files:**
- Create: `apps/web/src/app/api/vsr/health/route.ts`

> **URL 전략:** 서버사이드 fetch는 `VSR_INTERNAL_URL` 환경변수 사용 (Docker 내부: `http://vsr:8001`, 로컬 dev: `http://localhost:8001`).

- [ ] **Step 1: 디렉토리 생성 및 파일 작성**

```bash
mkdir -p apps/web/src/app/api/vsr/health
```

```typescript
// apps/web/src/app/api/vsr/health/route.ts
import { type NextRequest, NextResponse } from "next/server";
import { vsrHealthResponseSchema } from "@/media/vsr-types";

const VSR_INTERNAL_URL =
  process.env.VSR_INTERNAL_URL ?? "http://localhost:8001";

export async function GET(_request: NextRequest) {
  try {
    const res = await fetch(`${VSR_INTERNAL_URL}/health`, {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });

    if (!res.ok) {
      return NextResponse.json({ status: "error" }, { status: res.status });
    }

    const parsed = vsrHealthResponseSchema.safeParse(await res.json());
    if (!parsed.success) {
      return NextResponse.json({ status: "error" }, { status: 502 });
    }

    return NextResponse.json(parsed.data);
  } catch {
    return NextResponse.json(
      { status: "error", detail: "VSR 서버에 연결할 수 없습니다." },
      { status: 503 },
    );
  }
}
```

- [ ] **Step 2: 타입 확인**

```bash
cd apps/web && bunx tsc --noEmit --skipLibCheck 2>&1 | grep "vsr/health" || echo "OK"
```

Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add apps/web/src/app/api/vsr/health/route.ts
git commit -m "feat(vsr): Next.js /api/vsr/health 프록시 라우트"
```

---

### Task 8: VSR remove-subtitles API 라우트

**Files:**
- Create: `apps/web/src/app/api/vsr/remove-subtitles/route.ts`

> **Auth 결정:** 기존 API 라우트(`/api/sounds/search/route.ts` 등) 패턴에 따라 `checkRateLimit`만 사용. Phase 1은 로컬 개발 전용이므로 better-auth 세션 검증은 생략.
> **maxDuration:** CPU 기준 30초 영상 = 3~10분 소요 → 3600초(1시간)로 설정.

- [ ] **Step 1: 디렉토리 생성 및 파일 작성**

```bash
mkdir -p apps/web/src/app/api/vsr/remove-subtitles
```

```typescript
// apps/web/src/app/api/vsr/remove-subtitles/route.ts
import { type NextRequest, NextResponse } from "next/server";
import { VSR_MAX_FILE_SIZE_BYTES } from "@/media/vsr-types";
import { checkRateLimit } from "@/auth/rate-limit";

const VSR_INTERNAL_URL =
  process.env.VSR_INTERNAL_URL ?? "http://localhost:8001";

export const dynamic = "force-dynamic";
export const maxDuration = 3600; // VSR CPU 처리 최대 1시간

export async function POST(request: NextRequest) {
  // Rate limit (기존 API 라우트 패턴과 일관성 유지)
  const { limited } = await checkRateLimit({ request });
  if (limited) {
    return NextResponse.json({ error: "Too many requests" }, { status: 429 });
  }

  // Content-Type 검증
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json(
      { error: "multipart/form-data 요청만 허용됩니다." },
      { status: 400 },
    );
  }

  // FormData 파싱
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "FormData 파싱 실패" }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "file 필드가 없거나 올바르지 않습니다." },
      { status: 400 },
    );
  }

  // 파일 타입 검증
  if (!file.type.startsWith("video/")) {
    return NextResponse.json(
      { error: "video/* 파일만 허용됩니다." },
      { status: 400 },
    );
  }

  // 파일 크기 검증
  if (file.size > VSR_MAX_FILE_SIZE_BYTES) {
    return NextResponse.json(
      { error: "파일 크기가 500MB를 초과합니다." },
      { status: 413 },
    );
  }

  // VSR로 포워딩
  const vsrForm = new FormData();
  vsrForm.append("file", file);

  try {
    const vsrRes = await fetch(`${VSR_INTERNAL_URL}/remove-subtitles`, {
      method: "POST",
      body: vsrForm,
    });

    // VSR 에러 응답 처리 (JSON vs binary 구분)
    const responseContentType = vsrRes.headers.get("content-type") ?? "";
    if (!vsrRes.ok || !responseContentType.includes("video/")) {
      const errText = await vsrRes.text();
      let detail = errText;
      try {
        const errJson = JSON.parse(errText);
        detail = errJson.detail ?? errJson.error ?? errText;
      } catch {
        // JSON 파싱 실패 시 원문 사용
      }
      return NextResponse.json(
        { error: "VSR 처리 실패", detail },
        { status: vsrRes.status || 500 },
      );
    }

    // 결과 binary 반환
    const resultBlob = await vsrRes.blob();
    return new NextResponse(resultBlob, {
      status: 200,
      headers: {
        "Content-Type": "video/mp4",
        "Content-Disposition": 'attachment; filename="output.mp4"',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "알 수 없는 오류";
    return NextResponse.json(
      { error: "VSR 서버 연결 실패", detail: message },
      { status: 503 },
    );
  }
}
```

- [ ] **Step 2: 타입 확인**

```bash
cd apps/web && bunx tsc --noEmit --skipLibCheck 2>&1 | grep "remove-subtitles" || echo "OK"
```

Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add apps/web/src/app/api/vsr/remove-subtitles/route.ts
git commit -m "feat(vsr): Next.js /api/vsr/remove-subtitles 프록시 라우트"
```

---

## Chunk 4: 프론트엔드

### Task 9: vsr-service.ts 구현

**Files:**
- Create: `apps/web/src/media/vsr-service.ts`

- [ ] **Step 1: vsr-service.ts 작성**

```typescript
// apps/web/src/media/vsr-service.ts
import { vsrHealthResponseSchema } from "@/media/vsr-types";

/** NEXT_PUBLIC_VSR_BASE_URL 설정 여부로 기능 활성화 판단 */
export function isVsrEnabled(): boolean {
  return !!process.env.NEXT_PUBLIC_VSR_BASE_URL;
}

/** VSR 서버 헬스 확인 (Next.js 프록시 경유) */
export async function checkVsrHealth(): Promise<boolean> {
  try {
    const res = await fetch("/api/vsr/health", {
      signal: AbortSignal.timeout(5000),
      cache: "no-store",
    });
    if (!res.ok) return false;
    const parsed = vsrHealthResponseSchema.safeParse(await res.json());
    return parsed.success && parsed.data.status === "ok";
  } catch {
    return false;
  }
}

/** 자막 제거 요청 (Next.js 프록시 경유) */
export async function removeSubtitles(
  blob: Blob,
  filename: string,
): Promise<Blob> {
  const formData = new FormData();
  const file = new File([blob], filename, { type: blob.type || "video/mp4" });
  formData.append("file", file);

  const res = await fetch("/api/vsr/remove-subtitles", {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail ?? err.error ?? `HTTP ${res.status}`);
    }
    throw new Error(`HTTP ${res.status}`);
  }

  return res.blob();
}
```

- [ ] **Step 2: 타입 확인**

```bash
cd apps/web && bunx tsc --noEmit --skipLibCheck 2>&1 | grep "vsr-service" || echo "OK"
```

Expected: `OK`

- [ ] **Step 3: 커밋**

```bash
git add apps/web/src/media/vsr-service.ts
git commit -m "feat(vsr): vsr-service.ts 클라이언트 API 구현"
```

---

### Task 10: MediaItemWithContextMenu 메뉴 추가

**Files:**
- Modify: `apps/web/src/components/editor/panels/assets/views/assets.tsx`

> **수정 위치:** `assets.tsx:303` `MediaItemWithContextMenu` 컴포넌트
>
> **확인된 API:**
> - `item.file: File` — `MediaAsset`에 직접 포함 (`media/types.ts:7`), storageService 불필요
> - `processMediaAssets({ files, onProgress? }): Promise<ProcessedMediaAsset[]>` — `media/processing.ts:85`
> - `editor.media.addMediaAsset({ projectId, asset }): Promise<MediaAsset | null>` — `core/managers/media-manager.ts:17`
> - `activeProject.metadata.id` — `project.getActive()`가 반환하는 `TProject.metadata.id`
> - `highlightMediaId` — `useAssetsPanelStore()`에서 가져옴 (파일 상단 이미 import됨)
> - `useEditor` — 파일 상단 이미 import됨 (`apps/web/src/editor/use-editor`)
> - `processMediaAssets` — 파일 상단 이미 import됨 (`apps/web/src/media/processing`)

- [ ] **Step 1: 파일 상단 import 블록에 VSR import 추가**

기존 import 블록 끝(line ~60, `HugeiconsIcon` import 뒤)에 추가:

```typescript
import {
  isVsrEnabled,
  checkVsrHealth,
  removeSubtitles,
} from "@/media/vsr-service";
import { readStorageQuotaStatus } from "@/services/storage/quota";
```

- [ ] **Step 2: MediaItemWithContextMenu 함수 내부에 hooks + handler 추가**

`MediaItemWithContextMenu` 함수(line 303) 내 `useSelection` 훅 호출 바로 아래에 추가:

```typescript
  const editor = useEditor();
  const activeProject = useEditor((e) => e.project.getActive());
  const { highlightMediaId } = useAssetsPanelStore();
  const vsrEnabled = isVsrEnabled() && item.type === "video";

  const handleRemoveSubtitles = async () => {
    // 1. VSR 헬스 확인
    const healthy = await checkVsrHealth();
    if (!healthy) {
      toast.error(
        "VSR 서버가 실행되지 않았습니다. docker compose --profile vsr up 실행 후 재시도해주세요.",
      );
      return;
    }

    // 2. 스토리지 쿼터 사전 확인 (item.file은 MediaAsset에 직접 포함)
    const quota = await readStorageQuotaStatus();
    if (quota.availableBytes !== null && item.file.size > quota.availableBytes) {
      toast.error("저장 공간 부족. 기존 미디어를 삭제 후 재시도해주세요.");
      return;
    }

    // 3. 처리 시작 toast
    const toastId = toast.loading(
      "자막 제거 중... (수 분 소요될 수 있습니다. 탭을 닫지 마세요.)",
      { duration: Number.POSITIVE_INFINITY },
    );

    try {
      // 4. VSR 호출 (item.file이 MediaAsset에 직접 포함되어 있음)
      const resultBlob = await removeSubtitles(item.file, item.name);
      const baseName = item.name.replace(/\.[^.]+$/, "");
      const resultFile = new File([resultBlob], `${baseName}_no_sub.mp4`, {
        type: "video/mp4",
      });

      // 5. 새 에셋으로 등록 (processMediaAssets 실제 시그니처 사용)
      const processedAssets = await processMediaAssets({ files: [resultFile] });
      for (const asset of processedAssets) {
        const newAsset = await editor.media.addMediaAsset({
          projectId: activeProject.metadata.id,
          asset,
        });
        if (newAsset) highlightMediaId(newAsset.id);
      }

      toast.dismiss(toastId);
      toast.success(`자막 제거 완료: ${baseName}_no_sub.mp4`);
    } catch (err) {
      toast.dismiss(toastId);
      const message = err instanceof Error ? err.message : "알 수 없는 오류";
      toast.error(`자막 제거 실패: ${message}`);
    }
  };
```

- [ ] **Step 3: ContextMenuContent에 메뉴 항목 추가**

현재 코드 (line 326-336):
```tsx
<ContextMenuContent>
  <ContextMenuItem>Export clips</ContextMenuItem>
  <ContextMenuItem
    variant="destructive"
    onClick={(event: React.MouseEvent<HTMLDivElement>) =>
      onRemove({ event, ids: idsToDelete })
    }
  >
    {deleteLabel}
  </ContextMenuItem>
</ContextMenuContent>
```

변경 후:
```tsx
<ContextMenuContent>
  <ContextMenuItem>Export clips</ContextMenuItem>
  {vsrEnabled && (
    <ContextMenuItem onClick={handleRemoveSubtitles}>
      자막 제거 (실험적)
    </ContextMenuItem>
  )}
  <ContextMenuItem
    variant="destructive"
    onClick={(event: React.MouseEvent<HTMLDivElement>) =>
      onRemove({ event, ids: idsToDelete })
    }
  >
    {deleteLabel}
  </ContextMenuItem>
</ContextMenuContent>
```

- [ ] **Step 4: 타입 에러 확인**

```bash
cd apps/web && bunx tsc --noEmit --skipLibCheck 2>&1 | head -30
```

Expected: 에러 없음 (기존 에러가 있다면 VSR 무관한 기존 에러인지 확인)

- [ ] **Step 5: 커밋**

```bash
git add apps/web/src/components/editor/panels/assets/views/assets.tsx
git commit -m "feat(vsr): MediaItemWithContextMenu에 자막 제거 메뉴 추가"
```

---

## Chunk 5: 검증

### Task 11: VSR 소스 클론 및 .gitignore 설정

- [ ] **Step 1: vsr-server/.gitignore 생성**

```bash
cat > vsr-server/.gitignore << 'EOF'
# VSR 소스 (별도 클론, git 추적 제외)
vsr/
EOF
```

- [ ] **Step 2: VSR 소스 클론**

```bash
git clone https://github.com/YaoFANGUK/video-subtitle-remover vsr-server/vsr
```

- [ ] **Step 3: VSR 의존성 경로 확인**

```bash
ls vsr-server/vsr/requirements.txt 2>/dev/null && echo "requirements 존재" || echo "없음"
```

- [ ] **Step 4: 커밋**

```bash
git add vsr-server/.gitignore
git commit -m "chore(vsr): .gitignore에 vsr/ 소스 제외 설정"
```

---

### Task 12: VSR Python 의존성 설치 및 로컬 스모크 테스트

- [ ] **Step 1: VSR Docker 이미지 빌드**

```bash
docker compose --profile vsr build vsr
```

- [ ] **Step 2: 컨테이너 안에서 VSR Python 의존성 설치 (최초 1회)**

```bash
docker compose --profile vsr up vsr -d
docker compose exec vsr pip install --no-cache-dir -r /app/vsr/requirements.txt
```

> VSR requirements.txt에는 PaddleOCR, PyTorch 등 대용량 패키지 포함. 설치에 수 분 소요.

- [ ] **Step 3: VSR 서비스 상태 확인**

```bash
docker compose logs vsr --tail=20
curl http://localhost:8001/health
```

Expected: `{"status":"ok","model":"sttn-auto","vsr_ready":true}`

- [ ] **Step 4: Next.js 프록시 헬스 확인 (dev 서버 실행 중)**

```bash
curl http://localhost:3000/api/vsr/health
```

Expected: `{"status":"ok",...}`

- [ ] **Step 5: 브라우저 E2E 확인**

1. `http://localhost:3000/projects` 접속
2. 새 프로젝트 생성
3. **30초 이하** 자막 있는 영상 업로드
4. 업로드된 영상 우클릭 → "자막 제거 (실험적)" 메뉴 확인
5. 클릭 → `자막 제거 중...` 로딩 toast 표시 확인
6. 처리 완료 후 `*_no_sub.mp4` 새 에셋 추가 + 하이라이트 확인

- [ ] **Step 6: VSR 미실행 에러 처리 확인**

```bash
docker compose stop vsr
```

브라우저에서 "자막 제거" 클릭 → "VSR 서버가 실행되지 않았습니다" toast 확인

- [ ] **Step 7: 비디오가 아닌 에셋에는 메뉴 미노출 확인**

이미지 파일 업로드 후 우클릭 → "자막 제거" 메뉴 없음 확인

---

## 실행 요약

```bash
# 1. VSR 소스 클론 (최초 1회)
git clone https://github.com/YaoFANGUK/video-subtitle-remover vsr-server/vsr

# 2. VSR Docker 빌드 & 실행
docker compose --profile vsr up vsr --build -d

# 3. VSR Python 의존성 설치 (최초 1회, 컨테이너 안에서)
docker compose exec vsr pip install --no-cache-dir -r /app/vsr/requirements.txt

# 4. OpenCut dev 서버 (별도 터미널)
bun run dev:web

# 5. 브라우저 접속
open http://localhost:3000
```

---

## 주의사항

- `item.file: File` — `MediaAsset`에 직접 포함. storageService 호출 불필요.
- `processMediaAssets` 시그니처: `{ files: FileList | File[], onProgress? }` → `Promise<ProcessedMediaAsset[]>`
- `activeProject.metadata.id` — `.id` 아님 (TProject 구조 참고)
- CPU 기준 30초 영상 = 3~10분 소요 (테스트는 짧은 클립 사용)
- Mac Apple Silicon Docker: CPU 추론만 가능 (MPS 불가)
- VSR 미실행 시 `NEXT_PUBLIC_VSR_BASE_URL` 주석 처리 후 **재빌드** 해야 메뉴 숨김 (Next.js NEXT_PUBLIC_ 변수는 빌드 시 번들링)
- Docker로 web 컨테이너 실행 시 `VSR_INTERNAL_URL=http://vsr:8001` 로 변경
- VSR Python 의존성은 컨테이너 볼륨에 마운트 후 수동 설치 필요 (이미지 재빌드 시 재설치)
