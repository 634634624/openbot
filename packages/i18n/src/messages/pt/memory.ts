import type { PartialTranslation } from "../../message";
import type { messages as source } from "../en/memory";

export const messages = {
  "memory.title": "Memórias",
  "memory.description": "Memórias salvas de {name}",
  "memory.add": "Adicionar memória",
  "memory.close": "Fechar memórias",
  "memory.new": "Nova memória",
  "memory.newPlaceholder": "Adicione um fato ou uma preferência duradoura",
  "memory.save": "Salvar memória",
  "memory.limitAgent":
    "Este agente atingiu o limite de {limit} memórias. Edite, combine ou exclua uma memória antes de adicionar outra.",
  "memory.limitChannel":
    "Este canal atingiu o limite de {limit} memórias. Edite, combine ou exclua uma memória antes de adicionar outra.",
  "memory.loading": "Carregando memórias…",
  "memory.emptyAgent": "Este agente ainda não tem memórias salvas.",
  "memory.emptyChannel": "Este canal ainda não tem memórias salvas.",
  "memory.editText": "Editar memória: {text}",
  "memory.edit": "Editar memória",
  "memory.delete": "Excluir memória",
  "memory.learned": "Aprendida automaticamente",
  "memory.manual": "Adicionada manualmente",
  "memory.unknownDate": "Data desconhecida",
  "memory.clearAll": "Limpar todas as memórias",
  "memory.clearTitle": "Limpar todas as memórias?",
  "memory.clearDescription":
    "O OpenBot removerá permanentemente todas as {total} memórias salvas de {name}. As mensagens originais continuarão no histórico da conversa.",
  "memory.loadFailed": "Não foi possível carregar as memórias.",
  "memory.saveFailed": "Não foi possível salvar a memória.",
  "memory.updateFailed": "Não foi possível atualizar a memória.",
  "memory.deleteFailed": "Não foi possível excluir a memória.",
  "memory.clearFailed": "Não foi possível limpar as memórias.",
  "memory.inclusion.label": "Uso de memória",
  "memory.inclusion.essential": "Sempre incluída",
  "memory.inclusion.searchable": "Pesquisar quando necessário",
  "memory.inclusion.automatic": "Deixar o agente decidir",
  "memory.inclusion.userControlled": "Selecionada por você",
  "memory.inclusion.agentControlled": "O agente pode mudar isto",
  "memory.inclusion.explanation":
    "Todas as memórias ficam salvas. Só as memórias essenciais entram em cada prompt. O agente pode pesquisar as demais.",
  "memory.inclusion.capacity": "Capacidade de memória essencial: {used} de {total}",
} as const satisfies PartialTranslation<typeof source>;
