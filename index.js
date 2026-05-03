import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import http from "http";

// ════════════════════════════════════════════════
// SHARED HELPERS (timezone-safe)
// ════════════════════════════════════════════════

// Format Date as YYYY-MM-DD using LOCAL time (avoids UTC offset bugs)
const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };

const getEaster = (y) => {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(y, month - 1, day);
};

const nextMondayCO = (d) => { const r = new Date(d); const day = r.getDay(); if (day !== 1) r.setDate(r.getDate() + (8 - day) % 7); return r; };

// Returns array of YYYY-MM-DD strings of moveable (Easter-based) holidays for a country/year
const getMoveableHolidayDates = (year, country) => {
  const easter = getEaster(year);
  const dates = [];
  if (country === "BR") {
    dates.push(fmt(addDays(easter, -48))); // Carnaval Segunda
    dates.push(fmt(addDays(easter, -47))); // Carnaval Terça
    dates.push(fmt(addDays(easter, -2)));  // Sexta-feira Santa
    dates.push(fmt(addDays(easter, 60)));  // Corpus Christi
  }
  if (country === "CL") {
    dates.push(fmt(addDays(easter, -2))); // Viernes Santo
    dates.push(fmt(addDays(easter, -1))); // Sábado Santo
  }
  if (country === "AR") {
    dates.push(fmt(addDays(easter, -48))); // Carnaval Lunes
    dates.push(fmt(addDays(easter, -47))); // Carnaval Martes
    dates.push(fmt(addDays(easter, -2)));  // Viernes Santo
  }
  if (country === "CO") {
    dates.push(fmt(nextMondayCO(addDays(easter, -3))));  // Jueves Santo
    dates.push(fmt(addDays(easter, -2)));                 // Viernes Santo (not moved)
    dates.push(fmt(nextMondayCO(addDays(easter, 39))));   // Ascensión
    dates.push(fmt(nextMondayCO(addDays(easter, 60))));   // Corpus Christi
    dates.push(fmt(nextMondayCO(addDays(easter, 68))));   // Sagrado Corazón
  }
  return dates;
};

const FIXED_HOLIDAYS = {
  BR: ["01-01","04-21","05-01","09-07","10-12","11-02","11-15","11-20","12-25"],
  MX: ["01-01","05-01","09-16","12-25"],
  CL: ["01-01","05-01","05-21","06-20","06-29","07-16","08-15","09-18","09-19","10-12","10-31","11-01","12-08","12-25"],
  AR: ["01-01","03-24","04-02","05-01","05-25","06-20","07-09","08-17","10-12","11-20","12-08","12-25"],
  CO: ["01-01","05-01","07-20","08-07","12-08","12-25"],
};

// ════════════════════════════════════════════════
// SERVER FACTORY
// ════════════════════════════════════════════════

