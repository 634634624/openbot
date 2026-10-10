import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/notification";

export const messages = {
  "notification.needsInput": "Precisa de uma resposta sua.",
  "notification.needsApproval": "Precisa da sua aprovação.",
  "notification.finished": "Terminou o trabalho.",
  "notification.failed": "Parou com um erro.",
  "notification.usageLimit.title": "A conta {provider} atingiu o limite",
  "notification.usageLimit.body": {
    one: "{count} agente aguarda. O OpenBot tentará de novo mais tarde.",
    other: "{count} agentes aguardam. O OpenBot tentará de novo mais tarde.",
  },
  "notification.usageLimit.bodyResets": {
    one: "{count} agente aguarda. Reajusta {reset}.",
    other: "{count} agentes aguardam. Reajusta {reset}.",
  },
  "notification.test": "As notificações estão funcionando.",
  "notification.welcome": "O OpenBot avisará aqui quando um agente precisar de você.",
  "notification.toast.region": "Notificações",
  "notification.toast.close": "Fechar notificação",
} as const satisfies PartialTranslation<typeof source>;
