// Mascaramento de dados pessoais antes de gravar logs ou enviar texto a modelos.

const CPF = /(?<!\d)\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?!\d)/g;
const CNPJ = /(?<!\d)\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?!\d)/g;

/** Substitui CPFs e CNPJs (com ou sem pontuação) por máscaras fixas. */
export function mascararDocumentos(texto: string): string {
  return texto
    .replace(CNPJ, "**.***.***/****-**")
    .replace(CPF, "***.***.***-**");
}
