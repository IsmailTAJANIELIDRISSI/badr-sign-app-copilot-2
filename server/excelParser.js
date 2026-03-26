import path from "path";
import xlsx from "xlsx";

const LTA_REGEX = /\b\d{3}-\d{8}\b/;
const DUM_LABEL_REGEX = /^\s*DUM\s+(\d+)\s*$/i;
const SERIES_REGEX = /^\d{7}[A-Z]$/i;

const normalizeCell = (value) => String(value ?? "").trim();

const getCell = (sheet, col, row) => {
  const address = `${col}${row}`;
  return normalizeCell(sheet[address]?.v);
};

const splitSeries = (rawSeries) => {
  const cleaned = String(rawSeries || "")
    .trim()
    .toUpperCase();
  if (!SERIES_REGEX.test(cleaned)) {
    return null;
  }
  const key = cleaned.slice(-1);
  const core = cleaned.slice(0, -1).replace(/^0+/, "") || "0";
  return { raw: cleaned, serie: core, key };
};

const extractLtaRef = (sheet) => {
  const range = xlsx.utils.decode_range(sheet["!ref"] || "A1:H200");
  for (let r = range.s.r; r <= Math.min(range.e.r, 60); r += 1) {
    for (let c = range.s.c; c <= Math.min(range.e.c, 8); c += 1) {
      const addr = xlsx.utils.encode_cell({ r, c });
      const value = normalizeCell(sheet[addr]?.v);
      const match = value.match(LTA_REGEX);
      if (match) {
        return match[0];
      }
    }
  }
  return null;
};

const extractDumsByFixedRows = (sheet) => {
  const dums = [];
  let dumNumber = 1;
  let row = 12;

  while (dumNumber <= 200) {
    const raw = getCell(sheet, "C", row).toUpperCase().replace(/\s+/g, "");
    if (!raw) {
      if (dumNumber > 1) {
        break;
      }
      row += 7;
      dumNumber += 1;
      continue;
    }
    const split = splitSeries(raw);
    if (!split) {
      row += 7;
      dumNumber += 1;
      continue;
    }

    dums.push({
      dumNumber,
      rawSerie: split.raw,
      serie: split.serie,
      key: split.key,
      sourceCell: `C${row}`,
    });

    row += 7;
    dumNumber += 1;
  }

  return dums;
};

const extractDumsByLabels = (sheet) => {
  const range = xlsx.utils.decode_range(sheet["!ref"] || "A1:H500");
  const dums = [];

  for (let r = range.s.r; r <= range.e.r; r += 1) {
    for (let c = range.s.c; c <= Math.min(range.e.c, 6); c += 1) {
      const addr = xlsx.utils.encode_cell({ r, c });
      const value = normalizeCell(sheet[addr]?.v);
      const m = value.match(DUM_LABEL_REGEX);
      if (!m) {
        continue;
      }
      const dumNumber = Number.parseInt(m[1], 10);
      const seriesAddr = xlsx.utils.encode_cell({ r: r + 1, c: 2 });
      const maybeSeries = normalizeCell(sheet[seriesAddr]?.v)
        .toUpperCase()
        .replace(/\s+/g, "");
      const split = splitSeries(maybeSeries);
      if (!split) {
        continue;
      }
      dums.push({
        dumNumber,
        rawSerie: split.raw,
        serie: split.serie,
        key: split.key,
        sourceCell: seriesAddr,
      });
    }
  }

  return dums.sort((a, b) => a.dumNumber - b.dumNumber);
};

export const parseLtaExcel = (filePath) => {
  const workbook = xlsx.readFile(filePath, { cellDates: false });
  const firstSheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[firstSheetName];

  const ltaRef = extractLtaRef(sheet);
  const byFixedRows = extractDumsByFixedRows(sheet);
  const byLabels = extractDumsByLabels(sheet);

  const dums = byFixedRows.length ? byFixedRows : byLabels;

  if (!ltaRef) {
    throw new Error(
      `Could not extract LTA reference from ${path.basename(filePath)}`,
    );
  }

  if (!dums.length) {
    throw new Error(
      `Could not extract DUM series from ${path.basename(filePath)}`,
    );
  }

  return {
    filePath,
    fileName: path.basename(filePath),
    ltaRef,
    ltaNumericRef: ltaRef.replace(/-/g, ""),
    dums,
  };
};
