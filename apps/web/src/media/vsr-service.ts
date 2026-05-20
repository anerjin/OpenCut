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
