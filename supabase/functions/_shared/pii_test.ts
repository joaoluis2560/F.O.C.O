import { assertEquals } from "@std/assert";
import { mascararDocumentos } from "./pii.ts";

Deno.test("mascara CPF com e sem pontuação", () => {
  assertEquals(
    mascararDocumentos("cpf 123.456.789-09 ou 12345678909."),
    "cpf ***.***.***-** ou ***.***.***-**.",
  );
});

Deno.test("mascara CNPJ com e sem pontuação", () => {
  assertEquals(
    mascararDocumentos("cnpj 12.345.678/0001-95 e 12345678000195"),
    "cnpj **.***.***/****-** e **.***.***/****-**",
  );
});

Deno.test("não altera números que não são documento", () => {
  const texto = "pedido 1234567890123456 e telefone 5511999998888";
  assertEquals(mascararDocumentos(texto), texto);
});

Deno.test("não altera texto sem números", () => {
  assertEquals(mascararDocumentos("bom dia"), "bom dia");
});