const createServer = () => {
  const server = new McpServer({
    name: "mcp-latam-business",
    version: "1.0.0",
    description: "Latin American business compliance suite for AI agents. Covers tax ID validation for BR, MX, CL, AR, CO; PIX/CLABE/CBU banking validation; VAT rules and invoice requirements for LatAm countries; e-invoicing obligations (NF-e, CFDI, DTE); labor calendar helpers; and invoice/VAT calculation tools. No auth required, read-only, offline."
  });

  // ════════════════════════════════════════════════
  // MODULE 1 — VALIDATION (17 tools)
  // ════════════════════════════════════════════════

  // ── 1. Validate Brazilian CPF ──
  server.registerTool("validate_cpf", {
    description: "Validates a Brazilian CPF (Cadastro de Pessoas Físicas) — the 11-digit individual taxpayer identification number issued by the Receita Federal. Applies the official two-pass modulo-11 checksum algorithm. Returns { valid: boolean, cpf: string } for valid CPFs, or { valid: false, reason: string } for invalid format or failed checksum. Rejects known invalid sequences (all same digits). Use when processing Brazilian e-commerce orders, fintech onboarding, KYC flows, or any compliance workflow requiring a verified Brazilian individual tax ID. Offline validation only — does not query Receita Federal.",
    inputSchema: { cpf: z.string().describe("11-digit Brazilian CPF, with or without formatting. Example: '123.456.789-09' or '12345678909'") },
    outputSchema: { valid: z.boolean(), cpf: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Brazilian CPF", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ cpf }) => {
    const clean = cpf.replace(/[\.\-]/g, "").replace(/\s/g, "");
    if (!/^\d{11}$/.test(clean)) { const r = { valid: false, reason: "CPF must have exactly 11 digits" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    if (/^(\d)\1{10}$/.test(clean)) { const r = { valid: false, reason: "Invalid CPF — all digits are the same" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(clean[i]) * (10 - i);
    let remainder = (sum * 10) % 11;
    if (remainder === 10 || remainder === 11) remainder = 0;
    if (remainder !== parseInt(clean[9])) { const r = { valid: false, reason: "Invalid CPF checksum" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(clean[i]) * (11 - i);
    remainder = (sum * 10) % 11;
    if (remainder === 10 || remainder === 11) remainder = 0;
    const valid = remainder === parseInt(clean[10]);
    const r = { valid, cpf: clean };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 2. Validate Brazilian CNPJ ──
  server.registerTool("validate_cnpj", {
    description: "Validates a Brazilian CNPJ (Cadastro Nacional da Pessoa Jurídica) — the 14-digit company registration number issued by the Receita Federal. Applies the official two-pass weighted checksum algorithm. Returns { valid: boolean, cnpj: string } for valid CNPJs, or { valid: false, reason: string } for invalid format or failed checksum. Use when processing Brazilian B2B invoices (Notas Fiscais), supplier onboarding, or any compliance workflow requiring a verified Brazilian company tax ID. Offline validation only.",
    inputSchema: { cnpj: z.string().describe("14-digit Brazilian CNPJ, with or without formatting. Example: '11.222.333/0001-81' or '11222333000181'") },
    outputSchema: { valid: z.boolean(), cnpj: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Brazilian CNPJ", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ cnpj }) => {
    const clean = cnpj.replace(/[\.\-\/]/g, "").replace(/\s/g, "");
    if (!/^\d{14}$/.test(clean)) { const r = { valid: false, reason: "CNPJ must have exactly 14 digits" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    if (/^(\d)\1{13}$/.test(clean)) { const r = { valid: false, reason: "Invalid CNPJ — all digits are the same" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const calcDigit = (cnpj, length) => {
      let sum = 0, pos = length - 7;
      for (let i = length; i >= 1; i--) { sum += parseInt(cnpj[length - i]) * pos--; if (pos < 2) pos = 9; }
      const result = sum % 11 < 2 ? 0 : 11 - (sum % 11);
      return result;
    };
    const valid = calcDigit(clean, 12) === parseInt(clean[12]) && calcDigit(clean, 13) === parseInt(clean[13]);
    const r = { valid, cnpj: clean };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 3. Validate Brazilian PIX Key ──
  server.registerTool("validate_pix_key", {
    description: "Validates a Brazilian PIX key — the instant payment identifier used by Brazil's central bank payment system (Banco Central do Brasil). Supports all 4 PIX key types: CPF (11 digits), CNPJ (14 digits), email address, phone number (+55 format), and EVP (random UUID key). Returns { valid: boolean, type: 'cpf'|'cnpj'|'email'|'phone'|'evp', key: string } or { valid: false, reason: string }. Use when processing PIX transfers, validating payment recipients, or building Brazilian payment flows in AI agents.",
    inputSchema: { key: z.string().describe("PIX key to validate. Can be CPF, CNPJ, email, phone (+5511999999999) or EVP UUID. Example: 'user@email.com' or '+5511987654321'") },
    outputSchema: { valid: z.boolean(), type: z.enum(["cpf","cnpj","email","phone","evp"]).optional(), key: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Brazilian PIX Key", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ key }) => {
    const clean = key.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clean)) {
      const r = { valid: true, type: "evp", key: clean }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
    }
    const digits = clean.replace(/[\.\-\/]/g, "");
    if (/^\d{11}$/.test(digits)) { const r = { valid: true, type: "cpf", key: digits }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    if (/^\d{14}$/.test(digits)) { const r = { valid: true, type: "cnpj", key: digits }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) { const r = { valid: true, type: "email", key: clean }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    if (/^\+55\d{10,11}$/.test(clean)) { const r = { valid: true, type: "phone", key: clean }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const r = { valid: false, reason: "Not a valid PIX key. Expected CPF, CNPJ, email, phone (+55...) or EVP UUID" };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 4. Get Brazil Holidays ──
  server.registerTool("get_brazil_holidays", {
    description: "Returns all Brazilian national public holidays for a given year as a structured list. Each holiday includes { date: 'YYYY-MM-DD', name: string, name_en: string }. Moveable holidays (Carnival, Good Friday, Corpus Christi) are dynamically calculated using the Easter algorithm. Returns 12 national holidays defined by Brazilian federal law. Use when calculating business deadlines, invoice payment dates, SLA periods, or scheduling tasks that must avoid non-working days in Brazil.",
    inputSchema: { year: z.number().describe("Calendar year as a 4-digit integer. Example: 2026") },
    outputSchema: { year: z.number(), country: z.string(), total_holidays: z.number(), holidays: z.array(z.object({ date: z.string(), name: z.string(), name_en: z.string() })) },
    annotations: { title: "Get Brazil Public Holidays", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ year }) => {
    const easter = getEaster(year);
    const holidays = [
      { date: `${year}-01-01`, name: "Ano Novo", name_en: "New Year's Day" },
      { date: fmt(addDays(easter, -48)), name: "Carnaval (Segunda)", name_en: "Carnival Monday" },
      { date: fmt(addDays(easter, -47)), name: "Carnaval (Terça)", name_en: "Carnival Tuesday" },
      { date: fmt(addDays(easter, -2)), name: "Sexta-feira Santa", name_en: "Good Friday" },
      { date: fmt(easter), name: "Páscoa", name_en: "Easter Sunday" },
      { date: `${year}-04-21`, name: "Tiradentes", name_en: "Tiradentes Day" },
      { date: `${year}-05-01`, name: "Dia do Trabalho", name_en: "Labour Day" },
      { date: fmt(addDays(easter, 60)), name: "Corpus Christi", name_en: "Corpus Christi" },
      { date: `${year}-09-07`, name: "Independência do Brasil", name_en: "Independence Day" },
      { date: `${year}-10-12`, name: "Nossa Senhora Aparecida", name_en: "Our Lady of Aparecida" },
      { date: `${year}-11-02`, name: "Finados", name_en: "All Souls' Day" },
      { date: `${year}-11-15`, name: "Proclamação da República", name_en: "Republic Day" },
      { date: `${year}-11-20`, name: "Consciência Negra", name_en: "Black Consciousness Day" },
      { date: `${year}-12-25`, name: "Natal", name_en: "Christmas Day" },
    ];
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    const r = { year, country: "Brazil", total_holidays: holidays.length, holidays };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 5. Validate Mexican RFC ──
  server.registerTool("validate_rfc_mx", {
    description: "Validates a Mexican RFC (Registro Federal de Contribuyentes) — the tax identification number issued by the SAT (Servicio de Administración Tributaria). Validates format for both individuals (13 characters: 4 letters + 6 digit date + 3 alphanumeric homoclave) and companies (12 characters: 3 letters + 6 digit date + 3 alphanumeric homoclave). Returns { valid: boolean, type: 'individual'|'company', rfc: string } or { valid: false, reason: string }. Use when processing Mexican CFDI invoices, supplier registration, or any Mexican tax compliance workflow.",
    inputSchema: { rfc: z.string().describe("Mexican RFC with or without spaces. Example: 'ABCD850101ABC' (individual) or 'ABC850101AB1' (company)") },
    outputSchema: { valid: z.boolean(), type: z.enum(["individual","company"]).optional(), rfc: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Mexican RFC", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ rfc }) => {
    const clean = rfc.replace(/\s/g, "").toUpperCase();
    if (/^[A-Z]{4}\d{6}[A-Z0-9]{3}$/.test(clean)) {
      const r = { valid: true, type: "individual", rfc: clean }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
    }
    if (/^[A-Z]{3}\d{6}[A-Z0-9]{3}$/.test(clean)) {
      const r = { valid: true, type: "company", rfc: clean }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
    }
    const r = { valid: false, reason: "RFC format not recognized. Individual: 4 letters + 6 digits + 3 alphanumeric. Company: 3 letters + 6 digits + 3 alphanumeric." };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 6. Get Mexico Holidays ──
  server.registerTool("get_mexico_holidays", {
    description: "Returns all Mexican national public holidays for a given year as a structured list. Each holiday includes { date: 'YYYY-MM-DD', name: string, name_en: string }. Moveable holidays (Constitution Day, President's Day, Revolution Day) follow the Mexican Monday rule (primer lunes de febrero/tercer lunes de noviembre). Returns 9 mandatory national holidays defined by Mexican law. Use when calculating Mexican business deadlines, CFDI payment dates, or scheduling tasks that must avoid non-working days in Mexico.",
    inputSchema: { year: z.number().describe("Calendar year as a 4-digit integer. Example: 2026") },
    outputSchema: { year: z.number(), country: z.string(), total_holidays: z.number(), holidays: z.array(z.object({ date: z.string(), name: z.string(), name_en: z.string() })) },
    annotations: { title: "Get Mexico Public Holidays", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ year }) => {
    const firstMonday = (y, m) => { const d = new Date(y, m - 1, 1); return new Date(y, m - 1, 1 + (8 - d.getDay()) % 7); };
    const thirdMonday = (y, m) => { const fm = firstMonday(y, m); return new Date(fm.getTime() + 14 * 86400000); };
    const holidays = [
      { date: `${year}-01-01`, name: "Año Nuevo", name_en: "New Year's Day" },
      { date: fmt(firstMonday(year, 2)), name: "Día de la Constitución", name_en: "Constitution Day" },
      { date: fmt(thirdMonday(year, 3)), name: "Natalicio de Benito Juárez", name_en: "Benito Juárez's Birthday" },
      { date: `${year}-05-01`, name: "Día del Trabajo", name_en: "Labour Day" },
      { date: `${year}-09-16`, name: "Día de la Independencia", name_en: "Independence Day" },
      { date: fmt(thirdMonday(year, 11)), name: "Día de la Revolución", name_en: "Revolution Day" },
      { date: `${year}-12-25`, name: "Navidad", name_en: "Christmas Day" },
    ];
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    const r = { year, country: "Mexico", total_holidays: holidays.length, holidays };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 7. Validate Chilean RUT ──
  server.registerTool("validate_rut_cl", {
    description: "Validates a Chilean RUT (Rol Único Tributario) — the tax identification number used by individuals and companies in Chile, issued by the SII (Servicio de Impuestos Internos). Applies the official modulo-11 checksum algorithm with check digit 'K' support. Returns { valid: boolean, rut: string, check_digit: string } or { valid: false, reason: string }. Use when processing Chilean DTE electronic invoices, supplier registration, or any Chilean tax compliance workflow. Accepts formats with or without dots and dash.",
    inputSchema: { rut: z.string().describe("Chilean RUT with or without formatting. Example: '12.345.678-9' or '12345678-9' or '123456789'") },
    outputSchema: { valid: z.boolean(), rut: z.string().optional(), check_digit: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Chilean RUT", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ rut }) => {
    const clean = rut.replace(/\./g, "").replace(/\s/g, "").toUpperCase();
    const match = clean.match(/^(\d{7,8})-?([0-9K])$/);
    if (!match) { const r = { valid: false, reason: "RUT format not recognized. Expected: 12345678-9 or 12345678K" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const body = match[1], checkDigit = match[2];
    let sum = 0, multiplier = 2;
    for (let i = body.length - 1; i >= 0; i--) {
      sum += parseInt(body[i]) * multiplier;
      multiplier = multiplier === 7 ? 2 : multiplier + 1;
    }
    const remainder = 11 - (sum % 11);
    let expected;
    if (remainder === 11) expected = "0";
    else if (remainder === 10) expected = "K";
    else expected = remainder.toString();
    const valid = checkDigit === expected;
    const r = { valid, rut: `${body}-${checkDigit}`, check_digit: checkDigit };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 8. Get Chile Holidays ──
  server.registerTool("get_chile_holidays", {
    description: "Returns all Chilean national public holidays for a given year as a structured list. Each holiday includes { date: 'YYYY-MM-DD', name: string, name_en: string }. Easter-dependent holidays (Good Friday, Holy Saturday) are dynamically calculated. Returns 16 mandatory national holidays defined by Chilean law. Use when calculating Chilean business deadlines, DTE invoice dates, or scheduling tasks that must avoid non-working days in Chile.",
    inputSchema: { year: z.number().describe("Calendar year as a 4-digit integer. Example: 2026") },
    outputSchema: { year: z.number(), country: z.string(), total_holidays: z.number(), holidays: z.array(z.object({ date: z.string(), name: z.string(), name_en: z.string() })) },
    annotations: { title: "Get Chile Public Holidays", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ year }) => {
    const easter = getEaster(year);
    const holidays = [
      { date: `${year}-01-01`, name: "Año Nuevo", name_en: "New Year's Day" },
      { date: fmt(addDays(easter, -2)), name: "Viernes Santo", name_en: "Good Friday" },
      { date: fmt(addDays(easter, -1)), name: "Sábado Santo", name_en: "Holy Saturday" },
      { date: `${year}-05-01`, name: "Día del Trabajo", name_en: "Labour Day" },
      { date: `${year}-05-21`, name: "Día de las Glorias Navales", name_en: "Navy Day" },
      { date: `${year}-06-20`, name: "Día Nacional de los Pueblos Indígenas", name_en: "Indigenous Peoples' Day" },
      { date: `${year}-06-29`, name: "San Pedro y San Pablo", name_en: "Saints Peter and Paul" },
      { date: `${year}-07-16`, name: "Virgen del Carmen", name_en: "Our Lady of Mount Carmel" },
      { date: `${year}-08-15`, name: "Asunción de la Virgen", name_en: "Assumption of Mary" },
      { date: `${year}-09-18`, name: "Independencia de Chile", name_en: "Independence Day" },
      { date: `${year}-09-19`, name: "Día de las Glorias del Ejército", name_en: "Army Day" },
      { date: `${year}-10-12`, name: "Encuentro de Dos Mundos", name_en: "Columbus Day" },
      { date: `${year}-10-31`, name: "Día Nacional de las Iglesias Evangélicas", name_en: "Evangelical Church Day" },
      { date: `${year}-11-01`, name: "Día de Todos los Santos", name_en: "All Saints' Day" },
      { date: `${year}-12-08`, name: "Inmaculada Concepción", name_en: "Immaculate Conception" },
      { date: `${year}-12-25`, name: "Navidad", name_en: "Christmas Day" },
    ];
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    const r = { year, country: "Chile", total_holidays: holidays.length, holidays };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 9. Validate Argentine CUIT ──
  server.registerTool("validate_cuit", {
    description: "Validates an Argentine CUIT (Código Único de Identificación Tributaria) — the tax identification number for companies, self-employed workers, and legal entities in Argentina, issued by AFIP (Administración Federal de Ingresos Públicos). Applies the official weighted modulo-11 checksum algorithm. Returns { valid: boolean, cuit: string, type: string } or { valid: false, reason: string }. CUIT prefix identifies entity type: 20/23/24/27 for individuals, 30/33/34 for companies. Use when processing Argentine invoices, supplier registration, or AFIP compliance workflows.",
    inputSchema: { cuit: z.string().describe("Argentine CUIT with or without formatting. Example: '20-12345678-9' or '20123456789'") },
    outputSchema: { valid: z.boolean(), cuit: z.string().optional(), type: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Argentine CUIT", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ cuit }) => {
    const clean = cuit.replace(/[\-\s]/g, "");
    if (!/^\d{11}$/.test(clean)) { const r = { valid: false, reason: "CUIT must have exactly 11 digits" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(clean[i]) * weights[i];
    const remainder = 11 - (sum % 11);
    const checkDigit = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
    const valid = checkDigit === parseInt(clean[10]);
    const prefix = parseInt(clean.substring(0, 2));
    const typeMap = { 20: "Individual male", 23: "Individual", 24: "Individual", 27: "Individual female", 30: "Company", 33: "Company", 34: "Company" };
    const type = typeMap[prefix] || "Unknown";
    const r = { valid, cuit: clean, type };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 10. Validate Argentine CUIL ──
  server.registerTool("validate_cuil", {
    description: "Validates an Argentine CUIL (Código Único de Identificación Laboral) — the labor identification number for individuals in Argentina, used for employment records and social security (ANSES). Uses the same weighted modulo-11 checksum as CUIT. Returns { valid: boolean, cuil: string } or { valid: false, reason: string }. Use when processing Argentine payroll, employment contracts, or any social security compliance workflow.",
    inputSchema: { cuil: z.string().describe("Argentine CUIL with or without formatting. Example: '20-12345678-9' or '20123456789'") },
    outputSchema: { valid: z.boolean(), cuil: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Argentine CUIL", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ cuil }) => {
    const clean = cuil.replace(/[\-\s]/g, "");
    if (!/^\d{11}$/.test(clean)) { const r = { valid: false, reason: "CUIL must have exactly 11 digits" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 10; i++) sum += parseInt(clean[i]) * weights[i];
    const remainder = 11 - (sum % 11);
    const checkDigit = remainder === 11 ? 0 : remainder === 10 ? 9 : remainder;
    const valid = checkDigit === parseInt(clean[10]);
    const r = { valid, cuil: clean };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 11. Get Argentina Holidays ──
  server.registerTool("get_argentina_holidays", {
    description: "Returns all Argentine national public holidays for a given year as a structured list. Each holiday includes { date: 'YYYY-MM-DD', name: string, name_en: string }. Moveable holidays (Carnival, Good Friday) are dynamically calculated. Returns 15 national holidays defined by Argentine law. Use when calculating Argentine business deadlines, invoice payment dates, or scheduling tasks that must avoid non-working days in Argentina.",
    inputSchema: { year: z.number().describe("Calendar year as a 4-digit integer. Example: 2026") },
    outputSchema: { year: z.number(), country: z.string(), total_holidays: z.number(), holidays: z.array(z.object({ date: z.string(), name: z.string(), name_en: z.string() })) },
    annotations: { title: "Get Argentina Public Holidays", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ year }) => {
    const easter = getEaster(year);
    const holidays = [
      { date: `${year}-01-01`, name: "Año Nuevo", name_en: "New Year's Day" },
      { date: fmt(addDays(easter, -48)), name: "Carnaval (Lunes)", name_en: "Carnival Monday" },
      { date: fmt(addDays(easter, -47)), name: "Carnaval (Martes)", name_en: "Carnival Tuesday" },
      { date: `${year}-03-24`, name: "Día Nacional de la Memoria", name_en: "Day of Remembrance" },
      { date: `${year}-04-02`, name: "Día del Veterano de Malvinas", name_en: "Malvinas Veterans Day" },
      { date: fmt(addDays(easter, -2)), name: "Viernes Santo", name_en: "Good Friday" },
      { date: `${year}-05-01`, name: "Día del Trabajador", name_en: "Labour Day" },
      { date: `${year}-05-25`, name: "Revolución de Mayo", name_en: "May Revolution Day" },
      { date: `${year}-06-20`, name: "Paso a la Inmortalidad del Gral. Belgrano", name_en: "Flag Day" },
      { date: `${year}-07-09`, name: "Día de la Independencia", name_en: "Independence Day" },
      { date: `${year}-08-17`, name: "Paso a la Inmortalidad del Gral. San Martín", name_en: "San Martín Day" },
      { date: `${year}-10-12`, name: "Día del Respeto a la Diversidad Cultural", name_en: "Cultural Diversity Day" },
      { date: `${year}-11-20`, name: "Día de la Soberanía Nacional", name_en: "National Sovereignty Day" },
      { date: `${year}-12-08`, name: "Inmaculada Concepción", name_en: "Immaculate Conception" },
      { date: `${year}-12-25`, name: "Navidad", name_en: "Christmas Day" },
    ];
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    const r = { year, country: "Argentina", total_holidays: holidays.length, holidays };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 12. Validate Colombian NIT ──
  server.registerTool("validate_nit_co", {
    description: "Validates a Colombian NIT (Número de Identificación Tributaria) — the tax identification number for companies and legal entities in Colombia, issued by the DIAN (Dirección de Impuestos y Aduanas Nacionales). Applies the official weighted modulo-11 checksum algorithm with the DIAN verification digit. Returns { valid: boolean, nit: string, verification_digit: string } or { valid: false, reason: string }. Use when processing Colombian electronic invoices (factura electrónica), supplier registration, or DIAN compliance workflows.",
    inputSchema: { nit: z.string().describe("Colombian NIT with or without verification digit. Example: '900123456-7' or '9001234567'") },
    outputSchema: { valid: z.boolean(), nit: z.string().optional(), verification_digit: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Colombian NIT", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ nit }) => {
    const clean = nit.replace(/[\.\-\s]/g, "");
    if (!/^\d{9,10}$/.test(clean)) { const r = { valid: false, reason: "NIT must have 9 digits (without verification digit) or 10 digits (with verification digit)" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const body = clean.length === 10 ? clean.substring(0, 9) : clean;
    const providedDigit = clean.length === 10 ? clean[9] : null;
    const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += parseInt(body[i]) * weights[i];
    const remainder = sum % 11;
    const verificationDigit = remainder < 2 ? remainder : 11 - remainder;
    if (providedDigit !== null) {
      const valid = parseInt(providedDigit) === verificationDigit;
      const r = { valid, nit: body, verification_digit: verificationDigit.toString() };
      return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
    }
    const r = { valid: true, nit: body, verification_digit: verificationDigit.toString() };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 13. Validate Colombian CC ──
  server.registerTool("validate_cc_co", {
    description: "Validates the format of a Colombian Cédula de Ciudadanía (CC) — the national identity document for Colombian citizens. Verifies that the number is between 6 and 10 digits as required by the Registraduría Nacional. Returns { valid: boolean, cc: string } or { valid: false, reason: string }. Use when processing Colombian individual tax filings, employment contracts, or KYC onboarding flows requiring a verified Colombian citizen ID. Note: checksum validation is not publicly available for CC numbers.",
    inputSchema: { cc: z.string().describe("Colombian Cédula de Ciudadanía number. Example: '1234567890'") },
    outputSchema: { valid: z.boolean(), cc: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Colombian Cédula de Ciudadanía", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ cc }) => {
    const clean = cc.replace(/[\.\-\s]/g, "");
    if (!/^\d{6,10}$/.test(clean)) { const r = { valid: false, reason: "Colombian CC must be between 6 and 10 digits" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const r = { valid: true, cc: clean };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 14. Validate Mexican CLABE ──
  server.registerTool("validate_clabe_mx", {
    description: "Validates a Mexican CLABE (Clave Bancaria Estandarizada) — the 18-digit standardized bank account number used for electronic transfers in Mexico, as defined by BANXICO (Banco de México). Applies the official weighted modulo-10 checksum algorithm (weights: 3,7,1 repeating). Returns { valid: boolean, clabe: string, bank_code: string, city_code: string } or { valid: false, reason: string }. Use when processing Mexican wire transfers, validating supplier bank accounts, or building Mexican payment flows in AI agents.",
    inputSchema: { clabe: z.string().describe("18-digit Mexican CLABE bank account number. Example: '032180000118359719'") },
    outputSchema: { valid: z.boolean(), clabe: z.string().optional(), bank_code: z.string().optional(), city_code: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Mexican CLABE", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ clabe }) => {
    const clean = clabe.replace(/\s/g, "");
    if (!/^\d{18}$/.test(clean)) { const r = { valid: false, reason: "CLABE must have exactly 18 digits" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const weights = [3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7, 1, 3, 7];
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += parseInt(clean[i]) * weights[i];
    const checkDigit = (10 - (sum % 10)) % 10;
    const valid = checkDigit === parseInt(clean[17]);
    const r = { valid, clabe: clean, bank_code: clean.substring(0, 3), city_code: clean.substring(3, 6) };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 15. Validate Argentine CBU ──
  server.registerTool("validate_cbu_ar", {
    description: "Validates an Argentine CBU (Clave Bancaria Uniforme) — the 22-digit standardized bank account identifier used for electronic transfers in Argentina, as defined by BCRA (Banco Central de la República Argentina). Applies the official weighted modulo-10 checksum algorithm validated in two blocks: the 8-digit bank/branch block and the 14-digit account block. Returns { valid: boolean, cbu: string, bank_code: string } or { valid: false, reason: string }. Use when processing Argentine wire transfers, validating supplier bank accounts, or building Argentine payment flows.",
    inputSchema: { cbu: z.string().describe("22-digit Argentine CBU bank account number. Example: '0720309988000019834160'") },
    outputSchema: { valid: z.boolean(), cbu: z.string().optional(), bank_code: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate Argentine CBU", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ cbu }) => {
    const clean = cbu.replace(/\s/g, "");
    if (!/^\d{22}$/.test(clean)) { const r = { valid: false, reason: "CBU must have exactly 22 digits" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const checkBlock = (block, weights) => {
      let sum = 0;
      for (let i = 0; i < block.length - 1; i++) sum += parseInt(block[i]) * weights[i];
      const check = (10 - (sum % 10)) % 10;
      return check === parseInt(block[block.length - 1]);
    };
    const block1 = clean.substring(0, 8);
    const block2 = clean.substring(8, 22);
    const weights1 = [7, 1, 3, 9, 7, 1, 3];
    const weights2 = [3, 9, 7, 1, 3, 9, 7, 1, 3, 9, 7, 1, 3];
    const valid = checkBlock(block1, weights1) && checkBlock(block2, weights2);
    const r = { valid, cbu: clean, bank_code: clean.substring(0, 3) };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 16. Get Colombia Holidays ──
  server.registerTool("get_colombia_holidays", {
    description: "Returns all Colombian national public holidays for a given year as a structured list. Each holiday includes { date: 'YYYY-MM-DD', name: string, name_en: string }. Colombia uses the 'Ley de Puentes' (Law 51/1983) which moves most holidays to the following Monday. Easter-dependent holidays are dynamically calculated. Returns 18 national holidays defined by Colombian law. Use when calculating Colombian business deadlines, factura electrónica payment dates, or scheduling tasks avoiding non-working days in Colombia.",
    inputSchema: { year: z.number().describe("Calendar year as a 4-digit integer. Example: 2026") },
    outputSchema: { year: z.number(), country: z.string(), total_holidays: z.number(), holidays: z.array(z.object({ date: z.string(), name: z.string(), name_en: z.string() })) },
    annotations: { title: "Get Colombia Public Holidays", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ year }) => {
    const easter = getEaster(year);
    const holidays = [
      { date: `${year}-01-01`, name: "Año Nuevo", name_en: "New Year's Day" },
      { date: fmt(nextMondayCO(new Date(year, 0, 6))), name: "Reyes Magos", name_en: "Epiphany" },
      { date: fmt(nextMondayCO(new Date(year, 2, 19))), name: "San José", name_en: "St Joseph's Day" },
      { date: fmt(addDays(easter, -3)), name: "Jueves Santo", name_en: "Holy Thursday" },
      { date: fmt(addDays(easter, -2)), name: "Viernes Santo", name_en: "Good Friday" },
      { date: `${year}-05-01`, name: "Día del Trabajo", name_en: "Labour Day" },
      { date: fmt(nextMondayCO(addDays(easter, 39))), name: "Ascensión", name_en: "Ascension Day" },
      { date: fmt(nextMondayCO(addDays(easter, 60))), name: "Corpus Christi", name_en: "Corpus Christi" },
      { date: fmt(nextMondayCO(addDays(easter, 68))), name: "Sagrado Corazón", name_en: "Sacred Heart" },
      { date: fmt(nextMondayCO(new Date(year, 5, 29))), name: "San Pedro y San Pablo", name_en: "Saints Peter and Paul" },
      { date: `${year}-07-20`, name: "Independencia de Colombia", name_en: "Independence Day" },
      { date: `${year}-08-07`, name: "Batalla de Boyacá", name_en: "Battle of Boyacá" },
      { date: fmt(nextMondayCO(new Date(year, 7, 15))), name: "Asunción de la Virgen", name_en: "Assumption of Mary" },
      { date: fmt(nextMondayCO(new Date(year, 9, 12))), name: "Día de la Raza", name_en: "Columbus Day" },
      { date: fmt(nextMondayCO(new Date(year, 10, 1))), name: "Todos los Santos", name_en: "All Saints' Day" },
      { date: fmt(nextMondayCO(new Date(year, 10, 11))), name: "Independencia de Cartagena", name_en: "Cartagena Independence" },
      { date: `${year}-12-08`, name: "Inmaculada Concepción", name_en: "Immaculate Conception" },
      { date: `${year}-12-25`, name: "Navidad", name_en: "Christmas Day" },
    ];
    holidays.sort((a, b) => a.date.localeCompare(b.date));
    const r = { year, country: "Colombia", total_holidays: holidays.length, holidays };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 17. Validate LatAm Postal Code ──
  server.registerTool("validate_postal_code_latam", {
    description: "Validates a postal code format for a given Latin American country using the official pattern for that country. Returns { valid: boolean, postal_code: string, country: string, format: string }. Supports BR (8-digit CEP), MX (5-digit CP), CL (7-digit with dash), AR (4-digit legacy or CPA alphanumeric), CO (6-digit). Use in e-commerce checkout validation, address verification, or logistics workflows across LatAm markets.",
    inputSchema: {
      postal_code: z.string().describe("Postal code to validate. Example: '01310-100' for BR, '06600' for MX, '8320000' for CL"),
      country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CL', 'AR', 'CO'")
    },
    outputSchema: { valid: z.boolean(), postal_code: z.string().optional(), country: z.string().optional(), format: z.string().optional(), reason: z.string().optional() },
    annotations: { title: "Validate LatAm Postal Code", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ postal_code, country_code }) => {
    const patterns = {
      BR: { regex: /^\d{5}-?\d{3}$/, format: "NNNNN-NNN (CEP)" },
      MX: { regex: /^\d{5}$/, format: "NNNNN (Código Postal)" },
      CL: { regex: /^\d{3}-?\d{4}$/, format: "NNN-NNNN" },
      AR: { regex: /^\d{4}$|^[A-Z]\d{4}[A-Z]{3}$/, format: "NNNN (legacy) or ANNNNAAA (CPA)" },
      CO: { regex: /^\d{6}$/, format: "NNNNNN" },
    };
    const code = country_code.toUpperCase();
    const pattern = patterns[code];
    if (!pattern) { const r = { valid: false, reason: `Country ${code} not supported. Supported: ${Object.keys(patterns).join(", ")}` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const clean = postal_code.trim().toUpperCase();
    const valid = pattern.regex.test(clean);
    const r = { valid, postal_code: clean, country: code, format: pattern.format };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ════════════════════════════════════════════════
  // MODULE 2 — BUSINESS RULES (4 tools)
  // ════════════════════════════════════════════════

  // ── 18. Get Payment Terms LatAm ──
  server.registerTool("get_payment_terms_latam", {
    description: "Returns the typical and legal B2B payment terms for a given Latin American country — default payment period, common commercial practices, and late payment rules where defined by law. Returns { country, default_days, common_terms, late_payment_notes, currency, notes }. Supports BR, MX, CL, AR, CO. Use when generating invoices, setting payment due dates, or automating accounts receivable workflows in LatAm markets. Information provided as reference only — not legal advice.",
    inputSchema: { country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CL'") },
    outputSchema: { country: z.string().optional(), default_days: z.number().optional(), common_terms: z.array(z.string()).optional(), late_payment_notes: z.string().optional(), currency: z.string().optional(), notes: z.string().optional(), disclaimer: z.string().optional(), error: z.string().optional() },
    annotations: { title: "Get LatAm B2B Payment Terms", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code }) => {
    const terms = {
      BR: { country: "Brazil", default_days: 30, common_terms: ["À vista (immediate)", "Net 30", "Net 60", "Net 90", "2/10 Net 30"], late_payment_notes: "Late payment interest (mora): typically 1%/month + monetary correction (SELIC rate). Multa (penalty) typically 2% of invoice value.", currency: "BRL", notes: "Brazil has no single mandatory payment term law for B2B. Payment terms are contractual. NF-e (Nota Fiscal Eletrônica) must reflect agreed payment dates. Public sector: Lei 8666 mandates payment within 30 days." },
      MX: { country: "Mexico", default_days: 30, common_terms: ["De contado (immediate)", "Net 30", "Net 60", "PPD (Pago en Parcialidades o Diferido)", "PUE (Pago en Una sola Exhibición)"], late_payment_notes: "CFDI must specify payment method (PUE or PPD). Late payment interest governed by contract or Código Civil Federal (legal rate: TIIE + spread).", currency: "MXN", notes: "CFDI 4.0 requires explicit payment method and terms. PPD invoices require complemento de pago when payment is received. Large companies must pay SMEs within 30 days (Ley de Pago Oportuno 2024)." },
      CL: { country: "Chile", default_days: 30, common_terms: ["Contado (immediate)", "Net 30", "Net 60", "Factura a 30/60/90 días"], late_payment_notes: "Ley 20.416 (Estatuto PYME): maximum 60 days for B2B payments to SMEs. Late interest: interés corriente para operaciones no reajustables.", currency: "CLP", notes: "DTE (Documento Tributario Electrónico) required. Chile's Factura Electrónica system managed by SII. Maximum B2B payment term 60 days for SMEs under Ley 20.416." },
      AR: { country: "Argentina", default_days: 30, common_terms: ["Contado (immediate)", "Net 30", "Net 60", "Cheque diferido (postdated check)", "Factura de crédito electrónica MiPyME"], late_payment_notes: "Late interest: tasa activa BNA (Banco Nación Argentina). Factura de Crédito Electrónica MiPyME has mandatory payment within 30-60 days.", currency: "ARS", notes: "High inflation environment — contracts often include indexation clauses. Factura de Crédito Electrónica MiPyME (FCE) is mandatory for B2B invoices above threshold to large companies. AFIP controls e-invoicing." },
      CO: { country: "Colombia", default_days: 30, common_terms: ["De contado (immediate)", "Net 30", "Net 60", "Net 90"], late_payment_notes: "Late interest: interés de mora at maximum legal rate (1.5× interés bancario corriente certified by Superfinanciera).", currency: "COP", notes: "Factura electrónica mandatory for most taxpayers since 2022 via DIAN. Ley 1231 regulates factoring of commercial invoices. Payment terms must be stated in the factura electrónica." },
    };
    const code = country_code.toUpperCase();
    const data = terms[code];
    if (!data) { const r = { error: `Country ${code} not found. Available: ${Object.keys(terms).join(", ")}` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const r = { ...data, disclaimer: "Reference information only — not legal advice. Verify with a qualified professional." };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 19. Get Invoice Requirements LatAm ──
  server.registerTool("get_invoice_requirements_latam", {
    description: "Returns the mandatory fields required on a valid electronic invoice for a given Latin American country, based on official tax authority requirements. Returns { country, invoice_type, mandatory_fields: [], electronic_system, notes }. Covers NF-e/NF-C (Brazil), CFDI 4.0 (Mexico), DTE (Chile), Factura Electrónica (Argentina/Colombia). Use when generating invoices for LatAm customers, validating invoice templates, or building invoice compliance checks in agent workflows. Information provided as reference only — not legal advice.",
    inputSchema: { country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CL', 'AR', 'CO'") },
    outputSchema: { country: z.string().optional(), invoice_type: z.string().optional(), mandatory_fields: z.array(z.string()).optional(), electronic_system: z.string().optional(), notes: z.string().optional(), disclaimer: z.string().optional(), error: z.string().optional() },
    annotations: { title: "Get LatAm Invoice Requirements", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code }) => {
    const requirements = {
      BR: { country: "Brazil", invoice_type: "NF-e (Nota Fiscal Eletrônica) or NF-C (consumidor)", mandatory_fields: ["CNPJ do emitente", "CPF/CNPJ do destinatário", "Número da NF-e", "Série", "Data de emissão", "Natureza da operação", "CFOP (Código Fiscal de Operações)", "Descrição dos produtos/serviços", "NCM/SH (produto) ou código do serviço", "Quantidade e unidade", "Valor unitário e total", "Base de cálculo ICMS", "Alíquota e valor ICMS", "PIS e COFINS", "Chave de acesso (44 digits)", "Protocolo de autorização SEFAZ"], electronic_system: "SEFAZ (Secretaria da Fazenda Estadual) + Receita Federal", notes: "Brazil has the most complex invoice system in LatAm. NF-e for B2B goods, NF-C for B2C retail, NFS-e for services (municipal). DANFE is the printed representation. XML file is the legal document." },
      MX: { country: "Mexico", invoice_type: "CFDI 4.0 (Comprobante Fiscal Digital por Internet)", mandatory_fields: ["RFC del emisor", "RFC del receptor", "Nombre/razón social emisor y receptor", "Domicilio fiscal emisor", "Régimen fiscal emisor y receptor", "Uso del CFDI (receptor)", "Lugar de expedición (código postal)", "Folio fiscal (UUID)", "Fecha y hora de emisión", "Forma de pago (PUE/PPD)", "Método de pago", "Moneda y tipo de cambio", "Descripción, cantidad y unidad (clave SAT)", "Precio unitario", "Subtotal, descuentos, impuestos (IVA/IEPS/ISR)", "Total", "Sello digital SAT y emisor"], electronic_system: "SAT (Servicio de Administración Tributaria) via PAC (Proveedor Autorizado de Certificación)", notes: "CFDI 4.0 mandatory since April 2023. Requires PAC for certification. Cancelación requires receptor acceptance in most cases. Complemento de pago required for PPD payments." },
      CL: { country: "Chile", invoice_type: "Factura Electrónica (DTE - Documento Tributario Electrónico)", mandatory_fields: ["RUT del emisor", "RUT del receptor", "Razón social emisor y receptor", "Giro del emisor", "Dirección emisor y receptor", "Número de folio", "Fecha de emisión", "Descripción de bienes o servicios", "Cantidad, precio unitario y total", "Tasa y monto IVA (19%)", "Monto exento si aplica", "Total", "Código de actividad económica", "Timbre electrónico SII (CAF)"], electronic_system: "SII (Servicio de Impuestos Internos)", notes: "DTE must be sent to SII and to receptor. CAF (Código de Autorización de Folios) required. Boleta electrónica for B2C. XML format mandatory." },
      AR: { country: "Argentina", invoice_type: "Factura Electrónica (tipos A, B, C, M)", mandatory_fields: ["CUIT del emisor", "CUIT del receptor (factura A)", "Punto de venta", "Número de comprobante", "Fecha de emisión", "Concepto (productos/servicios/ambos)", "Descripción y detalle de productos/servicios", "Cantidad, precio unitario", "Subtotal", "Alícuota y monto IVA (21%, 10.5%, 27%, 0%)", "Percepciones si aplica", "Total", "CAE (Código de Autorización Electrónica)", "Fecha de vencimiento CAE"], electronic_system: "AFIP (Administración Federal de Ingresos Públicos) via web service", notes: "Factura A: emisor y receptor IVA responsable inscripto. Factura B: receptor consumidor final o monotributista. Factura C: emisores monotributistas. CAE required before invoice delivery. Factura de Crédito Electrónica MiPyME (FCE) for B2B above threshold." },
      CO: { country: "Colombia", invoice_type: "Factura Electrónica de Venta", mandatory_fields: ["NIT del emisor", "NIT/CC/CE del adquiriente", "Nombre/razón social emisor y receptor", "Dirección emisor", "Número de factura", "Fecha de emisión", "Fecha de vencimiento", "Descripción bienes o servicios", "Cantidad y valor unitario", "Base gravable", "Tarifa y valor IVA (19%, 5%, 0%)", "Valor total", "Forma de pago", "CUFE (Código Único de Factura Electrónica)", "Firma digital"], electronic_system: "DIAN (Dirección de Impuestos y Aduanas Nacionales) via software de facturación o proveedor tecnológico", notes: "Factura electrónica mandatory for most taxpayers since 2022. CUFE is the unique identifier. Nota crédito/débito for corrections. Documento soporte for operations without obligation to invoice." },
    };
    const code = country_code.toUpperCase();
    const data = requirements[code];
    if (!data) { const r = { error: `Country ${code} not found. Available: ${Object.keys(requirements).join(", ")}` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const r = { ...data, disclaimer: "Reference information only — not legal advice. Verify with the relevant tax authority." };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 20. Get VAT Rules LatAm ──
  server.registerTool("get_vat_rules_latam", {
    description: "Returns all VAT/IVA rules for a given Latin American country — standard rate, reduced rates, exempt categories, withholding rules, and special regimes. Returns { country, standard_rate, reduced_rates, exempt_categories, withholding, special_regimes, currency, notes }. Supports BR, MX, CL, AR, CO. Brazil returns ICMS/ISS/PIS/COFINS structure. Use when calculating LatAm invoice taxes, determining correct rate for e-commerce checkout, or building tax compliance workflows. Information provided as reference only — not legal or tax advice.",
    inputSchema: { country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CL', 'AR', 'CO'") },
    outputSchema: { country: z.string().optional(), standard_rate: z.number().nullable().optional(), reduced_rates: z.array(z.number()).optional(), exempt_categories: z.array(z.string()).optional(), withholding: z.string().optional(), special_regimes: z.array(z.string()).optional(), currency: z.string().optional(), notes: z.string().optional(), disclaimer: z.string().optional(), error: z.string().optional() },
    annotations: { title: "Get LatAm VAT Rules", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code }) => {
    const rules = {
      BR: { country: "Brazil", standard_rate: null, reduced_rates: [], exempt_categories: ["Basic food basket (cesta básica)", "Books and newspapers", "Medicines (some)", "Agricultural inputs"], withholding: "Retenção na fonte applies for services (ISS, PIS, COFINS, CSLL, IRPJ)", special_regimes: ["Simples Nacional (micro/small companies)", "Lucro Presumido", "Lucro Real"], currency: "BRL", notes: "Brazil has no single VAT. Main taxes: ICMS (state goods tax, 7-25% by state), ISS (municipal services tax, 2-5%), PIS (0.65-1.65%), COFINS (3-7.6%), IPI (federal goods, varies). Reforma Tributária 2024 will unify into IVA Dual (CBS+IBS) from 2026-2033." },
      MX: { country: "Mexico", standard_rate: 16, reduced_rates: [0, 8], exempt_categories: ["Basic food (alimentos básicos)", "Medicines", "Books", "Educational services", "Medical services"], withholding: "Retención IVA: 2/3 when recipient is individual, or for transport, waste management, financial services", special_regimes: ["REPECOS (abolished)", "RIF - Régimen de Incorporación Fiscal (transitioning)", "RESICO - Régimen Simplificado de Confianza"], currency: "MXN", notes: "IVA (Impuesto al Valor Agregado) 16% standard. Border zone (Baja California, border cities): 8% reduced rate. Zero-rate for exports and basic food. IEPS (special tax) applies to tobacco, alcohol, fuel, sugary drinks." },
      CL: { country: "Chile", standard_rate: 19, reduced_rates: [0], exempt_categories: ["Exports (zero-rated)", "Educational services", "Healthcare services", "Financial services (some)", "Rental of residential property"], withholding: "Retención applies for construction services and some professional services", special_regimes: ["Régimen Pro PYME (14 ter)", "Régimen General"], currency: "CLP", notes: "IVA (Impuesto al Valor Agregado) 19% flat rate. Very simple system compared to Brazil. Exports zero-rated. Monthly VAT declaration (Form 29). No reduced rates for most goods." },
      AR: { country: "Argentina", standard_rate: 21, reduced_rates: [10.5, 27, 0], exempt_categories: ["Basic food basket", "Healthcare", "Education", "Books", "Exports (zero-rated)"], withholding: "Percepción and retención IVA apply in many transactions — rates vary by province and taxpayer category", special_regimes: ["Monotributo (small taxpayers, flat tax)", "Responsable Inscripto (standard IVA)", "Exento (exempt)"], currency: "ARS", notes: "IVA 21% standard. 10.5% for basic food, medicines, some goods. 27% for utilities (gas, electricity, water) when sold to businesses. Monotributistas do not charge IVA. High complexity due to provincial perceptions." },
      CO: { country: "Colombia", standard_rate: 19, reduced_rates: [5, 0], exempt_categories: ["Basic food", "Healthcare services", "Education", "Exports (zero-rated)", "Agricultural products (some)"], withholding: "Retención en la fuente IVA: 15% of IVA value retained in certain B2B transactions", special_regimes: ["Régimen Simple de Tributación", "Régimen Ordinario", "No Responsables de IVA (small taxpayers)"], currency: "COP", notes: "IVA 19% standard. 5% for some food, medicines, computers. Zero-rate for basic food, exports. Bimonthly or annual IVA declarations depending on turnover. No Responsables de IVA for small taxpayers (do not charge IVA)." },
    };
    const code = country_code.toUpperCase();
    const data = rules[code];
    if (!data) { const r = { error: `Country ${code} not found. Available: ${Object.keys(rules).join(", ")}` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const r = { ...data, disclaimer: "Reference information only — not legal or tax advice. Tax rates change frequently. Verify with the relevant tax authority." };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 21. Get E-Invoicing Rules LatAm ──
  server.registerTool("get_einvoicing_rules_latam", {
    description: "Returns the current e-invoicing (electronic invoicing) obligations for a given Latin American country — whether mandatory for B2B/B2G/B2C, the electronic system used, required formats, and key compliance notes. Returns { country, b2b_mandatory, b2g_mandatory, b2c_mandatory, system, formats, mandatory_since, notes }. Supports BR, MX, CL, AR, CO. Use when building invoice generation systems, determining compliance requirements for LatAm customers, or automating invoice submission workflows.",
    inputSchema: { country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CL', 'AR', 'CO'") },
    outputSchema: { country: z.string().optional(), b2b_mandatory: z.boolean().optional(), b2g_mandatory: z.boolean().optional(), b2c_mandatory: z.boolean().optional(), system: z.string().optional(), formats: z.array(z.string()).optional(), mandatory_since: z.string().optional(), notes: z.string().optional(), disclaimer: z.string().optional(), error: z.string().optional() },
    annotations: { title: "Get LatAm E-Invoicing Rules", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code }) => {
    const rules = {
      BR: { country: "Brazil", b2b_mandatory: true, b2g_mandatory: true, b2c_mandatory: true, system: "SEFAZ (NF-e/NF-C) + Prefeituras (NFS-e) + Receita Federal", formats: ["XML NF-e (goods)", "XML NF-C (retail B2C)", "XML NFS-e (services, municipal)", "DANFE (printed representation)", "MDF-e (transport manifest)"], mandatory_since: "2010 (phased by company size)", notes: "Most mature e-invoicing system in LatAm. Authorization required from SEFAZ before issuance. Contingency mode available. NF-e for interstate goods, NF-C for retail, NFS-e for services (each municipality has own system). CT-e for transport." },
      MX: { country: "Mexico", b2b_mandatory: true, b2g_mandatory: true, b2c_mandatory: true, system: "SAT via PAC (Proveedor Autorizado de Certificación)", formats: ["CFDI 4.0 (XML + PDF)", "Complemento de Pago", "Complemento Carta Porte (transport)", "CFDI Nómina (payroll)"], mandatory_since: "2014 (CFDI 3.3), 2023 (CFDI 4.0)", notes: "CFDI must be certified by a PAC before delivery. Cancelación requires receptor acceptance within 72h in most cases. CFDI 4.0 added fiscal domicile and régimen fiscal requirements. Global CFDI for B2C small transactions." },
      CL: { country: "Chile", b2b_mandatory: true, b2g_mandatory: true, b2c_mandatory: true, system: "SII (Servicio de Impuestos Internos)", formats: ["DTE XML (Factura, Boleta, Nota Crédito, Nota Débito)", "IECV (Libro de Compras y Ventas)"], mandatory_since: "2003 (voluntary), 2017-2022 (mandatory by company size)", notes: "Pioneer of e-invoicing in LatAm. CAF (folio authorization) required. DTEs sent to SII and receptor simultaneously. Boleta electrónica mandatory for B2C since 2021. Real-time validation by SII." },
      AR: { country: "Argentina", b2b_mandatory: true, b2g_mandatory: true, b2c_mandatory: true, system: "AFIP web services (WSFE, WSFEX for exports)", formats: ["Factura Electrónica XML (A, B, C, M types)", "Factura de Crédito Electrónica MiPyME (FCE)", "Liquidación electrónica"], mandatory_since: "2012-2019 (phased by company size)", notes: "CAE (Código de Autorización Electrónica) issued by AFIP before invoice delivery. FCE mandatory for B2B invoices above ARS threshold to large companies (promotes SME factoring). High complexity due to multiple invoice types and AFIP web service requirements." },
      CO: { country: "Colombia", b2b_mandatory: true, b2g_mandatory: true, b2c_mandatory: false, system: "DIAN via software de facturación autorizado o proveedor tecnológico", formats: ["Factura Electrónica de Venta (XML UBL 2.1)", "Nota Crédito", "Nota Débito", "Documento Soporte"], mandatory_since: "2019-2022 (phased rollout)", notes: "CUFE (Código Único de Factura Electrónica) generated from invoice data. B2C (documento equivalente) still being phased in. Régimen Simple de Tributación has simplified requirements. Proveedor tecnológico habilitado por DIAN required." },
    };
    const code = country_code.toUpperCase();
    const data = rules[code];
    if (!data) { const r = { error: `Country ${code} not found. Available: ${Object.keys(rules).join(", ")}` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const r = { ...data, disclaimer: "Reference information only. E-invoicing regulations change frequently. Verify with official sources and a qualified professional." };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ════════════════════════════════════════════════
  // MODULE 3 — LABOR HELPERS (3 tools)
  // ════════════════════════════════════════════════

  // ── 22. Get Public Holidays Range LatAm ──
  server.registerTool("get_public_holidays_range_latam", {
    description: "Returns all public holidays that fall within a given date range for a specified Latin American country. Returns { country, start_date, end_date, total_holidays, holidays: [{date, name, name_en}] }. Supports BR, MX, CL, AR, CO. Use when calculating SLA periods, project timelines, delivery windows, or any workflow that must skip non-working days across LatAm countries.",
    inputSchema: {
      country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CL'"),
      start_date: z.string().describe("Start date in YYYY-MM-DD format. Example: '2026-01-01'"),
      end_date: z.string().describe("End date in YYYY-MM-DD format. Example: '2026-12-31'")
    },
    outputSchema: { country: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional(), total_holidays: z.number().optional(), holidays: z.array(z.object({ date: z.string(), name: z.string(), name_en: z.string() })).optional(), error: z.string().optional() },
    annotations: { title: "Get LatAm Public Holidays in Date Range", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code, start_date, end_date }) => {
    const start = new Date(start_date), end = new Date(end_date);
    if (isNaN(start) || isNaN(end)) { const r = { error: "Invalid date format. Use YYYY-MM-DD" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    const code = country_code.toUpperCase();
    const supported = ["BR", "MX", "CL", "AR", "CO"];
    if (!supported.includes(code)) { const r = { error: `Country ${code} not supported. Supported: ${supported.join(", ")}` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }

    const startYear = start.getFullYear(), endYear = end.getFullYear();
    let allHolidays = [];

    for (let y = startYear; y <= endYear; y++) {
      const easter = getEaster(y);
      const fixed = (FIXED_HOLIDAYS[code] || []).map(mmdd => ({ date: `${y}-${mmdd}`, name: mmdd, name_en: mmdd }));
      const moveable = [];

      if (code === "BR") {
        moveable.push({ date: fmt(addDays(easter, -48)), name: "Carnaval (Segunda)", name_en: "Carnival Monday" });
        moveable.push({ date: fmt(addDays(easter, -47)), name: "Carnaval (Terça)", name_en: "Carnival Tuesday" });
        moveable.push({ date: fmt(addDays(easter, -2)), name: "Sexta-feira Santa", name_en: "Good Friday" });
        moveable.push({ date: fmt(addDays(easter, 60)), name: "Corpus Christi", name_en: "Corpus Christi" });
      }
      if (code === "MX") {
        const firstMonday = (m) => { const d = new Date(y, m - 1, 1); return new Date(y, m - 1, 1 + (8 - d.getDay()) % 7); };
        const thirdMonday = (m) => new Date(firstMonday(m).getTime() + 14 * 86400000);
        moveable.push({ date: fmt(firstMonday(2)), name: "Día de la Constitución", name_en: "Constitution Day" });
        moveable.push({ date: fmt(thirdMonday(3)), name: "Natalicio de Benito Juárez", name_en: "Benito Juárez Birthday" });
        moveable.push({ date: fmt(thirdMonday(11)), name: "Día de la Revolución", name_en: "Revolution Day" });
      }
      if (code === "CL") {
        moveable.push({ date: fmt(addDays(easter, -2)), name: "Viernes Santo", name_en: "Good Friday" });
        moveable.push({ date: fmt(addDays(easter, -1)), name: "Sábado Santo", name_en: "Holy Saturday" });
      }
      if (code === "AR") {
        moveable.push({ date: fmt(addDays(easter, -48)), name: "Carnaval (Lunes)", name_en: "Carnival Monday" });
        moveable.push({ date: fmt(addDays(easter, -47)), name: "Carnaval (Martes)", name_en: "Carnival Tuesday" });
        moveable.push({ date: fmt(addDays(easter, -2)), name: "Viernes Santo", name_en: "Good Friday" });
      }
      if (code === "CO") {
        moveable.push({ date: fmt(nextMondayCO(new Date(y, 0, 6))), name: "Reyes Magos", name_en: "Epiphany" });
        moveable.push({ date: fmt(nextMondayCO(new Date(y, 2, 19))), name: "San José", name_en: "St Joseph's Day" });
        moveable.push({ date: fmt(addDays(easter, -3)), name: "Jueves Santo", name_en: "Holy Thursday" });
        moveable.push({ date: fmt(addDays(easter, -2)), name: "Viernes Santo", name_en: "Good Friday" });
        moveable.push({ date: fmt(nextMondayCO(addDays(easter, 39))), name: "Ascensión", name_en: "Ascension" });
        moveable.push({ date: fmt(nextMondayCO(addDays(easter, 60))), name: "Corpus Christi", name_en: "Corpus Christi" });
        moveable.push({ date: fmt(nextMondayCO(addDays(easter, 68))), name: "Sagrado Corazón", name_en: "Sacred Heart" });
        moveable.push({ date: fmt(nextMondayCO(new Date(y, 5, 29))), name: "San Pedro y San Pablo", name_en: "SS Peter & Paul" });
        moveable.push({ date: fmt(nextMondayCO(new Date(y, 7, 15))), name: "Asunción", name_en: "Assumption" });
        moveable.push({ date: fmt(nextMondayCO(new Date(y, 9, 12))), name: "Día de la Raza", name_en: "Columbus Day" });
        moveable.push({ date: fmt(nextMondayCO(new Date(y, 10, 1))), name: "Todos los Santos", name_en: "All Saints" });
        moveable.push({ date: fmt(nextMondayCO(new Date(y, 10, 11))), name: "Independencia de Cartagena", name_en: "Cartagena Independence" });
      }
      allHolidays = allHolidays.concat(fixed, moveable);
    }

    const filtered = allHolidays.filter(h => {
      const d = new Date(h.date);
      return d >= start && d <= end;
    }).sort((a, b) => a.date.localeCompare(b.date));

    const r = { country: code, start_date, end_date, total_holidays: filtered.length, holidays: filtered };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 23. Calculate Working Days LatAm ──
  server.registerTool("calculate_working_days_latam", {
    description: "Counts the number of working days between two dates (inclusive) for a given Latin American country, excluding weekends and that country's national public holidays (including moveable Easter-based holidays). Returns { country, start_date, end_date, working_days, holidays_excluded }. Supports BR, MX, CL, AR, CO. Use when calculating cross-border SLA periods, invoice payment deadlines, or project timelines that must account for different national holiday calendars across LatAm.",
    inputSchema: {
      country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CO'"),
      start_date: z.string().describe("Start date in YYYY-MM-DD format, inclusive. Example: '2026-01-01'"),
      end_date: z.string().describe("End date in YYYY-MM-DD format, inclusive. Example: '2026-01-31'")
    },
    outputSchema: { country: z.string().optional(), start_date: z.string().optional(), end_date: z.string().optional(), working_days: z.number().optional(), holidays_excluded: z.number().optional(), error: z.string().optional() },
    annotations: { title: "Calculate Working Days (LatAm Multi-Country)", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code, start_date, end_date }) => {
    const code = country_code.toUpperCase();
    const supported = ["BR", "MX", "CL", "AR", "CO"];
    if (!supported.includes(code)) { const r = { error: `Country ${code} not supported. Supported: ${supported.join(", ")}` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }

    const start = new Date(start_date), end = new Date(end_date);
    if (isNaN(start) || isNaN(end)) { const r = { error: "Invalid date format. Use YYYY-MM-DD" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }

    const fixed = FIXED_HOLIDAYS[code] || [];

    // Pre-compute moveable holidays for all years in range
    const moveableByYear = {};
    for (let y = start.getFullYear(); y <= end.getFullYear(); y++) {
      moveableByYear[y] = getMoveableHolidayDates(y, code);
    }

    let count = 0, holidaysExcluded = 0;
    const current = new Date(start);

    while (current <= end) {
      const dow = current.getDay();
      const mmdd = `${String(current.getMonth() + 1).padStart(2, "0")}-${String(current.getDate()).padStart(2, "0")}`;
      const fullDate = fmt(current);
      const isHoliday = fixed.includes(mmdd) || (moveableByYear[current.getFullYear()] || []).includes(fullDate);
      if (dow !== 0 && dow !== 6 && !isHoliday) count++;
      else if (dow !== 0 && dow !== 6 && isHoliday) holidaysExcluded++;
      current.setDate(current.getDate() + 1);
    }

    const r = { country: code, start_date, end_date, working_days: count, holidays_excluded: holidaysExcluded };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 24. Get Next Payment Date LatAm ──
  server.registerTool("get_next_payment_date_latam", {
    description: "Calculates the next valid payment date for a given Latin American country, skipping weekends and national public holidays (fixed and moveable Easter-based). Supports rules: 'last_working_day_of_month' (salary payment in BR/AR), 'first_working_day_of_month', 'nth_working_day' (e.g. 5th working day for BR salary), 'next_working_day'. Returns { country, reference_date, rule, result_date }. Use when scheduling salary payments, NF-e/CFDI payment due dates, or any automated payment workflow that must avoid non-working days in LatAm.",
    inputSchema: {
      country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CO'"),
      reference_date: z.string().describe("Reference date in YYYY-MM-DD format. Example: '2026-01-31'"),
      rule: z.enum(["last_working_day_of_month", "first_working_day_of_month", "next_working_day", "nth_working_day"]).describe("Payment rule to apply."),
      n: z.number().optional().describe("For nth_working_day rule: which working day of the month. Example: 5 for 5th working day.")
    },
    outputSchema: { country: z.string().optional(), reference_date: z.string().optional(), rule: z.string().optional(), n: z.number().nullable().optional(), result_date: z.string().optional(), error: z.string().optional() },
    annotations: { title: "Get Next Payment Date (LatAm)", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code, reference_date, rule, n }) => {
    const code = country_code.toUpperCase();
    const supported = ["BR", "MX", "CL", "AR", "CO"];
    if (!supported.includes(code)) { const r = { error: `Country ${code} not supported. Supported: ${supported.join(", ")}` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }

    const fixed = FIXED_HOLIDAYS[code] || [];
    const moveableCache = {};
    const getMoveable = (y) => {
      if (!moveableCache[y]) moveableCache[y] = getMoveableHolidayDates(y, code);
      return moveableCache[y];
    };

    const isWorkingDay = (date) => {
      const dow = date.getDay();
      if (dow === 0 || dow === 6) return false;
      const mmdd = `${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      if (fixed.includes(mmdd)) return false;
      if (getMoveable(date.getFullYear()).includes(fmt(date))) return false;
      return true;
    };

    const ref = new Date(reference_date);
    if (isNaN(ref)) { const r = { error: "Invalid date format. Use YYYY-MM-DD" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }

    let resultDate;
    if (rule === "next_working_day") {
      const d = new Date(ref); d.setDate(d.getDate() + 1);
      while (!isWorkingDay(d)) d.setDate(d.getDate() + 1);
      resultDate = fmt(d);
    }
    if (rule === "last_working_day_of_month") {
      const d = new Date(ref.getFullYear(), ref.getMonth() + 1, 0);
      while (!isWorkingDay(d)) d.setDate(d.getDate() - 1);
      resultDate = fmt(d);
    }
    if (rule === "first_working_day_of_month") {
      const d = new Date(ref.getFullYear(), ref.getMonth(), 1);
      while (!isWorkingDay(d)) d.setDate(d.getDate() + 1);
      resultDate = fmt(d);
    }
    if (rule === "nth_working_day") {
      if (!n || n < 1) { const r = { error: "For nth_working_day rule, provide n >= 1" }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
      const d = new Date(ref.getFullYear(), ref.getMonth(), 1);
      let count = 0;
      while (true) {
        if (isWorkingDay(d)) {
          count++;
          if (count === n) break;
        }
        d.setDate(d.getDate() + 1);
        // Safety: don't loop past month
        if (d.getMonth() !== ref.getMonth()) { resultDate = null; break; }
      }
      resultDate = resultDate === null ? null : fmt(d);
      if (resultDate === null) { const r = { error: `Month does not have ${n} working days` }; return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r }; }
    }

    const r = { country: code, reference_date, rule, n: n || null, result_date: resultDate };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ════════════════════════════════════════════════
  // MODULE 4 — INVOICE & VAT HELPERS (4 tools)
  // ════════════════════════════════════════════════

  // ── 25. Validate Invoice Schema LatAm ──
  server.registerTool("validate_invoice_schema_latam", {
    description: "Validates whether an invoice JSON object contains the mandatory fields required for a valid electronic invoice in a given Latin American country, based on official tax authority requirements (SEFAZ, SAT, SII, AFIP, DIAN). Returns { valid: boolean, country, missing_fields: [], present_fields: [], warnings: [] }. Use when building invoice generation pipelines, pre-submission validation, or compliance checks in agent workflows. Information is reference only — not legal advice.",
    inputSchema: {
      country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CL', 'AR', 'CO'"),
      invoice: z.object({
        invoice_number: z.string().optional(),
        invoice_date: z.string().optional(),
        supplier_tax_id: z.string().optional(),
        supplier_name: z.string().optional(),
        customer_tax_id: z.string().optional(),
        customer_name: z.string().optional(),
        line_items: z.array(z.any()).optional(),
        subtotal: z.number().optional(),
        tax_amount: z.number().optional(),
        total: z.number().optional(),
        currency: z.string().optional(),
        payment_method: z.string().optional(),
        electronic_key: z.string().optional(),
      }).describe("Invoice object to validate")
    },
    outputSchema: { valid: z.boolean(), country: z.string().optional(), missing_fields: z.array(z.string()).optional(), present_fields: z.array(z.string()).optional(), warnings: z.array(z.string()).optional(), disclaimer: z.string().optional() },
    annotations: { title: "Validate LatAm Invoice Schema", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code, invoice }) => {
    const baseRequired = ["invoice_number", "invoice_date", "supplier_tax_id", "supplier_name", "customer_tax_id", "customer_name", "line_items", "subtotal", "tax_amount", "total"];
    const countryExtra = {
      BR: ["electronic_key"],
      MX: ["payment_method"],
      CL: ["electronic_key"],
      AR: ["electronic_key"],
      CO: ["electronic_key"],
    };
    const code = country_code.toUpperCase();
    const extra = countryExtra[code] || [];
    const allRequired = [...new Set([...baseRequired, ...extra])];
    const missingFields = allRequired.filter(f => invoice[f] === undefined || invoice[f] === null || invoice[f] === "");
    const presentFields = allRequired.filter(f => invoice[f] !== undefined && invoice[f] !== null && invoice[f] !== "");
    const warnings = [];
    if (invoice.total && invoice.subtotal && invoice.tax_amount) {
      const calc = Math.round((invoice.subtotal + invoice.tax_amount) * 100) / 100;
      if (Math.abs(calc - invoice.total) > 0.02) warnings.push(`Total (${invoice.total}) does not match subtotal + tax_amount (${calc})`);
    }
    if (code === "BR" && !invoice.electronic_key) warnings.push("Brazil: chave de acesso (44-digit NF-e key) required for authorized invoices");
    if (code === "MX" && !invoice.payment_method) warnings.push("Mexico: forma de pago (PUE/PPD) required in CFDI 4.0");
    if (code === "CO" && !invoice.electronic_key) warnings.push("Colombia: CUFE (Código Único de Factura Electrónica) required");
    const r = { valid: missingFields.length === 0, country: code, missing_fields: missingFields, present_fields: presentFields, warnings, disclaimer: "Reference validation only — not legal advice." };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 26. Calculate VAT Breakdown LatAm ──
  server.registerTool("calculate_vat_breakdown_latam", {
    description: "Calculates a VAT/IVA breakdown for invoice line items in a given Latin American country, grouping amounts by tax rate and computing totals. For Brazil, returns ICMS, PIS, COFINS breakdown. For Mexico, returns IVA breakdown. For Chile/Argentina/Colombia, returns IVA breakdown. Returns { country, lines_summary, tax_breakdown, subtotal, total_tax, total }. Each line item requires { description, quantity, unit_price, tax_rate }.",
    inputSchema: {
      country_code: z.string().describe("Two-letter ISO country code. Example: 'BR', 'MX', 'CL'"),
      lines: z.array(z.object({
        description: z.string().describe("Item description"),
        quantity: z.number().describe("Quantity"),
        unit_price: z.number().describe("Unit price excluding tax"),
        tax_rate: z.number().describe("Tax rate as percentage. Example: 16 for 16% IVA (Mexico) or 19 for 19% IVA (Chile)")
      })).describe("Array of invoice line items"),
      currency: z.string().optional().describe("Currency code. Example: 'BRL', 'MXN', 'CLP'. Defaults to country currency.")
    },
    outputSchema: { country: z.string(), currency: z.string(), lines_summary: z.array(z.any()), tax_breakdown: z.array(z.any()), subtotal: z.number(), total_tax: z.number(), total: z.number() },
    annotations: { title: "Calculate LatAm VAT Breakdown", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code, lines, currency }) => {
    const currencyMap = { BR: "BRL", MX: "MXN", CL: "CLP", AR: "ARS", CO: "COP" };
    const code = country_code.toUpperCase();
    const curr = currency || currencyMap[code] || "USD";
    const round = (n) => Math.round(n * 100) / 100;
    const taxGroups = {};
    const linesSummary = lines.map(line => {
      const lineTotal = round(line.quantity * line.unit_price);
      const lineTax = round(lineTotal * line.tax_rate / 100);
      const lineTotalIncl = round(lineTotal + lineTax);
      if (!taxGroups[line.tax_rate]) taxGroups[line.tax_rate] = { base: 0, tax: 0 };
      taxGroups[line.tax_rate].base = round(taxGroups[line.tax_rate].base + lineTotal);
      taxGroups[line.tax_rate].tax = round(taxGroups[line.tax_rate].tax + lineTax);
      return { description: line.description, quantity: line.quantity, unit_price: line.unit_price, tax_rate: line.tax_rate, line_subtotal: lineTotal, line_tax: lineTax, line_total: lineTotalIncl };
    });
    const taxLabel = code === "BR" ? "ICMS/ISS" : "IVA";
    const taxBreakdown = Object.entries(taxGroups).map(([rate, amounts]) => ({ rate: parseFloat(rate), tax_type: taxLabel, base_amount: amounts.base, tax_amount: amounts.tax }));
    const subtotal = round(linesSummary.reduce((s, l) => s + l.line_subtotal, 0));
    const totalTax = round(linesSummary.reduce((s, l) => s + l.line_tax, 0));
    const total = round(subtotal + totalTax);
    const r = { country: code, currency: curr, lines_summary: linesSummary, tax_breakdown: taxBreakdown, subtotal, total_tax: totalTax, total };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 27. Suggest VAT Treatment LatAm ──
  server.registerTool("suggest_vat_treatment_latam", {
    description: "Suggests the likely VAT/IVA treatment for a transaction in Latin American markets based on seller country, buyer country, buyer tax registration status, and operation type. Covers domestic transactions, exports (zero-rated), imports, and cross-border services. Returns { treatment, description, seller_charges_tax, applicable_rate, notes, disclaimer }. Use when building checkout tax logic, invoice generation, or cross-border LatAm compliance workflows. Always verify with a tax advisor for real transactions.",
    inputSchema: {
      seller_country: z.string().describe("Seller's country ISO code. Example: 'BR', 'MX'"),
      buyer_country: z.string().describe("Buyer's country ISO code. Example: 'CL', 'CO'"),
      buyer_is_tax_registered: z.boolean().describe("Whether the buyer is tax registered (B2B) or not (B2C)"),
      operation_type: z.enum(["goods", "services", "digital_services"]).describe("Type of supply")
    },
    outputSchema: { treatment: z.string(), description: z.string(), seller_charges_tax: z.boolean(), applicable_rate: z.string(), seller_country: z.string(), buyer_country: z.string(), buyer_is_tax_registered: z.boolean(), operation_type: z.string(), notes: z.string(), disclaimer: z.string() },
    annotations: { title: "Suggest LatAm VAT Treatment", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ seller_country, buyer_country, buyer_is_tax_registered, operation_type }) => {
    const seller = seller_country.toUpperCase();
    const buyer = buyer_country.toUpperCase();
    const latamCountries = ["BR", "MX", "CL", "AR", "CO", "PE", "EC", "UY", "PY", "BO", "VE", "CR", "PA", "GT", "HN", "SV", "NI", "DO", "CU"];
    const sellerInLatam = latamCountries.includes(seller);
    const buyerInLatam = latamCountries.includes(buyer);
    let treatment, description, sellerChargesTax, applicableRate, notes;
    if (seller === buyer) {
      treatment = "domestic_tax";
      description = "Domestic transaction — standard local tax applies";
      sellerChargesTax = true;
      applicableRate = "Seller country standard rate (BR: ICMS+others, MX: 16%, CL: 19%, AR: 21%, CO: 19%)";
      notes = `Standard domestic transaction in ${seller}. Apply local tax rules for ${seller}.`;
    } else if (sellerInLatam && !buyerInLatam) {
      treatment = "export_zero_rated";
      description = "Export outside LatAm — zero-rated in most LatAm countries";
      sellerChargesTax = false;
      applicableRate = "0% (export)";
      notes = `Export from ${seller} to ${buyer} (outside LatAm). Generally zero-rated. Seller must retain export documentation. Check specific export procedures for ${seller}.`;
    } else if (!sellerInLatam && buyerInLatam) {
      treatment = "import_buyer_accounts";
      description = "Import into LatAm — buyer accounts for import tax";
      sellerChargesTax = false;
      applicableRate = `${buyer} import tax rate`;
      notes = `Goods/services from outside LatAm into ${buyer}. Import duties and local taxes apply at ${buyer} border/customs. For digital services, ${buyer} may require foreign seller to register for local VAT.`;
    } else if (sellerInLatam && buyerInLatam && seller !== buyer) {
      if (operation_type === "goods") {
        treatment = "latam_cross_border_goods_export";
        description = "Cross-border goods between LatAm countries — export from seller, import at buyer";
        sellerChargesTax = false;
        applicableRate = "0% at export, import tax at buyer country";
        notes = `Export from ${seller} (zero-rated) + import into ${buyer} (buyer pays local import tax). No free trade unified VAT system in LatAm — each border crossing is a full export/import. Check bilateral trade agreements between ${seller} and ${buyer}.`;
      } else {
        treatment = "latam_cross_border_services";
        description = "Cross-border services between LatAm countries";
        sellerChargesTax = false;
        applicableRate = "Varies by country — generally zero-rated at source, taxed at destination";
        notes = `Cross-border services from ${seller} to ${buyer}. Generally: seller in ${seller} issues invoice without local tax. Buyer in ${buyer} may need to self-assess local tax (retención/withholding). For digital services: ${buyer} may require foreign registration. Verify bilateral rules.`;
      }
    } else {
      treatment = "outside_latam_scope";
      description = "Transaction outside LatAm scope";
      sellerChargesTax = false;
      applicableRate = "N/A";
      notes = "Neither seller nor buyer is in a recognized LatAm country. LatAm tax rules do not apply.";
    }
    const r = { treatment, description, seller_charges_tax: sellerChargesTax, applicable_rate: applicableRate, seller_country: seller, buyer_country: buyer, buyer_is_tax_registered, operation_type, notes, disclaimer: "Reference information only — not legal or tax advice. Always verify with a qualified tax advisor for real transactions." };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  // ── 28. Calculate VAT Amount LatAm ──
  server.registerTool("calculate_vat_amount_latam", {
    description: "Calculates tax amounts from either a net (excluding tax) or gross (including tax) amount for a given tax rate, with country context for currency and tax label. Returns { country, net_amount, tax_amount, gross_amount, tax_rate, tax_label, currency }. Use when building pricing tools, invoice calculators, or checkout flows across LatAm markets that need to split gross prices into net + tax components.",
    inputSchema: {
      country_code: z.string().describe("Two-letter ISO country code for currency and context. Example: 'BR', 'MX', 'CL'"),
      amount: z.number().describe("The amount to calculate tax for"),
      tax_rate: z.number().describe("Tax rate as a percentage. Example: 16 for 16% IVA (Mexico) or 19 for 19% IVA (Chile)"),
      amount_type: z.enum(["net", "gross"]).describe("Whether the input amount is net (excluding tax) or gross (including tax)"),
      currency: z.string().optional().describe("Override currency. Defaults to country currency.")
    },
    outputSchema: { country: z.string(), net_amount: z.number(), tax_amount: z.number(), gross_amount: z.number(), tax_rate: z.number(), tax_label: z.string(), currency: z.string() },
    annotations: { title: "Calculate LatAm VAT Amount", readOnlyHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ country_code, amount, tax_rate, amount_type, currency }) => {
    const currencyMap = { BR: "BRL", MX: "MXN", CL: "CLP", AR: "ARS", CO: "COP" };
    const taxLabelMap = { BR: "ICMS/ISS", MX: "IVA", CL: "IVA", AR: "IVA", CO: "IVA" };
    const code = country_code.toUpperCase();
    const curr = currency || currencyMap[code] || "USD";
    const taxLabel = taxLabelMap[code] || "VAT";
    const round = (n) => Math.round(n * 100) / 100;
    let net, tax, gross;
    if (amount_type === "net") { net = round(amount); tax = round(amount * tax_rate / 100); gross = round(net + tax); }
    else { gross = round(amount); net = round(amount / (1 + tax_rate / 100)); tax = round(gross - net); }
    const r = { country: code, net_amount: net, tax_amount: tax, gross_amount: gross, tax_rate, tax_label: taxLabel, currency: curr };
    return { content: [{ type: "text", text: JSON.stringify(r) }], structuredContent: r };
  });

  return server;
};

// ════════════════════════════════════════════════
// DUAL TRANSPORT: stdio (Glama) or HTTP (Railway)
// ════════════════════════════════════════════════

const isStdio = process.env.MCP_HTTP !== "true";

if (isStdio) {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
} else {
  const httpServer = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        name: "mcp-latam-business",
        version: "1.0.0",
        description: "Latin American business compliance suite for AI agents",
        tools_count: 28,
        modules: {
          validation: ["validate_cpf","validate_cnpj","validate_pix_key","get_brazil_holidays","validate_rfc_mx","get_mexico_holidays","validate_rut_cl","get_chile_holidays","validate_cuit","validate_cuil","get_argentina_holidays","validate_nit_co","validate_cc_co","validate_clabe_mx","validate_cbu_ar","get_colombia_holidays","validate_postal_code_latam"],
          business_rules: ["get_payment_terms_latam","get_invoice_requirements_latam","get_vat_rules_latam","get_einvoicing_rules_latam"],
          labor_helpers: ["get_public_holidays_range_latam","calculate_working_days_latam","get_next_payment_date_latam"],
          invoice_vat: ["validate_invoice_schema_latam","calculate_vat_breakdown_latam","suggest_vat_treatment_latam","calculate_vat_amount_latam"]
        },
        mcp_endpoint: "/mcp"
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.url === "/mcp") {
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { transport.close(); server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res);
      return;
    }
    res.writeHead(404);
    res.end("Not found");
  });
  const PORT = process.env.PORT || 8080;
  httpServer.listen(PORT, () => {
    console.log(`MCP LatAm Business Suite running on port ${PORT}`);
  });
}
