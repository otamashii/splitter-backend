import type { Readable } from "node:stream";
import { GoogleGenerativeAI } from "@google/generative-ai";

/** Shape returned to the route */
export interface ParsedReceiptItem {
  id: string; // stable within this response (not DB id)
  name: string;
  unitPrice: number;
  quantity: number;
  totalPrice: number; // unitPrice * quantity (model can supply; we'll verify)
  kind?: string | null; // e.g. fee/tip/discount
}

export interface ParseResult {
  items: ParsedReceiptItem[];
  summary: { grandTotal: number; currency: string };
  rawModelText?: string | undefined; // for debugging (only when DEBUG_PARSE=1)
  model?: string | undefined; // which model was used
  durationMs?: number | undefined;
  source: "gemini" | "mock";
  usedModelVersion?: string | undefined;
  modelsTried?:
    | Array<{
        model: string;
        version: string;
        status: string;
        httpStatus?: number;
        durationMs?: number;
        chars?: number;
        errorMessage?: string;
        errorCode?: string;
      }>
    | undefined;
}

export interface ParseOptions {
  language: string; // BCP-47 like ru-RU, en-US
  sessionName: string;
  mimeType?: string;
  imageBase64?: string; // no data: prefix, raw base64
  qrData?: string;
}

// Environment-driven configuration
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || "v1";
const GEMINI_MODEL_PARSE = process.env.GEMINI_MODEL_PARSE || "gemini-2.5-flash";
const GEMINI_MODEL_FALLBACKS = (process.env.GEMINI_MODEL_FALLBACKS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ✅ обновлённые кандидаты на основе актуальных моделей (октябрь 2025)
const MODEL_CANDIDATES = Array.from(
  new Set([
    GEMINI_MODEL_PARSE,
    ...GEMINI_MODEL_FALLBACKS,
    // current primary & secondary models
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.0-flash",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite",
    "gemini-2.0-flash-lite-001",
    // fallback older generation still supported in some regions
    "gemini-1.5-pro",
    "gemini-1.5-flash",
  ])
);

const DEBUG_PARSE = process.env.DEBUG_PARSE === "1";
let cachedModel: { model: string; version: string } | null = null;
let lastUsedVersion: string | undefined;

const DEFAULT_CURRENCY_CODE = "UNKNOWN";
const SYMBOL_TO_ISO: Record<string, string> = {
  $: "USD",
  USD: "USD",
  US$: "USD",
  "€": "EUR",
  EUR: "EUR",
  "£": "GBP",
  GBP: "GBP",
  "¥": "JPY",
  JPY: "JPY",
  円: "JPY",
  "₽": "RUB",
  RUB: "RUB",
  RUR: "RUB",
  РУБ: "RUB",
  "РУБ.": "RUB",
  "₴": "UAH",
  UAH: "UAH",
  "₩": "KRW",
  KRW: "KRW",
  "₦": "NGN",
  NGN: "NGN",
  "₹": "INR",
  INR: "INR",
  "₺": "TRY",
  TRY: "TRY",
  C$: "CAD",
  CAD: "CAD",
  A$: "AUD",
  AUD: "AUD",
  CHF: "CHF",
  HK$: "HKD",
  HKD: "HKD",
  SG$: "SGD",
  SGD: "SGD",
  ZAR: "ZAR",
};

function normalizeCurrencyCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const directUpper = trimmed.toUpperCase();
  if (SYMBOL_TO_ISO[trimmed]) return SYMBOL_TO_ISO[trimmed];
  if (SYMBOL_TO_ISO[directUpper]) return SYMBOL_TO_ISO[directUpper];
  if (/^[A-Z]{3}$/.test(directUpper)) return directUpper;
  const asciiUpper = trimmed.replace(/[^A-Za-z]/g, "").toUpperCase();
  if (SYMBOL_TO_ISO[asciiUpper]) return SYMBOL_TO_ISO[asciiUpper];
  if (/^[A-Z]{3}$/.test(asciiUpper)) return asciiUpper;
  const firstChar = trimmed[0];
  if (firstChar && SYMBOL_TO_ISO[firstChar]) return SYMBOL_TO_ISO[firstChar];
  const lastChar = trimmed[trimmed.length - 1];
  if (lastChar && SYMBOL_TO_ISO[lastChar]) return SYMBOL_TO_ISO[lastChar];
  return null;
}

