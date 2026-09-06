/**
 * Fase 7C.1 -- the INVERSE of formatFiscalCalculatorNote (fiscal-calculator-lead-note.ts). Built
 * for exactly one purpose: historical reconciliation (see application/hubspot-outbox-reconciliation.ts)
 * needs to know whether a pre-outbox lead's `leads.notes` column can fill the gap left by a missing
 * fiscal_lead_scores/hubspot_sync_outbox row.
 *
 * IMPORTANT, VERIFIED LIMITATION (Fase 7C.1 spec §14 -- "buscar en TODAS las tablas... antes de
 * concluir"): `leads.notes` DOES contain most of the calculator's raw inputs in a fixed, regex-
 * parseable text format -- more than the Fase 7C report first credited it for. But it is NEVER a
 * full, lossless source:
 *  - Every money figure went through `mxn()` (Math.round + thousands-separator formatting) before
 *    being written -- any cents are already gone, permanently, in the text itself.
 *  - The 4 INDIVIDUAL deduction inputs (medicalExpenses/tuition/mortgageInterest/other) were never
 *    written individually -- only their SUM ("Otras deducciones (medicos+colegiaturas+hipoteca+
 *    otros): $X"). There is no way to recover the 4-way split from this text, ever -- see
 *    application/hubspot-outbox-reconciliation.ts's ReconciliationDataQuality for how this caps
 *    every notes-based reconstruction at PARTIALLY_RECONSTRUCTABLE, never FULLY.
 *  - A lead that ran the calculator more than once has MULTIPLE blocks appended in `notes`
 *    (oldest first) and, per web-lead-capture.ts's own MAX_NOTES_LENGTH truncation, the OLDEST
 *    block(s) may already be gone entirely -- this parser returns null for a submissionId whose
 *    block was truncated away, never a guess.
 */
export interface ParsedFiscalCalculatorNoteBlock {
  submittedAtIso: string;
  age?: number;
  city?: string;
  taxRegime?: string;
  /** undefined when the original text was "No indicado" (never provided) -- never defaulted. */
  filesAnnualReturn?: boolean;
  /** Rounded to the nearest whole peso -- see the class doc comment's precision-loss note. */
  monthlyIncome: number;
  annualIncome: number;
  annualContribution: number;
  effectivePprContribution: number;
  pprDeductionLimit: number;
  /** The SUM of all 4 deduction inputs ONLY -- the individual medicalExpenses/tuition/
   * mortgageInterest/other figures are NOT recoverable from this text, ever (see class doc
   * comment). Corresponds to bc_fiscal_personal_deductions, never the 4 bc_fiscal_deduction_*
   * properties. */
  personalDeductionsTotal: number;
  otherDeductionsConsidered: number;
  hasGmm?: boolean;
  hasPpr?: boolean;
  estimatedTaxBenefitMin: number;
  estimatedTaxBenefitMax: number;
  submissionId: string;
}

const BLOCK_START = /^\[Calculadora fiscal PPR — (.+)\]$/;

function parseYesNoUnknown(raw: string): boolean | undefined {
  if (raw === "Si") return true;
  if (raw === "No") return false;
  return undefined; // "No indicado"/"No indicada" or anything unrecognized
}

function parseMxn(raw: string): number | undefined {
  const match = /\$?(-?[\d,]+)/.exec(raw.trim());
  if (!match) return undefined;
  const n = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

/** Splits `notes` (leads.notes -- may contain other, unrelated free text interleaved by a human
 * advisor, plus one or more calculator blocks and UTM attribution lines appended by
 * web-lead-capture.ts) into individual calculator blocks, each starting at a
 * `[Calculadora fiscal PPR — ...]` header line and running until the next such header or the end
 * of the string. Blocks that fail to parse cleanly (missing a required numeric field, corrupted by
 * truncation -- see MAX_NOTES_LENGTH/TRUNCATION_MARKER in web-lead-capture.ts) are silently
 * skipped, never returned as a partially-garbage result. */
export function parseFiscalCalculatorNoteBlocks(notes: string | undefined): ParsedFiscalCalculatorNoteBlock[] {
  if (!notes) return [];
  const lines = notes.split("\n");
  const blockStartIndices: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (BLOCK_START.test(lines[i])) blockStartIndices.push(i);
  }

  const results: ParsedFiscalCalculatorNoteBlock[] = [];
  for (let b = 0; b < blockStartIndices.length; b++) {
    const start = blockStartIndices[b];
    const end = b + 1 < blockStartIndices.length ? blockStartIndices[b + 1] : lines.length;
    const blockLines = lines.slice(start, end);
    const parsed = parseSingleBlock(blockLines);
    if (parsed) results.push(parsed);
  }
  return results;
}

