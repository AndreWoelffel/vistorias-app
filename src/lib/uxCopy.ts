/** Textos curtos para campo — sem jargão técnico. Formato erros: o que foi + o que fazer. */

export const SYNC_MSG_DUPLICIDADE_AGUARDAR_AJUSTE =
  "Salva neste aparelho. Há outro registro igual (placa ou número). Corrija e toque em enviar de novo.";

export const fieldToasts = {
  placaNaoLeu: {
    title: "Não leu a placa",
    description: "Tire outra foto mais de perto, com boa luz, ou digite a placa.",
  },
  leituraFracaNumero: {
    title: "Número ilegível",
    description: "Aproxime a câmera do adesivo ou digite os 5 números.",
  },
  ocrFalhou: {
    title: "Não deu para ler",
    description: "Digite a placa ou o número manualmente.",
  },
  multiFrameFalhou: {
    title: "Fotos não processadas",
    description: "Tente de novo ou preencha à mão.",
  },
  adesivoNaoViu: {
    title: "Não achamos o adesivo",
    description: "Tire outra foto ou digite o número da vistoria.",
  },
  lerAdesivoErro: {
    title: "Erro ao ler o adesivo",
    description: "Use outra foto ou digite o número.",
  },
  numeroLido: {
    title: "Número preenchido",
    description: "Confira se está certo antes de continuar.",
  },
} as const;
