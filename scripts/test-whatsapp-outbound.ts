/**
 * Manual, one-off outbound test for MetaWhatsAppProvider -- bypasses the webhook entirely,
 * touches no repository (no leads/conversations/messages rows are written), and reuses the
 * project's real provider implementation rather than duplicating its HTTP logic.
 *
 * Usage:
 *   WHATSAPP_TEST_RECIPIENT=<authorized test number, E.164, no +> npx tsx scripts/test-whatsapp-outbound.ts
 *
 * Never prints: access token, app secret, verify token, full URL, Authorization header, or the
 * full config object. Only reports success/failure, HTTP status, Meta's public error code/type,
 * and the Meta message id when available.
 */
import { config } from "../src/config.js";
import { MetaWhatsAppProvider } from "../src/infrastructure/meta-whatsapp-provider.js";
import { MessagingProviderError } from "../src/domain/errors.js";
import { diagnoseMetaError } from "../src/domain/meta-error-diagnosis.js";

const TEST_MESSAGE = "Prueba técnica Baluarte Lead Engine. No es necesario responder.";

async function main(): Promise<void> {
  const missingConfig: string[] = [];
  if (!config.WHATSAPP_ACCESS_TOKEN) missingConfig.push("WHATSAPP_ACCESS_TOKEN");
  if (!config.WHATSAPP_PHONE_NUMBER_ID) missingConfig.push("WHATSAPP_PHONE_NUMBER_ID");
  if (!config.META_GRAPH_API_VERSION) missingConfig.push("META_GRAPH_API_VERSION");
  if (missingConfig.length > 0) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "MISSING_CONFIG", missing: missingConfig }, null, 2));
    process.exitCode = 1;
    return;
  }

  const recipient = process.env.WHATSAPP_TEST_RECIPIENT;
  if (!recipient) {
    console.log(JSON.stringify({ result: "FAILURE", reason: "MISSING_WHATSAPP_TEST_RECIPIENT" }, null, 2));
    process.exitCode = 1;
    return;
  }

  let provider: MetaWhatsAppProvider;
  try {
    provider = new MetaWhatsAppProvider();
  } catch {
    console.log(JSON.stringify({ result: "FAILURE", reason: "PROVIDER_CONSTRUCTION_FAILED" }, null, 2));
    process.exitCode = 1;
    return;
  }

  try {
    const result = await provider.sendText(recipient, TEST_MESSAGE);
    console.log(JSON.stringify({ result: "SUCCESS", metaMessageId: result.providerMessageId ?? null }, null, 2));
  } catch (err) {
    if (err instanceof MessagingProviderError) {
      console.log(
        JSON.stringify(
          {
            result: "FAILURE",
            httpStatus: err.httpStatus ?? null,
            metaErrorCode: err.metaErrorCode ?? null,
            metaErrorType: err.metaErrorType ?? null,
            diagnosis: err.sanitizedDiagnosis ?? diagnoseMetaError(err.metaErrorCode, err.metaErrorType),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(JSON.stringify({ result: "FAILURE", reason: "UNEXPECTED_ERROR" }, null, 2));
    }
    process.exitCode = 1;
  }
}

await main();
