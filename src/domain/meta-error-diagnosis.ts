/**
 * Static, code-only diagnosis text for Meta Graph API error taxonomy. Deliberately never takes
 * Meta's own `error.message` as input -- that field can echo request content and must not be
 * surfaced in logs or CLI output. Shared between the outbound test script and the production
 * MetaWhatsAppProvider so the two never drift.
 */
export function diagnoseMetaError(code: number | undefined, type: string | undefined): string {
  if (code === 190) {
    return "Token de acceso inválido o expirado (Meta error 190, OAuthException). Se requiere generar manualmente un nuevo WHATSAPP_ACCESS_TOKEN -- no se intenta regenerar automáticamente.";
  }
  if (code === 131030) {
    return "El número destinatario no está en la lista de números de prueba autorizados de esta app (modo desarrollo de Meta).";
  }
  if (code === 100 && type === "GraphMethodException") {
    return "Parámetro inválido en la solicitud -- revisar el formato del destinatario (E.164 sin '+', sin el '1' extra legacy de México).";
  }
  if (code === 10 || code === 200) {
    return "Permiso insuficiente para el token o la app actual (revisar scopes del token en Meta for Developers).";
  }
  return "Sin diagnóstico específico para este código -- consultar la tabla de error codes de Graph API de Meta.";
}
