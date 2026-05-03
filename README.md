# MCP LatAm Business Suite

Latin American business compliance suite for AI agents — **28 tools** covering tax ID validation, banking validation, e-invoicing rules, VAT calculations, and labor calendar helpers for **Brazil, Mexico, Chile, Argentina, and Colombia**.

Part of [MCPize](https://mcpize.com) — regional MCP servers for AI agents.

## Coverage

| Country | Tax IDs | Banking | Holidays | E-Invoicing |
|---------|---------|---------|----------|-------------|
| 🇧🇷 Brazil | CPF, CNPJ | PIX | ✓ | NF-e / NF-C / NFS-e |
| 🇲🇽 Mexico | RFC | CLABE | ✓ | CFDI 4.0 |
| 🇨🇱 Chile | RUT | — | ✓ | DTE |
| 🇦🇷 Argentina | CUIT, CUIL | CBU | ✓ | Factura Electrónica |
| 🇨🇴 Colombia | NIT, CC | — | ✓ | Factura Electrónica |

## Tools (28 total)

**Validation (17):** `validate_cpf`, `validate_cnpj`, `validate_pix_key`, `validate_rfc_mx`, `validate_rut_cl`, `validate_cuit`, `validate_cuil`, `validate_nit_co`, `validate_cc_co`, `validate_clabe_mx`, `validate_cbu_ar`, `validate_postal_code_latam`, `get_brazil_holidays`, `get_mexico_holidays`, `get_chile_holidays`, `get_argentina_holidays`, `get_colombia_holidays`

**Business Rules (4):** `get_payment_terms_latam`, `get_invoice_requirements_latam`, `get_vat_rules_latam`, `get_einvoicing_rules_latam`

**Labor Helpers (3):** `get_public_holidays_range_latam`, `calculate_working_days_latam`, `get_next_payment_date_latam`

**Invoice & VAT (4):** `validate_invoice_schema_latam`, `calculate_vat_breakdown_latam`, `suggest_vat_treatment_latam`, `calculate_vat_amount_latam`

## Local development

```bash
npm install
npm start           # stdio transport (for Glama / Claude Desktop)
npm run start:http  # HTTP transport on port 8080 (for Railway / hosted use)
```

## Endpoints (HTTP mode)

- `GET /` — server metadata and tool list
- `GET /health` — health check (returns `{"status":"ok"}`)
- `POST /mcp` — MCP Streamable HTTP endpoint

## Deployment

### Railway

1. Push this repo to GitHub
2. Create new Railway project → Deploy from GitHub repo
3. Railway auto-detects the `Dockerfile` and `railway.json`
4. `MCP_HTTP=true` is set by the Dockerfile; no env vars needed
5. Public URL becomes the MCP HTTP endpoint at `/mcp`

### Glama / Claude Desktop (stdio)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "latam-business": {
      "command": "npx",
      "args": ["-y", "mcp-latam-business"]
    }
  }
}
```

## Disclaimer

All compliance, tax, and legal information returned by these tools is **reference only — not legal or tax advice**. Tax rates, e-invoicing rules, and holiday calendars change frequently. Always verify with the relevant tax authority and a qualified professional before use in production.

## License

MIT
