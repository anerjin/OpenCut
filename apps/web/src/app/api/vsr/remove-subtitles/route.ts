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