function parseSingleBlock(lines: string[]): ParsedFiscalCalculatorNoteBlock | null {
  try {
    const headerMatch = BLOCK_START.exec(lines[0]);
    if (!headerMatch) return null;
    const submittedAtIso = headerMatch[1];

    const find = (prefix: string) => lines.find((l) => l.startsWith(prefix));

    const line2 = find("Edad:");
    const edadMatch = line2 ? /Edad: (.+?) \| Ciudad: (.+?) \| Regimen: (.+)/.exec(line2) : null;
    const age = edadMatch && edadMatch[1] !== "No indicada" ? Number(edadMatch[1]) : undefined;
    const city = edadMatch && edadMatch[2] !== "No indicada" ? edadMatch[2] : undefined;
    const taxRegime = edadMatch && edadMatch[3] !== "No indicado" ? edadMatch[3] : undefined;

    const line3 = find("Presenta declaracion anual:");
    const filesAnnualReturn = line3 ? parseYesNoUnknown(line3.replace("Presenta declaracion anual: ", "").trim()) : undefined;

    const line4 = find("Ingreso mensual:");
    const line4Match = line4 ? /Ingreso mensual: (.+?) \| Ingreso anual estimado: (.+)/.exec(line4) : null;
    const monthlyIncome = line4Match ? parseMxn(line4Match[1]) : undefined;
    const annualIncome = line4Match ? parseMxn(line4Match[2]) : undefined;

    const line5 = find("Aportacion PPR anual indicada:");
    const line5Match = line5 ? /Aportacion PPR anual indicada: (.+?) \| Aportacion PPR efectiva \(limitada\): (.+)/.exec(line5) : null;
    const annualContribution = line5Match ? parseMxn(line5Match[1]) : undefined;
    const effectivePprContribution = line5Match ? parseMxn(line5Match[2]) : undefined;

    const line6 = find("Limite de deduccion PPR calculado:");
    const pprDeductionLimit = line6 ? parseMxn(line6.replace("Limite de deduccion PPR calculado: ", "")) : undefined;

    const line7 = find("Otras deducciones");
    const line7Match = line7 ? /:\s*(.+?) \| consideradas tras tope: (.+)/.exec(line7) : null;
    const personalDeductionsTotal = line7Match ? parseMxn(line7Match[1]) : undefined;
    const otherDeductionsConsidered = line7Match ? parseMxn(line7Match[2]) : undefined;

    const line8 = find("Tiene GMM:");
    const line8Match = line8 ? /Tiene GMM: (.+?) \| Ya tiene PPR: (.+)/.exec(line8) : null;
    const hasGmm = line8Match ? parseYesNoUnknown(line8Match[1]) : undefined;
    const hasPpr = line8Match ? parseYesNoUnknown(line8Match[2]) : undefined;

    const line9 = find("Beneficio fiscal estimado:");
    const line9Match = line9 ? /Beneficio fiscal estimado: (.+?) - (.+?) MXN/.exec(line9) : null;
    const estimatedTaxBenefitMin = line9Match ? parseMxn(line9Match[1]) : undefined;
    const estimatedTaxBenefitMax = line9Match ? parseMxn(line9Match[2]) : undefined;

    const line10 = find("submissionId:");
    const submissionId = line10 ? line10.replace("submissionId: ", "").trim() : undefined;

    if (
      monthlyIncome === undefined || annualIncome === undefined || annualContribution === undefined ||
      effectivePprContribution === undefined || pprDeductionLimit === undefined ||
      personalDeductionsTotal === undefined || otherDeductionsConsidered === undefined ||
      estimatedTaxBenefitMin === undefined || estimatedTaxBenefitMax === undefined || !submissionId
    ) {
      return null; // incomplete/corrupted block (e.g. truncated mid-block) -- never a partial guess
    }

    return {
      submittedAtIso, age, city, taxRegime, filesAnnualReturn,
      monthlyIncome, annualIncome, annualContribution, effectivePprContribution, pprDeductionLimit,
      personalDeductionsTotal, otherDeductionsConsidered, hasGmm, hasPpr,
      estimatedTaxBenefitMin, estimatedTaxBenefitMax, submissionId,
    };
  } catch {
    return null;
  }
}

/** Finds the ONE block matching `submissionId` exactly -- never a fuzzy/closest match. Returns
 * null if no block matches (never found, or truncated away). */
export function findFiscalCalculatorNoteBlockForSubmission(notes: string | undefined, submissionId: string): ParsedFiscalCalculatorNoteBlock | null {
  return parseFiscalCalculatorNoteBlocks(notes).find((b) => b.submissionId === submissionId) ?? null;
}
