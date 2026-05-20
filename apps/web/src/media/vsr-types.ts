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
