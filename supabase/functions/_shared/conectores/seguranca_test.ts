import { assertEquals, assertRejects } from "@std/assert";
import { enderecoInterno, validarDestino } from "./seguranca.ts";
import { ErroConector, type Integracao } from "./tipos.ts";

const base = (base_url: string, permite_http = false): Integracao => ({
  base_url,
  permite_http,
  tipo_auth: "nenhuma",
  auth_config: {},
});
const publico = () => Promise.resolve(["203.0.113.10"]);
const semQuery = () => new URLSearchParams();

Deno.test("enderecoInterno reconhece redes internas", () => {
  for (
    const h of [
      "localhost",
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "[::1]",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "2130706433",
      "0x7f.0.0.1",
      "banco",
      "servico.internal",
      "impressora.local",
    ]
  ) {
    assertEquals(enderecoInterno(h), true, h);
  }
});

Deno.test("enderecoInterno libera endereços públicos", () => {
  for (
    const h of ["erp.example", "203.0.113.10", "172.32.0.1", "2001:db8::1", "api.bling.com.br"]
  ) {
    assertEquals(enderecoInterno(h), false, h);
  }
});

Deno.test("destino válido mantém host e prefixo da base", async () => {
  const url = await validarDestino(
    base("https://erp.example/api/"),
    "/clientes/42",
    new URLSearchParams({ a: "b" }),
    publico,
  );
  assertEquals(url.href, "https://erp.example/api/clientes/42?a=b");
});

Deno.test("destinos bloqueados", async (t) => {
  const casos: [string, Integracao, string, () => Promise<string[]>][] = [
    ["http fora de loopback", base("http://erp.example", true), "/x", publico],
    ["http em loopback sem permite_http", base("http://127.0.0.1:8787"), "/x", publico],
    ["https para IP interno", base("https://10.0.0.5"), "/x", publico],
    ["https para metadados de nuvem", base("https://169.254.169.254"), "/x", publico],
    [
      "host que resolve para rede interna",
      base("https://erp.example"),
      "/x",
      () => Promise.resolve(["203.0.113.10", "10.0.0.5"]),
    ],
    ["subida de diretório", base("https://erp.example/api"), "/../admin", publico],
    ["caminho sem barra inicial", base("https://erp.example"), "x", publico],
    ["caminho que troca de host", base("https://erp.example"), "//outro.example/x", publico],
    ["caminho com query embutida", base("https://erp.example"), "/x?admin=1", publico],
    ["barra invertida", base("https://erp.example"), "/\\outro.example", publico],
    ["credenciais na base", base("https://u:p@erp.example"), "/x", publico],
    ["protocolo estranho", base("ftp://erp.example"), "/x", publico],
  ];
  for (const [nome, integracao, caminho, dns] of casos) {
    await t.step(nome, async () => {
      const erro = await assertRejects(
        () => validarDestino(integracao, caminho, semQuery(), dns),
        ErroConector,
      );
      assertEquals(erro.codigo, "destino_bloqueado");
    });
  }
});

Deno.test("http em loopback é aceito só com permite_http", async () => {
  const url = await validarDestino(base("http://127.0.0.1:8787", true), "/x", semQuery());
  assertEquals(url.href, "http://127.0.0.1:8787/x");
});
