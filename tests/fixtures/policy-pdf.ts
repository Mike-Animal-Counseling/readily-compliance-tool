export function pdfText(text: string, x = 72, y = 720) {
  const safe = text.replace(/[()\\]/g, char => "\\" + char);
  return `BT /F1 12 Tf 1 0 0 1 ${x} ${y} Tm (${safe}) Tj ET`;
}

export function pdfLines(lines: string[], top = 720) {
  return lines.map((line, index) => pdfText(line, 72, top - index * 18)).join("\n");
}

export function pdfGrid(rows: [string, string][], top: number) {
  const left = 60, mid = 240, right = 540, bottom = top - rows.length * 24;
  const columns = [left, mid, right].map(x => `${x} ${bottom} m ${x} ${top} l S`);
  const boundaries = Array.from({ length: rows.length + 1 }, (_, index) => {
    const y = top - 24 * index;
    return `${left} ${y} m ${right} ${y} l S`;
  });
  return ["1 w", ...columns, ...boundaries, ...rows.flatMap(([label, value], index) => {
    const y = top - 16 - 24 * index;
    return [pdfText(label, left + 8, y), pdfText(value, mid + 8, y)];
  })].join("\n");
}

export function synthPdf(pages: string[]) {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, index) => `${4 + 2 * index} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ...pages.flatMap((content, index) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * index} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    ]),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(pdf);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return String(offset).padStart(10, "0") + " 00000 n \n";
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
