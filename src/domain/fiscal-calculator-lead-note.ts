/**
 * Formats the fiscal calculator's submission context into a single human-readable text block,
 * appended to leads.notes by web-lead-capture.ts. There is no dedicated structured table for
 * calculator interactions (see web-lead-capture.ts's doc comment for why) -- this is the
 * pragmatic stand-in, same spirit as the existing HubSpot "message" field pattern already used
 * by baluartecapital.com.mx/impuestos.html.
 *
 * Pure and independently testable on purpose: this is the one place that decides exactly which
 * fiscal figures leave the browser and land in Lead Engine's storage, so its output is easy to
 * assert on in isolation from HTTP/Supabase.
 */
export interface FiscalCalculatorNoteInput {
  age?: number;
  city?: string;
  taxRegime?: string;
  filesAnnualReturn?: boolean;
  monthlyIncome: number;
  annualContribution: number;
  deductions: { medicalExpenses: number; tuition: number; mortgageInterest: number; other: number };
  hasGmm?: boolean;
  hasPpr?: boolean;
  calculation: {
    annualIncome: number;
    pprDeductionLimit: number;
    effectivePprContribution: number;
    otherDeductionsConsidered: number;
    estimatedTaxBenefitMin: number;
    estimatedTaxBenefitMax: number;
  };
  submissionId: string;
  submittedAt: Date;
}

function yesNoUnknown(value: boolean | undefined): string {
  return value === true ? "Si" : value === false ? "No" : "No indicado";
}

function mxn(n: number): string {
  return "$" + Math.round(n).toLocaleString("en-US");
}

export function formatFiscalCalculatorNote(input: FiscalCalculatorNoteInput): string {
  const lines = [
    `[Calculadora fiscal PPR — ${input.submittedAt.toISOString()}]`,
    `Edad: ${input.age ?? "No indicada"} | Ciudad: ${input.city ?? "No indicada"} | Regimen: ${input.taxRegime ?? "No indicado"}`,
    `Presenta declaracion anual: ${yesNoUnknown(input.filesAnnualReturn)}`,
    `Ingreso mensual: ${mxn(input.monthlyIncome)} | Ingreso anual estimado: ${mxn(input.calculation.annualIncome)}`,
    `Aportacion PPR anual indicada: ${mxn(input.annualContribution)} | Aportacion PPR efectiva (limitada): ${mxn(input.calculation.effectivePprContribution)}`,
    `Limite de deduccion PPR calculado: ${mxn(input.calculation.pprDeductionLimit)}`,
    `Otras deducciones (medicos+colegiaturas+hipoteca+otros): ${mxn(
      input.deductions.medicalExpenses + input.deductions.tuition + input.deductions.mortgageInterest + input.deductions.other,
    )} | consideradas tras tope: ${mxn(input.calculation.otherDeductionsConsidered)}`,
    `Tiene GMM: ${yesNoUnknown(input.hasGmm)} | Ya tiene PPR: ${yesNoUnknown(input.hasPpr)}`,
    `Beneficio fiscal estimado: ${mxn(input.calculation.estimatedTaxBenefitMin)} - ${mxn(input.calculation.estimatedTaxBenefitMax)} MXN`,
    `submissionId: ${input.submissionId}`,
  ];
  return lines.join("\n");
}
