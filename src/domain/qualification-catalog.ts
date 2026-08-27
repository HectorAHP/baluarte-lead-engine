import type { OptionDef } from "./answer-parser.js";
import type { QualificationProduct } from "./qualification-fields.js";

export type StepKind = "OPTION" | "YES_NO_MAYBE" | "LOCATION";

export interface QualificationStep {
  id: string;
  /** Whitelisted qualification_answers field name(s) this step writes. LOCATION steps write
   * three fields at once (residence_city/residence_state/postal_code); every other step writes
   * exactly one. */
  fieldNames: readonly string[];
  prompt: string;
  kind: StepKind;
  options?: readonly OptionDef<string>[];
}

const OBJECTIVE_OPTIONS: OptionDef<string>[] = [
  { value: "PATRIMONIO", number: 1, keywords: ["patrimonio"] },
  { value: "EDUCACION", number: 2, keywords: ["educacion"] },
  { value: "COMPRA_PROYECTO", number: 3, keywords: ["compra", "proyecto"] },
  { value: "FONDO_FUTURO", number: 4, keywords: ["fondo futuro", "fondo para el futuro"] },
  { value: "OTRO", number: 5, keywords: ["otro"] },
];

const TIMELINE_OPTIONS: OptionDef<string>[] = [
  { value: "LT_3_YEARS", number: 1, keywords: ["menos de 3", "menos de tres"] },
  { value: "3_5_YEARS", number: 2, keywords: ["3-5", "3 a 5", "tres a cinco"] },
  { value: "5_10_YEARS", number: 3, keywords: ["5-10", "5 a 10", "cinco a diez"] },
  { value: "GT_10_YEARS", number: 4, keywords: ["mas de 10", "mas de diez"] },
];

const MONTHLY_CAPACITY_OPTIONS: OptionDef<string>[] = [
  { value: "LT_2000", number: 1, keywords: ["menos de 2", "menos de $2"] },
  { value: "2000_4999", number: 2, keywords: ["2,000", "2000", "2 mil"] },
  { value: "5000_9999", number: 3, keywords: ["5,000", "5000", "5 mil"] },
  { value: "10000_19999", number: 4, keywords: ["10,000", "10000", "10 mil"] },
  { value: "20000_PLUS", number: 5, keywords: ["20,000", "20000", "20 mil"] },
];

const URGENCY_SAVINGS_OPTIONS: OptionDef<string>[] = [
  { value: "THIS_MONTH", number: 1, keywords: ["este mes", "empezar ya", "ahora"] },
  { value: "ONE_TO_THREE_MONTHS", number: 2, keywords: ["1-3", "1 a 3", "uno a tres"] },
  { value: "COMPARING", number: 3, keywords: ["comparando", "solo estoy viendo", "solo viendo"] },
];

const AGE_RANGE_OPTIONS: OptionDef<string>[] = [
  { value: "LT_30", number: 1, keywords: ["menos de 30"] },
  { value: "30_39", number: 2, keywords: ["30-39", "30 a 39", "treinta"] },
  { value: "40_49", number: 3, keywords: ["40-49", "40 a 49", "cuarenta"] },
  { value: "50_59", number: 4, keywords: ["50-59", "50 a 59", "cincuenta"] },
  { value: "60_PLUS", number: 5, keywords: ["60", "sesenta"] },
];

const RETIREMENT_OBJECTIVE_OPTIONS: OptionDef<string>[] = [
  { value: "RETIREMENT", number: 1, keywords: ["retiro", "jubilacion"] },
  { value: "FISCAL", number: 2, keywords: ["fiscal", "impuesto"] },
  { value: "BOTH", number: 3, keywords: ["ambos", "los dos"] },
];

const FISCAL_SITUATION_OPTIONS: OptionDef<string>[] = [
  { value: "EMPLOYEE", number: 1, keywords: ["asalariado"] },
  { value: "INDEPENDENT", number: 2, keywords: ["profesionista", "independiente"] },
  { value: "BUSINESS_OWNER", number: 3, keywords: ["empresario"] },
  { value: "RETIRED", number: 4, keywords: ["pensionado"] },
  { value: "PREFERS_ADVISOR_REVIEW", number: 5, keywords: ["prefiero verlo con el asesor", "verlo con el asesor"] },
];

const URGENCY_PPR_OPTIONS: OptionDef<string>[] = [
  { value: "THIS_MONTH", number: 1, keywords: ["este mes", "empezar ya"] },
  { value: "ONE_TO_THREE_MONTHS", number: 2, keywords: ["1-3", "1 a 3"] },
  { value: "COMPARING", number: 3, keywords: ["investigando", "solo investigando"] },
];

const COVERAGE_TYPE_OPTIONS: OptionDef<string>[] = [
  { value: "INDIVIDUAL", number: 1, keywords: ["individual"] },
  { value: "COUPLE", number: 2, keywords: ["pareja"] },
  { value: "FAMILY", number: 3, keywords: ["familia", "familiar"] },
  { value: "BUSINESS", number: 4, keywords: ["empresa"] },
];

const PRIORITY_OPTIONS: OptionDef<string>[] = [
  { value: "PRICE", number: 1, keywords: ["precio"] },
  { value: "HOSPITALS", number: 2, keywords: ["hospital"] },
  { value: "COVERAGE", number: 3, keywords: ["cobertura"] },
  { value: "BALANCE", number: 4, keywords: ["equilibrio", "balance"] },
];

