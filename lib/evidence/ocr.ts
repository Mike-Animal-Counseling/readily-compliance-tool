import { z } from "zod";

export const ocrParserVersion = "docling-2.151.1-layout-v1";
const maxOutput = 2 * 1024 * 1024;
const coordinate = z.number().min(0).max(1);
const box = z.object({
  page: z.number().int().min(1).max(30),
  left: coordinate, top: coordinate, right: coordinate, bottom: coordinate,
}).refine(value => value.left < value.right && value.top < value.bottom);
const text = z.string().max(8192).refine(value => !value.includes("\0"));
const item = z.object({
  text: text.refine(value => Boolean(value.trim())),
  boxes: z.array(box).min(1).max(128),
  table: z.object({
    id: z.string().regex(/^ocr-t[0-9]+$/),
    row: z.number().int().min(1).max(4096),
    header: z.boolean(),
    cells: z.array(z.object({ column: z.number().int().min(1).max(128), text, box })).min(1).max(128),
  }).optional(),
});
const payload = z.object({
  version: z.literal(ocrParserVersion),
  pages: z.array(z.array(item).max(4096)).min(1).max(30),
}).refine(({ pages }) => pages.every((items, index) => items.every(unit =>
  unit.boxes.every(position => position.page === index + 1) &&
  !unit.table?.cells.some(cell => cell.box.page !== index + 1))));

let busy = false;

export async function readOcrPages(pdf: Uint8Array, pageCount: number, timeoutMs: number) {
  const configuredPort = process.env.READILY_V1_OCR_PORT;
  const token = process.env.READILY_V1_OCR_TOKEN;
  const port = Number(configuredPort);
  if (!configuredPort || !/^[0-9]{1,5}$/.test(configuredPort) || port < 1 || port > 65535 ||
      !token || !/^[A-Za-z0-9_-]{32,256}$/.test(token) || busy || timeoutMs < 1) return null;

  busy = true;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/parse`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/pdf" },
      body: new Uint8Array(pdf),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return null;
    }
    let length = 0;
    const chunks: Uint8Array[] = [];
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > maxOutput) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const result = payload.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return result.success && result.data.pages.length === pageCount ? result.data.pages : null;
  } catch {
    return null; // Unavailable or invalid OCR preserves the original review status.
  } finally {
    busy = false;
  }
}
