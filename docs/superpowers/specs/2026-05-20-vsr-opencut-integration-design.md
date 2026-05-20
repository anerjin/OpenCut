# VSR × OpenCut 통합 설계

**날짜:** 2026-05-20  
**상태:** 승인됨 (Phase 1 - 실험적 기능)
**범위:** video-subtitle-remover를 OpenCut 에디터에 자막 제거 기능으로 통합

> **Phase 1 범위:** 로컬 개발 / 셀프호스팅 전용. Cloudflare Workers 배포 환경 미지원.  
> 실험적 기능으로, 영상 길이에 따라 수 분 소요될 수 있음. 처리 중 탭을 닫지 말 것.

---

## 1. 목표

OpenCut 미디어 패널에서 영상 파일 우클릭 시 "자막 제거" 메뉴를 통해 AI 기반 하드코딩 자막 제거(VSR)를 실행하고, 결과 영상을 새 미디어 에셋으로 추가한다.

---

## 2. 아키텍처 개요

```
[OpenCut 미디어 패널 - MediaItemWithContextMenu]
  우클릭 → "자막 제거 (실험적)"
      │
      ▼
  vsr-service.ts
  storageService에서 영상 Blob 읽기
      │
      ▼
  POST /api/vsr/remove-subtitles   (Next.js 프록시 API, better-auth 세션 필요)
      │
      ▼
  VSR FastAPI 서버  ${VSR_BASE_URL:-localhost:8001}
    PaddleOCR → 자막 영역 감지
    AI Inpainting (sttn-auto) → 영역 채우기 (CPU: 수 분, GPU: 수십 초)
      │
      ▼
  결과 영상 Blob 반환
      │
      ▼
  processMediaAssets() → storageService 쿼터 검사 → 새 에셋 등록
  "{원본명}_no_sub.mp4" 미디어 패널에 하이라이트
```

**배포 제약:**
- Phase 1은 Docker 로컬 실행 전용
- OpenCut Cloudflare Workers 배포 시 VSR 기능 미노출 (`VSR_BASE_URL` 미설정 시 메뉴 숨김)

---

## 3. 컴포넌트 목록

### 3.1 VSR 서버 (신규)

**위치:** `ShortFactory/opencut/vsr-server/`

| 파일 | 역할 |
|---|---|
| `main.py` | FastAPI 앱. `/health`, `/remove-subtitles` 엔드포인트 |
| `requirements.txt` | `fastapi`, `uvicorn`, `python-multipart` |
| `Dockerfile` | Python 3.12-slim 기반, CPU 전용 (Mac/Linux 범용) |

**엔드포인트:**

```
GET  /health
  → 200 { "status": "ok", "model": "sttn-auto" }

POST /remove-subtitles
  Content-Type: multipart/form-data
  Body: file (video/*, max 500MB)
  → 200 video/mp4 (binary stream)
  → 400 { "error": "unsupported_type" }
  → 500 { "error": "processing_failed", "detail": "..." }
```

**처리 흐름:**
1. 업로드 파일을 `/tmp/vsr/{uuid}/input.mp4`에 저장
2. VSR을 FastAPI 내에서 직접 import (모델 워밍업 1회만 발생)
3. 동시 요청 제한: `asyncio.Semaphore(1)` — 1개씩 순차 처리
4. 처리 완료 후 `FileResponse(output_path)` 반환
5. `/tmp/vsr/{uuid}/` cleanup (성공/실패 모두)

**성능 기대치 (CPU 기준):**
- 30초 영상: ~3-10분
- 3분 영상: ~30-60분
- → Phase 1에서는 **30초 이하 영상 권장** 명시

---

### 3.2 docker-compose.yml 수정

```yaml
vsr:
  build: ./vsr-server
  ports:
    - "8001:8001"
  environment:
    - VSR_SOURCE=/app/vsr
  volumes:
    - ./vsr-server/vsr:/app/vsr
    - /tmp/vsr-work:/tmp/vsr
  profiles: ["vsr"]
```

실행: `docker compose --profile vsr up vsr --build`

**환경변수:** `NEXT_PUBLIC_VSR_BASE_URL=http://localhost:8001` (`.env.local`에 추가)  
→ 미설정 시 "자막 제거" 메뉴 숨김 처리

---

### 3.3 Next.js API 라우트 (신규)

**위치:** `apps/web/src/app/api/vsr/`

| 파일 | 역할 |
|---|---|
| `remove-subtitles/route.ts` | 영상 수신 → VSR 프록시 → 결과 반환 |
| `health/route.ts` | VSR 서버 상태 확인 |

**Zod 스키마 (계약 우선 정의):**
```typescript
// shared contract
const vsrHealthResponseSchema = z.object({
  status: z.enum(["ok", "error"]),
  model: z.string().optional(),
});

const vsrErrorResponseSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
```

