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
