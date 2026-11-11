// ERP simulado: sistema de gestão falso para testes e demonstração.
// Os nomes de campos são propositalmente diferentes do catálogo canônico,
// para exercitar o mapeamento dos conectores.
//
// Uso: deno run --allow-net --allow-env --allow-read ferramentas/erp-simulado/servidor.ts

export const TOKEN_PADRAO = "erp-simulado-local";

interface Pedido {
  number: string;
  customer_id: string;
  state: string;
  total_cents: number;
  placed_at: string;
}

export function criarErpSimulado(token = TOKEN_PADRAO) {
  const customers = [
    { id: "C-100", full_name: "Maria Souza", phone: "5511999990001" },
    { id: "C-200", full_name: "João Lima", phone: "5511999990002" },
  ];
  const products = [
    { sku: "P-1", title: "Parafuso sextavado 8mm", price_cents: 150, unit: "un" },
    { sku: "P-2", title: "Parafusadeira 12V", price_cents: 34990, unit: "un" },
    { sku: "P-3", title: "Tinta acrílica branca 18L", price_cents: 28900, unit: "lata" },
  ];
  const stock: Record<string, { on_hand: number; reserved: number }> = {
    "P-1": { on_hand: 5000, reserved: 120 },
    "P-2": { on_hand: 7, reserved: 2 },
    "P-3": { on_hand: 0, reserved: 0 },
  };
  const orders: Pedido[] = [
    {
      number: "PED-1001",
      customer_id: "C-100",
      state: "shipped",
      total_cents: 35290,
      placed_at: "2026-11-03",
    },
    {
      number: "PED-1002",
      customer_id: "C-200",
      state: "pending",
      total_cents: 28900,
      placed_at: "2026-11-08",
    },
  ];
  const receivables = [
    {
      id: "T-1",
      customer_id: "C-100",
      status: "open",
      amount_cents: 35290,
      due_date: "2026-11-20",
      pay_url: "https://pagamentos.example/t/T-1",
    },
    {
      id: "T-2",
      customer_id: "C-100",
      status: "paid",
      amount_cents: 9900,
      due_date: "2026-10-20",
      pay_url: "https://pagamentos.example/t/T-2",
    },
    {
      id: "T-3",
      customer_id: "C-200",
      status: "open",
      amount_cents: 28900,
      due_date: "2026-11-25",
      pay_url: "https://pagamentos.example/t/T-3",
    },
  ];
  const idempotencia = new Map<string, Pedido>();

  const json = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), {
      status,
      headers: { "content-type": "application/json" },
    });

  async function tratar(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const caminho = url.pathname;

    if (caminho === "/openapi.json" && req.method === "GET") {
      const spec = await Deno.readTextFile(new URL("./openapi.json", import.meta.url));
      return new Response(spec, { headers: { "content-type": "application/json" } });
    }
    if (req.headers.get("authorization") !== `Bearer ${token}`) {
      return json({ error: "unauthorized" }, 401);
    }

    let m: RegExpMatchArray | null;
    if (req.method === "GET" && caminho === "/api/v1/customers") {
      const phone = url.searchParams.get("phone");
      return json({ data: customers.filter((c) => c.phone === phone) });
    }
    if (req.method === "GET" && caminho === "/api/v1/products") {
      const q = (url.searchParams.get("q") ?? "").toLowerCase();
      return json({ items: products.filter((p) => p.title.toLowerCase().includes(q)) });
    }
    if (req.method === "GET" && (m = caminho.match(/^\/api\/v1\/products\/([^/]+)\/stock$/))) {
      const sku = decodeURIComponent(m[1]);
      return stock[sku] ? json({ sku, ...stock[sku] }) : json({ error: "not_found" }, 404);
    }
    if (req.method === "GET" && (m = caminho.match(/^\/api\/v1\/customers\/([^/]+)\/orders$/))) {
      const id = decodeURIComponent(m[1]);
      return json({
        orders: orders.filter((o) => o.customer_id === id).map(({ customer_id: _, ...o }) => o),
      });
    }
    if (
      req.method === "GET" &&
      (m = caminho.match(/^\/api\/v1\/customers\/([^/]+)\/receivables$/))
    ) {
      const id = decodeURIComponent(m[1]);
      const status = url.searchParams.get("status");
      return json({
        receivables: receivables
          .filter((r) => r.customer_id === id && (!status || r.status === status))
          .map(({ customer_id: _, status: __, ...r }) => r),
      });
    }
    if (req.method === "POST" && caminho === "/api/v1/orders") {
      const chave = req.headers.get("idempotency-key");
      if (chave && idempotencia.has(chave)) return json(idempotencia.get(chave), 200);
      const corpo = await req.json().catch(() => null);
      const linhas = corpo?.lines;
      if (
        !customers.some((c) => c.id === corpo?.customer_id) || !Array.isArray(linhas) ||
        linhas.length === 0
      ) {
        return json({ error: "invalid_order" }, 422);
      }
      let total = 0;
      for (const l of linhas) {
        const p = products.find((x) => x.sku === l?.sku);
        if (!p || typeof l.qty !== "number" || l.qty <= 0) {
          return json({ error: "invalid_line" }, 422);
        }
        total += Math.round(p.price_cents * l.qty);
      }
      const pedido: Pedido = {
        number: `PED-${1001 + orders.length}`,
        customer_id: corpo.customer_id,
        state: "pending",
        total_cents: total,
        placed_at: new Date().toISOString().slice(0, 10),
      };
      orders.push(pedido);
      if (chave) idempotencia.set(chave, pedido);
      const { customer_id: _, ...publico } = pedido;
      return json(publico, 201);
    }
    return json({ error: "not_found" }, 404);
  }

  return { tratar, pedidos: orders };
}

if (import.meta.main) {
  const porta = Number(Deno.env.get("ERP_SIMULADO_PORTA") ?? 8787);
  const erp = criarErpSimulado(Deno.env.get("ERP_SIMULADO_TOKEN") ?? TOKEN_PADRAO);
  Deno.serve({ port: porta, hostname: "127.0.0.1" }, erp.tratar);
}