const URGENCY_GMM_OPTIONS: OptionDef<string>[] = [
  { value: "THIS_MONTH", number: 1, keywords: ["este mes"] },
  { value: "ONE_TO_THREE_MONTHS", number: 2, keywords: ["1-3", "1 a 3"] },
  { value: "COMPARING", number: 3, keywords: ["comparando", "solo comparando"] },
];

export const SAVINGS_STEPS: readonly QualificationStep[] = [
  { id: "objective", fieldNames: ["objective"], kind: "OPTION", options: OBJECTIVE_OPTIONS,
    prompt: "¿Cuál es tu objetivo principal?\n\n1. Patrimonio\n2. Educación\n3. Compra o proyecto\n4. Fondo para el futuro\n5. Otro" },
  { id: "timeline", fieldNames: ["timeline"], kind: "OPTION", options: TIMELINE_OPTIONS,
    prompt: "¿En qué horizonte de tiempo te gustaría lograrlo?\n\n1. Menos de 3 años\n2. 3–5 años\n3. 5–10 años\n4. Más de 10 años" },
  { id: "monthly_capacity", fieldNames: ["monthly_capacity"], kind: "OPTION", options: MONTHLY_CAPACITY_OPTIONS,
    prompt: "¿Cuál es tu capacidad mensual aproximada para destinar a esto?\n\n1. Menos de $2,000\n2. $2,000–$4,999\n3. $5,000–$9,999\n4. $10,000–$19,999\n5. $20,000+" },
  { id: "extra_contributions", fieldNames: ["extra_contributions"], kind: "YES_NO_MAYBE",
    prompt: "¿Podrías realizar aportaciones extraordinarias de vez en cuando (además de tu aportación mensual)?" },
  { id: "urgency", fieldNames: ["urgency"], kind: "OPTION", options: URGENCY_SAVINGS_OPTIONS,
    prompt: "¿Qué tan pronto te gustaría empezar?\n\n1. Quiero empezar este mes\n2. 1–3 meses\n3. Solo estoy comparando" },
];

export const RETIREMENT_PPR_STEPS: readonly QualificationStep[] = [
  { id: "age_range", fieldNames: ["age_range"], kind: "OPTION", options: AGE_RANGE_OPTIONS,
    prompt: "¿Cuál es tu edad o rango de edad?\n\n1. Menos de 30\n2. 30–39\n3. 40–49\n4. 50–59\n5. 60+" },
  { id: "retirement_objective", fieldNames: ["retirement_objective"], kind: "OPTION", options: RETIREMENT_OBJECTIVE_OPTIONS,
    prompt: "¿Tu objetivo principal es...?\n\n1. Retiro\n2. Reducir carga fiscal\n3. Ambos" },
  { id: "monthly_capacity", fieldNames: ["monthly_capacity"], kind: "OPTION", options: MONTHLY_CAPACITY_OPTIONS,
    prompt: "¿Cuál es tu capacidad mensual aproximada?\n\n1. Menos de $2,000\n2. $2,000–$4,999\n3. $5,000–$9,999\n4. $10,000–$19,999\n5. $20,000+" },
  { id: "fiscal_situation", fieldNames: ["fiscal_situation"], kind: "OPTION", options: FISCAL_SITUATION_OPTIONS,
    prompt: "¿Cuál describe mejor tu situación?\n\n1. Asalariado\n2. Profesionista / independiente\n3. Empresario\n4. Pensionado\n5. Prefiero verlo con el asesor" },
  { id: "urgency", fieldNames: ["urgency"], kind: "OPTION", options: URGENCY_PPR_OPTIONS,
    prompt: "¿Qué tan pronto te gustaría empezar?\n\n1. Quiero empezar este mes\n2. 1–3 meses\n3. Solo investigando" },
];

export const GMM_STEPS: readonly QualificationStep[] = [
  { id: "coverage_type", fieldNames: ["coverage_type"], kind: "OPTION", options: COVERAGE_TYPE_OPTIONS,
    prompt: "¿Para quién buscas la cobertura?\n\n1. Individual\n2. Pareja\n3. Familia\n4. Empresa" },
  { id: "age_range", fieldNames: ["age_range"], kind: "OPTION", options: AGE_RANGE_OPTIONS,
    prompt: "¿Cuál es la edad o rango de edad del titular?\n\n1. Menos de 30\n2. 30–39\n3. 40–49\n4. 50–59\n5. 60+" },
  { id: "location", fieldNames: ["residence_city", "residence_state", "postal_code"], kind: "LOCATION",
    prompt: "¿En qué ciudad, estado y código postal resides? (Puedes darme los tres datos juntos, por ejemplo: \"León, Guanajuato, 37150\")" },
  { id: "priority", fieldNames: ["priority"], kind: "OPTION", options: PRIORITY_OPTIONS,
    prompt: "¿Qué es lo más importante para ti?\n\n1. Precio\n2. Hospitales\n3. Cobertura\n4. Equilibrio entre todo" },
  { id: "has_current_insurance", fieldNames: ["has_current_insurance"], kind: "YES_NO_MAYBE",
    prompt: "¿Actualmente cuentas con un seguro de gastos médicos?" },
  { id: "urgency", fieldNames: ["urgency"], kind: "OPTION", options: URGENCY_GMM_OPTIONS,
    prompt: "¿Qué tan pronto te gustaría resolver esto?\n\n1. Este mes\n2. 1–3 meses\n3. Solo comparando" },
];

export function stepsForProduct(product: QualificationProduct): readonly QualificationStep[] {
  if (product === "SAVINGS") return SAVINGS_STEPS;
  if (product === "RETIREMENT_PPR") return RETIREMENT_PPR_STEPS;
  return GMM_STEPS;
}