**route.ts 핵심:**
- `better-auth` 세션 검증 필수 (미인증 시 401 반환)
- 파일 크기 제한: 500MB
- 파일 타입 검증: `video/*`만 허용
- 타임아웃: Node.js 서버 기본값 활용 (로컬 개발이므로 제한 없음)
- VSR 응답을 `Response`로 스트리밍 반환

---

### 3.4 OpenCut 프론트엔드 수정

**신규 파일:** `apps/web/src/media/vsr-service.ts`

```typescript
export async function removeSubtitles(assetBlob: Blob, filename: string): Promise<Blob>
export async function checkVsrHealth(): Promise<boolean>
export function isVsrEnabled(): boolean  // NEXT_PUBLIC_VSR_BASE_URL 설정 여부
```

**수정 파일:** `apps/web/src/components/editor/panels/assets/views/assets.tsx`

수정 위치: `MediaItemWithContextMenu` 컴포넌트 내 ContextMenuContent
- `isVsrEnabled() && item.type === "video"` 조건부로 메뉴 항목 노출
- 메뉴 텍스트: `자막 제거 (실험적)`
- 클릭 시 `handleRemoveSubtitles(item)` 호출

**handleRemoveSubtitles 흐름:**

```
1. checkVsrHealth() → false 시 toast.error("VSR 서버 미실행. docker compose --profile vsr up 실행 후 재시도")
2. storageService에서 asset Blob 읽기
3. storageService 쿼터 사전 확인 (Blob.size 기준)
   → 부족 시 toast.error("저장 공간 부족. 기존 미디어를 삭제 후 재시도")
4. toast.loading("자막 제거 중... (수 분 소요될 수 있습니다. 탭을 닫지 마세요.)", { duration: Infinity })
5. removeSubtitles(blob, asset.name) 호출
6. 결과 Blob → new File([blob], `${basename}_no_sub.mp4`, { type: "video/mp4" })
7. processMediaAssets({ files: [resultFile] }) → editor.media.addMediaAsset(...)
8. highlightMediaId(newAsset.id)
9. toast.dismiss() + toast.success("자막 제거 완료: ${basename}_no_sub.mp4")
```

---

## 4. 에러 처리

| 상황 | 사용자 메시지 |
|---|---|
| VSR 서버 미실행 | "VSR 서버가 실행되지 않았습니다. `docker compose --profile vsr up` 실행 후 재시도" |
| 처리 실패 | "자막 제거 실패: {detail}" |
| 파일 타입 오류 | 메뉴 자체가 비디오 에셋에만 노출 (UI 차단) |
| 저장 공간 부족 | "저장 공간 부족. 기존 미디어를 삭제 후 재시도" |
| 네트워크 오류 | "서버 연결 오류. VSR 서버 상태를 확인해주세요." |
| VSR 미설정 | 메뉴 항목 미노출 (`NEXT_PUBLIC_VSR_BASE_URL` 미설정 시) |

---

## 5. 실행 순서 (로컬 개발)

```bash
# 1. VSR 저장소 클론
git clone https://github.com/YaoFANGUK/video-subtitle-remover vsr-server/vsr

# 2. .env.local에 추가
echo "NEXT_PUBLIC_VSR_BASE_URL=http://localhost:8001" >> apps/web/.env.local

# 3. VSR 서비스 빌드 & 실행
docker compose --profile vsr up vsr --build

# 4. OpenCut dev 서버 (기존)
bun run dev:web
```

---

## 6. 구현 단계

백엔드(1-3)와 프론트엔드(4-5)는 Zod 계약 스키마(0) 완료 후 병렬 진행.

| 단계 | 담당 | 내용 |
|---|---|---|
| 0 | 아키텍트 | Zod 계약 스키마 정의 (shared types) |
| 1 | 백엔드 | `vsr-server/` FastAPI 서버 + Dockerfile |
| 2 | 백엔드 | docker-compose.yml vsr 서비스 추가 |
| 3 | 백엔드 | Next.js `/api/vsr/` 라우트 (auth + proxy) |
| 4 | 프론트엔드 | `vsr-service.ts` + `isVsrEnabled()` |
| 5 | 프론트엔드 | `assets.tsx` `MediaItemWithContextMenu` 메뉴 추가 |
| 6 | 검증 | 30초 이하 자막 영상으로 로컬 E2E 스모크 테스트 |

---

## 7. 비기능 요구사항

- VSR 미설치/미실행 시 OpenCut 정상 동작 (`profiles` + env var 격리)
- 기존 미디어 에셋 변경 없음 (원본 보존)
- 처리 중 에디터 다른 기능 사용 가능 (비동기 fetch)
- Phase 1 한계: 30초 이하 영상 권장, CPU 3-10분 소요 명시

---

## 8. Phase 2 고려사항 (채택률 확인 후)

- 비동기 잡 모델 (POST → jobId, GET poll progress)
- SSE 기반 프레임별 진행률 표시
- 잡 취소 (DELETE /jobs/{id})
- GPU/MPS 지원 Dockerfile 분리
- 동시 잡 큐 (현재: Semaphore(1) 단순 차단)
