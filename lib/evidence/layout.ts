import type { Page } from "pdf2json";
import { decodePdfText, parsePdfBuffer } from "../pdf/extract-pages";
import type { EvidenceUnit, ParentBlock, ParsedPolicy, SourceBox } from "./model";

type Run = { x: number; y: number; text: string; box: SourceBox };
type LayoutItem = Pick<EvidenceUnit, "text" | "boxes" | "table"> & { y: number };
const tolerance = 0.15;
const clausePrefix = /^(?:(?:section|clause|article)\s+|第\s*)?(\d{1,3}(?:\.\d{1,3}){0,7})(?:\s*[.):、条]\s*|\s+)(?=\D)/iu;
const exceptionPattern = /\b(?:unless|except|exceptions?|exempt(?:ion)?|provided that|subject to|however|only if)\b|除非|例外|但书|但不|豁免/iu;

export function clauseReferences(text: string) {
  return [...new Set([...text.matchAll(/(?:\b(?:sections?|clauses?|articles?)\s+|第\s*)(\d{1,3}(?:\.\d{1,3}){0,7})\b/giu)]
    .map(match => match[1]))];
}

function rectangle(page: Page, number: number, left: number, top: number, right: number, bottom: number): SourceBox {
  const normalize = (value: number, total: number) => Math.max(0, Math.min(value / total, 1));
  return {
    page: number,
    left: normalize(left, page.Width), top: normalize(top, page.Height),
    right: normalize(right, page.Width), bottom: normalize(bottom, page.Height),
  };
}

function textLines(runs: Run[]) {
  const lines: Run[][] = [];
  for (const run of [...runs].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const line = lines.at(-1);
    if (line && run.y - line[0].y <= 0.25) line.push(run);
    else lines.push([run]);
  }
  return lines.map(line => line.sort((a, b) => a.x - b.x));
}

function pageLayout(page: Page, number: number) {
  const runs = page.Texts.flatMap((block): Run[] => {
    const text = block.R.map(run => decodePdfText(run.T)).join("").replace(/[\s\p{Cc}]+/gu, " ").trim();
    if (!text) return [];
    // pdf2json reports text origin with an offset and width in viewport units.
    const x = block.x + 0.25;
    const y = block.y + 0.75;
    const height = Math.max(...block.R.map(run => run.TS?.[1] ?? 10)) / 24;
    return [{ x, y, text, box: rectangle(page, number, x, y - height, x + block.w / 32, y + height / 4) }];
  });
  const used = new Set<Run>();
  const items: LayoutItem[] = [];
  const horizontal = [...page.HLines].sort((a, b) => a.y - b.y);
  let uncertain = page.Texts.some(block => block.R.some(run => run.RA));

  for (const start of horizontal) {
    const x = start.x;
    const right = x + start.l;
    const vertical = page.VLines.filter(line => line.x >= x - tolerance && line.x <= right + tolerance &&
      line.y <= start.y + tolerance && line.y + line.l > start.y + tolerance);
    const columns = [...new Set(vertical.map(line => line.x))].sort((a, b) => a - b)
      .filter((column, index, all) => !index || column - all[index - 1] > tolerance);
    if (columns.length < 3 || Math.abs(columns[0] - x) > tolerance || Math.abs(columns.at(-1)! - right) > tolerance) continue;
    const verticalEnd = Math.min(...vertical.map(line => line.y + line.l));
    const boundaries = horizontal.filter(line => line.y >= start.y - tolerance &&
      line.y <= verticalEnd + tolerance && Math.abs(line.x - x) <= tolerance && Math.abs(line.x + line.l - right) <= tolerance);
    const rows = [...new Set(boundaries.map(line => line.y))].filter((row, index, all) => !index || row - all[index - 1] > tolerance);
    if (rows.length < 2) continue;
    const inside = runs.filter(run => run.x >= x - tolerance && run.x < right && run.y > rows[0] && run.y <= rows.at(-1)!);
    if (!inside.length || inside.some(run => used.has(run))) continue;
    if (inside.some(run => columns.slice(1, -1).some(column => run.x < column && run.box.right * page.Width > column + tolerance))) {
      uncertain = true;
    }
    for (let row = 0; row < rows.length - 1; row++) {
      const cells = columns.slice(0, -1).map((column, index) => {
        const content = inside.filter(run => run.y > rows[row] && run.y <= rows[row + 1] &&
          run.x >= column - tolerance && run.x < columns[index + 1] - tolerance);
        content.forEach(run => used.add(run));
        return {
          column: index + 1,
          text: textLines(content).map(line => line.map(run => run.text).join(" ")).join("\n"),
          box: rectangle(page, number, column, rows[row], columns[index + 1], rows[row + 1]),
        };
      });
      items.push({
        y: rows[row], text: cells.map(cell => cell.text).join(" | "), boxes: cells.map(cell => cell.box),
        table: { id: `t${number}-${start.y}-${x}`, row: row + 1, header: row === 0, cells },
      });
    }
  }

  for (const line of textLines(runs.filter(run => !used.has(run)))) {
    if (line.some((run, index) => index > 0 && run.box.left - line[index - 1].box.right > 0.12)) uncertain = true;
    items.push({ y: line[0].y, text: line.map(run => run.text).join(" "), boxes: line.map(run => run.box) });
  }
  return { items: items.sort((a, b) => a.y - b.y), unreadable: runs.length === 0, uncertain };
}