function extractCurrencyCode(raw: any): string {
  const candidates: unknown[] = [
    raw?.summary?.currency,
    raw?.summary?.currencyCode,
    raw?.summary?.currency_code,
    raw?.summary?.isoCurrency,
    raw?.currency,
    raw?.currencyCode,
    raw?.currency_code,
  ];
  if (Array.isArray(raw?.items)) {
    for (const item of raw.items) {
      candidates.push(item?.currency, item?.currencyCode, item?.currency_code);
    }
  }
  for (const candidate of candidates) {
    const normalized = normalizeCurrencyCode(candidate);
    if (normalized) return normalized;
  }
  return DEFAULT_CURRENCY_CODE;
}

// Extraction JSON schema instruction (lightweight, we rely on LLM following examples)
const EXTRACTION_INSTRUCTIONS = `You are a receipt parser. Return ONLY valid JSON with this shape:
{
  "items": [
    { "id": "string", "name": "string", "unitPrice": number, "quantity": number, "totalPrice": number, "kind": "fee|tip|discount|item|other|null" }
  ],
  "summary": { "grandTotal": number, "currency": "ISO_4217" }
}
Rules:
- Numbers must use dot as decimal separator.
- id: generate short stable IDs like "1", "2"... or semantic (e.g. FEE1) unique within list.
- quantity >= 1.
- totalPrice = unitPrice * quantity (round to 2 decimals).
- Include service/tips/fees as separate items with kind set.
- If currency symbol present ignore it when recording numbers.
- Detect the receipt currency (e.g. symbols like $, €, ₽, "so'm", "UZS" or textual names) and report the ISO 4217 code in uppercase.
- When unsure about currency, return "UNKNOWN".
- grandTotal = sum of item totalPrice values (after any discounts).
- For Uzbekistan receipts (p.uz/soliq.uz): look for table-like structures containing product names, quantities (often followed by 'dona' or 'kg'), and prices. Make sure to extract the individual items correctly.`;

function safeParseJson(text: string): { ok: boolean; data?: ParseResult } {
  try {
    const cleaned = unwrapMarkdown(text);
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace === -1 || lastBrace === -1) return { ok: false };
    const jsonSlice = cleaned.slice(firstBrace, lastBrace + 1);
    const raw = JSON.parse(jsonSlice);
    if (!raw || typeof raw !== "object") return { ok: false };
    if (!Array.isArray(raw.items) || !raw.summary) return { ok: false };
    // Basic normalization
    const items: ParsedReceiptItem[] = raw.items.map((it: any, idx: number) => {
      const q = Number(it.quantity ?? 1) || 1;
      const unit = Number(it.unitPrice ?? it.price ?? 0) || 0;
      const total = Number(it.totalPrice ?? unit * q) || 0;
      return {
        id: String(it.id ?? idx + 1),
        name: String(it.name ?? "Item"),
        unitPrice: round2(unit),
        quantity: q,
        totalPrice: round2(total),
        kind: it.kind ? String(it.kind) : undefined,
      };
    });
    const grandTotal = round2(
      items.reduce((s, i) => s + (Number(i.totalPrice) || 0), 0)
    );
    const currency = extractCurrencyCode(raw);
    return {
      ok: true,
      data: {
        items,
        summary: { grandTotal, currency },
        source: "gemini",
      } as ParseResult,
    };
  } catch {
    return { ok: false };
  }
}

function unwrapMarkdown(t: string): string {
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && typeof fence[1] === "string") return fence[1].trim();
  return t.trim();
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Fallback deterministic mock when API key missing or parse fails */
function mockParse(): ParseResult {
  const items: ParsedReceiptItem[] = [
    {
      id: "1001",
      name: "Кола 0.5L",
      unitPrice: 2.0,
      quantity: 6,
      totalPrice: 12.0,
    },
    {
      id: "1002",
      name: "Кола (стакан)",
      unitPrice: 2.5,
      quantity: 1,
      totalPrice: 2.5,
    },
    {
      id: "FEE1",
      name: "Сервис",
      unitPrice: 1.2,
      quantity: 1,
      totalPrice: 1.2,
      kind: "fee",
    },
  ];
  const grandTotal = items.reduce((s, i) => s + i.totalPrice, 0);
  return {
    items,
    summary: { grandTotal, currency: "RUB" },
    source: "mock",
  };
}

