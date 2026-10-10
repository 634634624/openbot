import type { PartialTranslation } from "../../../message";
import type { messages as source } from "../../en/error/billing";

export const messages = {
  "error.billing.lifecycleFailed": "Não foi possível mudar o plano do servidor. Atualize a Cobrança e tente de novo.",
  "error.billing.confirmMismatch": "Digite o nome do servidor para excluí-lo.",
  "error.billing.invalidRequest": "A solicitação de cobrança é inválida.",
  "error.billing.invalidResponse": "A resposta de cobrança é inválida.",
  "error.billing.notStripePage": "A página de cobrança não é uma página do Stripe.",
} as const satisfies PartialTranslation<typeof source>;
