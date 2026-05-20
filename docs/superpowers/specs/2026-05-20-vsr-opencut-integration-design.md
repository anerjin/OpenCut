# VSR × OpenCut 통합 설계

**날짜:** 2026-05-20  
**상태:** 승인됨  
**범위:** video-subtitle-remover를 OpenCut 에디터에 자막 제거 기능으로 통합

---

## 1. 목표

OpenCut 미디어 패널에서 영상 파일 우클릭 시 "자막 제거" 메뉴를 통해 AI 기반 하드코딩 자막 제거(video-subtitle-remover, VSR)를 실행하고, 결과 영상을 새 미디어 에셋으로 추가한다.

---

## 2. 아키텍처 개요

```
[OpenCut 미디어 패널]
  우클릭 → "자막 제거"
      │
      ▼
  vsr-service.ts
  IndexedDB에서 영상 Blob 읽기
      │
      ▼
  POST /api/vsr/remove-subtitles   (Next.js 프록시 API)
      │
      ▼
  VSR FastAPI 서버  localhost:8001
    PaddleOCR → 자막 영역 감지
    AI Inpainting (sttn-auto) → 영역 채우기
      │
      ▼
  결과 영상 Blob 반환
      │
      ▼
  processMediaAssets() → 새 에셋 등록
  "{원본명}_no_sub.mp4" 미디어 패널에 하이라이트
```

---

## 3. 컴포넌트 목록

### 3.1 VSR 서버 (신규)

**위치:** `ShortFactory/opencut/vsr-server/`

| 파일 | 역할 |
|---|---|
| `main.py` | FastAPI 앱. `/health`, `/remove-subtitles` 엔드포인트 |
| `requirements.txt` | `fastapi`, `uvicorn`, `python-multipart`, `httpx` |
| `Dockerfile` | Python 3.12-slim 기반 |

**설계 원칙:**
- VSR 코드를 직접 import하지 않고 CLI 서브프로세스로 호출
- `vsr/` 디렉토리를 Docker 볼륨으로 마운트 (코드 변경 불필요)
- 임시 파일: `/tmp/vsr/{job_id}/` 패턴으로 격리

**엔드포인트:**

```
GET  /health
  → 200 { "status": "ok" }

POST /remove-subtitles
  Content-Type: multipart/form-data
  Body: file (video/*)
  → 200 binary (processed video)
  → 500 { "error": "..." }
```

**처리 흐름 (main.py):**
1. 업로드된 파일을 `/tmp/vsr/{uuid}/input.mp4`에 저장
2. `subprocess.run(["python", "vsr/backend/main.py", "-i", input, "-o", output, "--inpaint-mode", "sttn-auto"])`
3. output 파일을 FileResponse로 반환
4. `/tmp/vsr/{uuid}/` 정리

---

### 3.2 docker-compose.yml 수정

`vsr` 서비스를 `profiles: ["vsr"]`로 추가하여 기본 실행에 영향 없음.

```yaml
vsr:
  build: ./vsr-server
  ports:
    - "8001:8001"
  volumes:
    - ./vsr-server/vsr:/app/vsr
    - /tmp/vsr-work:/tmp/vsr
  profiles: ["vsr"]
```

실행: `docker compose --profile vsr up vsr`

---

### 3.3 Next.js API 라우트 (신규)

**위치:** `apps/web/src/app/api/vsr/`

| 파일 | 역할 |
|---|---|
| `remove-subtitles/route.ts` | 영상 수신 → VSR 프록시 → 결과 반환 |
| `health/route.ts` | VSR 서버 상태 확인 |

**route.ts 핵심 로직:**
- `maxDuration = 300` (5분 타임아웃)
- FormData 그대로 VSR에 전달
- VSR 응답 binary를 그대로 클라이언트로 스트리밍

---

### 3.4 OpenCut 프론트엔드 수정

**신규 파일:** `apps/web/src/media/vsr-service.ts`

```typescript
export async function removeSubtitles(asset: MediaAsset): Promise<Blob>
export async function checkVsrHealth(): Promise<boolean>
```

**수정 파일:** `apps/web/src/components/editor/panels/assets/views/assets.tsx`

- 비디오 에셋 우클릭 ContextMenu에 `<ContextMenuItem>자막 제거</ContextMenuItem>` 추가
- 비디오 타입(`video/*`)인 경우에만 노출
- 클릭 시 `handleRemoveSubtitles(asset)` 호출

**handleRemoveSubtitles 흐름:**
1. `checkVsrHealth()` → 실패 시 `toast.error("VSR 서버 미실행...")`
2. `toast.loading("자막 제거 중...")` 표시
3. `removeSubtitles(asset)` 호출
4. 결과 Blob → `new File([blob], "${asset.name}_no_sub.mp4")`
5. `processMediaAssets({ files: [resultFile] })`
6. `highlightMediaId(newAssetId)`
7. `toast.success("자막 제거 완료")`

---

## 4. 에러 처리

| 상황 | 사용자에게 표시 |
|---|---|
| VSR 서버 미실행 | `toast.error("VSR 서버가 실행되지 않았습니다. docker compose --profile vsr up 실행 후 재시도")` |
| 처리 실패 (VSR 내부 오류) | `toast.error("자막 제거 실패: {reason}")` |
| 타임아웃 | `toast.error("처리 시간이 초과되었습니다. 짧은 영상으로 먼저 시도해보세요.")` |
| 비디오 아닌 파일 선택 | 메뉴 항목 자체를 비디오 에셋에만 표시하여 원천 차단 |

---

## 5. 실행 순서 (로컬 개발)

```bash
# 1. VSR 저장소 클론 (vsr-server 디렉토리 내)
git clone https://github.com/YaoFANGUK/video-subtitle-remover vsr-server/vsr

# 2. VSR 서비스 빌드 & 실행
docker compose --profile vsr up vsr --build

# 3. OpenCut dev 서버 실행 (기존)
bun run dev:web
```

---

## 6. 구현 단계

| 단계 | 담당 | 내용 |
|---|---|---|
| 1 | 백엔드 | `vsr-server/` FastAPI 서버 구현 + Dockerfile |
| 2 | 백엔드 | docker-compose.yml vsr 서비스 추가 |
| 3 | 백엔드 | Next.js `/api/vsr/` 라우트 구현 |
| 4 | 프론트엔드 | `vsr-service.ts` 구현 |
| 5 | 프론트엔드 | `assets.tsx` 우클릭 메뉴 추가 |
| 6 | 검증 | 로컬 E2E 테스트 (짧은 자막 영상 기준) |

백엔드(1-3)와 프론트엔드(4-5)는 병렬 진행 가능.

---

## 7. 비기능 요구사항

- VSR 미설치 시 OpenCut 정상 동작에 영향 없음 (`profiles` 격리)
- 기존 미디어 에셋 데이터 변경 없음 (원본 보존)
- 처리 중 다른 에디터 기능 정상 사용 가능 (비동기 처리)