/** Fetches and cleans text from a URL (e.g. for UZ tax receipts) */
async function fetchUrlContent(url: string): Promise<string | null> {
  try {
    if (DEBUG_PARSE) console.log(`[fetchUrlContent] Fetching: ${url}`);
    const resp = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'uz-UZ,uz;q=0.9,ru-RU;q=0.8,ru;q=0.7,en-US;q=0.6,en;q=0.5'
      }
    });
    if (!resp.ok) {
      if (DEBUG_PARSE) console.warn(`[fetchUrlContent] HTTP ${resp.status} for ${url}`);
      return null;
    }
    const text = await resp.text();
    // Basic cleanup: remove scripts, styles, and tags to keep it lightweight for LLM
    const cleaned = text
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gim, "")
      .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gim, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    
    if (DEBUG_PARSE) console.log(`[fetchUrlContent] Success, length: ${cleaned.length}`);
    return cleaned.slice(0, 5000); // Limit to 5000 chars
  } catch (e) {
    if (DEBUG_PARSE) console.warn('[fetchUrlContent] Failed:', e);
    return null;
  }
}

export async function parseReceipt(
  options: ParseOptions
): Promise<ParseResult> {
  if (!GEMINI_API_KEY) {
    if (DEBUG_PARSE)
      console.warn("[parseReceipt] Using mock: GEMINI_API_KEY not set");
    return mockParse();
  }

  let finalQrData = options.qrData;
  if (finalQrData && finalQrData.startsWith('http')) {
    const fetched = await fetchUrlContent(finalQrData);
    if (fetched) {
      finalQrData = `ORIGINAL URL: ${finalQrData}\n\nPAGE CONTENT FOR EXTRACTION:\n${fetched}`;
    }
  }

  if (DEBUG_PARSE && !/^AIza[0-9A-Za-z_-]{10,}$/.test(GEMINI_API_KEY)) {
    console.warn(
      "[parseReceipt] GEMINI_API_KEY format unexpected (should usually start with 'AIza')."
    );
  }
  const dynamicCandidates = cachedModel
    ? [
        cachedModel.model,
        ...MODEL_CANDIDATES.filter((m) => m !== cachedModel!.model),
      ]
    : MODEL_CANDIDATES.slice();
  if (DEBUG_PARSE) {
    console.log(
      `[parseReceipt] REST mode; preferred version=${GEMINI_API_VERSION}; cached=${
        cachedModel ? cachedModel.model + "@" + cachedModel.version : "none"
      }; candidates=${dynamicCandidates.join(",")}`
    );
  }
  const prompt = `${EXTRACTION_INSTRUCTIONS}\nLanguage context of receipt: ${options.language}\nSession Name: ${options.sessionName}`;
  const imagePart = {
    inlineData: {
      data: options.imageBase64,
      mimeType: options.mimeType,
    },
  } as const;

  let lastError: unknown = null;
  const modelsTried: NonNullable<ParseResult["modelsTried"]> = [];
  for (const modelName of dynamicCandidates) {
    const start = Date.now();
    try {
      if (DEBUG_PARSE) console.log(`[parseReceipt] Trying model: ${modelName}`);
      const text = await generateViaRest(
        modelName,
        prompt,
        options.imageBase64,
        options.mimeType,
        finalQrData
      );
      const parsed = safeParseJson(text);
      if (!parsed.ok || !parsed.data) {
        if (DEBUG_PARSE) {
          console.warn(
            `[parseReceipt] Model ${modelName} returned non-parseable JSON, length=${text.length}. Snippet=`,
            text.slice(0, 280)
          );
        }
        modelsTried.push({
          model: modelName,
          version: lastUsedVersion || "?",
          status: "parse_fail",
          durationMs: Date.now() - start,
          chars: text.length,
        });
        continue; // try next model
      }
      const durationMs = Date.now() - start;
      const truncated = DEBUG_PARSE
        ? text.length > 4000
          ? text.slice(0, 4000) + `\n/* trimmed ${text.length - 4000} chars */`
          : text
        : undefined;
      const result: ParseResult = {
        ...parsed.data,
        model: modelName,
        durationMs,
        rawModelText: truncated,
        usedModelVersion: lastUsedVersion,
        modelsTried: DEBUG_PARSE
          ? [
              ...modelsTried,
              {
                model: modelName,
                version: lastUsedVersion || "?",
                status: "ok",
                durationMs,
                chars: text.length,
              },
            ]
          : undefined,
      };
      if (!cachedModel) {
        cachedModel = { model: modelName, version: lastUsedVersion || "v1" };
        if (DEBUG_PARSE)
          console.log(
            `[parseReceipt] Caching model ${cachedModel.model}@${cachedModel.version}`
          );
      }
      return result;
    } catch (err: any) {
      lastError = err;
      const status = err?.status || err?.statusCode;
      if (DEBUG_PARSE)
        console.warn(
          `[parseReceipt] Error with model ${modelName} (status=${status}) → ${
            err?.message || err
          }`
        );
      modelsTried.push({
        model: modelName,
        version: lastUsedVersion || "?",
        status: status ? "http_error" : "exception",
        httpStatus: status,
        durationMs: Date.now() - start,
        errorMessage: err?.apiError?.message || err?.message,
        errorCode: err?.apiError?.code,
      });
      continue;
    }
  }
  if (DEBUG_PARSE)
    console.error(
      "[parseReceipt] All model attempts failed, returning mock. Last error:",
      lastError
    );
  const fallback = mockParse();
  if (DEBUG_PARSE) fallback.modelsTried = modelsTried;
  return fallback;
}