export function structurePolicyPages(pages: Page[]): ParsedPolicy {
  const parents: ParentBlock[] = [];
  const warnings: ParsedPolicy["warnings"] = [];
  let parent: ParentBlock | undefined;
  let root: string | null = null;
  let clause: string | null = null;
  let previousTable: { id: string; header: string; row: number; page: number } | undefined;
  for (const [index, page] of pages.entries()) {
    const number = index + 1;
    const layout = pageLayout(page, number);
    if (layout.unreadable) warnings.push({ page: number, code: "unreadable_page" });
    if (layout.uncertain) warnings.push({ page: number, code: "uncertain_layout" });
    let continuation: { source: string; target: string; offset: number } | undefined;
    for (const [position, item] of layout.items.entries()) {
      const matched = item.table ? null : item.text.match(clausePrefix);
      const numberFound = matched?.[1];
      if (!parent || (numberFound && (!root || (numberFound !== root && !numberFound.startsWith(root + "."))))) {
        parent = { id: `p${parents.length + 1}`, units: [] };
        parents.push(parent);
        root = numberFound ?? null;
        clause = root;
        previousTable = undefined;
      }
      if (numberFound) clause = numberFound;
      if (item.table?.header && position === 0 && previousTable?.page === number - 1 && item.text === previousTable.header) {
        continuation = { source: item.table.id, target: previousTable.id, offset: previousTable.row };
      }
      const table = item.table && item.table.id === continuation?.source
        ? { ...item.table, id: continuation.target, row: item.table.row + continuation.offset }
        : item.table;
      if (table) {
        const header: string = table.header ? item.text : previousTable?.header ?? "";
        previousTable = { id: table.id, header, row: table.row, page: number };
      } else {
        previousTable = undefined;
      }
      parent.units.push({
        id: `${parent.id}-u${parent.units.length + 1}`,
        kind: table ? "table_row" : numberFound ? "clause" : "paragraph",
        text: item.text,
        boxes: item.boxes,
        clause,
        references: clauseReferences(matched ? item.text.slice(matched[0].length) : item.text),
        exception: exceptionPattern.test(item.text),
        ...(table ? { table } : {}),
      });
    }
  }
  return { parents, warnings, pageCount: pages.length };
}

export async function parsePolicy(data: Uint8Array) {
  const parsed = await parsePdfBuffer(data);
  return structurePolicyPages(parsed.Pages);
}