async function generateViaRest(
  model: string,
  prompt: string,
  base64?: string,
  mime?: string,
  qrData?: string
): Promise<string> {
  const order = ["v1"]; // 🔧 always use v1, no v1beta anymore
  let lastErr: any = null;
  for (const ver of order) {
    const url = `https://generativelanguage.googleapis.com/${ver}/models/${model}:generateContent?key=${encodeURIComponent(
      GEMINI_API_KEY as string
    )}`;
    
    const parts: any[] = [{ text: `${prompt}\nOUTPUT ONLY RAW JSON. NO MARKDOWN.` }];
    
    if (qrData) {
      parts.push({ text: `Extract the receipt information from this QR Code data/URL payload: ${qrData}` });
    } else if (base64 && mime) {
      parts.push({ inlineData: { data: base64, mimeType: mime } });
    }

    const body = {
      contents: [
        {
          role: "user",
          parts,
        },
      ],
      generationConfig: { temperature: 0.1 },
    };
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        let errorPayload: any = undefined;
        try {
          const txt = await resp.text();
          if (txt) {
            try {
              const parsed = JSON.parse(txt);
              errorPayload = parsed.error || parsed;
            } catch {
              errorPayload = { raw: txt.slice(0, 500) };
            }
          }
        } catch {}
        if (DEBUG_PARSE) {
          const code = errorPayload?.code || resp.status;
          const msg = errorPayload?.message || resp.statusText;
          console.warn(
            `[generateViaRest] ${ver} ${model} -> HTTP ${resp.status} (${code}) ${msg}`
          );
          if (errorPayload?.status && errorPayload?.status !== code) {
            console.warn(
              `[generateViaRest] API error status field: ${errorPayload.status}`
            );
          }
        }
        lastErr = Object.assign(
          new Error(
            `HTTP ${resp.status} ${errorPayload?.message || resp.statusText}`
          ),
          {
            status: resp.status,
            apiError: errorPayload,
          }
        );
        continue;
      }
      const json = await resp.json();
      const texts: string[] = [];
      if (Array.isArray(json.candidates)) {
        for (const cand of json.candidates) {
          const parts = cand?.content?.parts || cand?.parts || [];
          for (const p of parts) if (p.text) texts.push(p.text);
        }
      }
      const combined = texts.join("\n").trim();
      if (DEBUG_PARSE)
        console.log(
          `[generateViaRest] success via ${ver} model=${model} chars=${combined.length}`
        );
      return combined;
    } catch (e) {
      lastErr = e;
      if (DEBUG_PARSE)
        console.warn(`[generateViaRest] Error calling ${ver} ${model}:`, e);
      continue;
    }
  }
  throw lastErr || new Error("All versions failed");
}
