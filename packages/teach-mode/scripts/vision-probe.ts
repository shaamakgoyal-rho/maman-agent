/**
 * ONE real vision call, against a synthetic frame, reporting what it cost.
 *
 * This exists because everything about Teach Mode's inference step is currently
 * unproven-by-running: the request body, the prompt, and above all whether a real
 * model reply actually satisfies `visionObservationSchema`. Until now that schema
 * has only ever been tested against fixtures written by the same person who wrote
 * the schema, which proves nothing about the model.
 *
 * It uses a SYNTHETIC frame — a generated picture of a fake CRM form — not a
 * capture of the operator's screen. The path, the prompt and the token cost are
 * identical either way, and nobody's real work needs to leave a machine to answer
 * "does this work and what does it cost".
 *
 *   ANTHROPIC_API_KEY=... ANTHROPIC_VISION_MODEL=... pnpm teach:vision-probe
 *
 * It makes exactly ONE request. Cost is a fraction of a cent.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visionObservationSchema } from "@maman/contracts";
import { interpretVisionResponse } from "../src/interpret.js";
import {
  estimateSessionCost,
  imageTokens,
  SHIPPED_VISION_DEFAULTS,
  type TokenPrice,
} from "../src/cost.js";

const FRAME_ID = "018f0000-0000-7000-8000-0000000000f1";
const SESSION_ID = "018f0000-0000-7000-8000-000000000001";

/**
 * The prompt, duplicated from `apps/desktop/src-tauri/src/vision.rs`.
 *
 * A probe that sent a DIFFERENT prompt from the one that ships would answer the
 * wrong question, so this file asserts the two match rather than trusting them to.
 */
const VISION_RS = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "apps",
  "desktop",
  "src-tauri",
  "src",
  "vision.rs",
);

function shippedPrompt(): string {
  const src = readFileSync(VISION_RS, "utf8");
  const block = /pub const VISION_SYSTEM_PROMPT: &str = concat!\(([\s\S]*?)\n\);/.exec(src);
  if (!block) throw new Error("could not find VISION_SYSTEM_PROMPT in vision.rs");
  const parts = [...block[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) =>
    m[1]!.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
  );
  return parts.join("");
}

/**
 * A synthetic CRM edit screen, as an SVG rendered to PNG-free base64.
 *
 * Deliberately includes a credential-shaped field ("API Key") that a real capture
 * would have had BLACKED OUT by the egress gate, drawn here as a black rectangle —
 * so the probe also checks the model obeys "never speculate about what was behind
 * a black rectangle".
 */
function syntheticFrameSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SHIPPED_VISION_DEFAULTS.frameWidth}" height="${SHIPPED_VISION_DEFAULTS.frameHeight}">
  <rect width="100%" height="100%" fill="#ffffff"/>
  <rect x="0" y="0" width="100%" height="64" fill="#f4f6f9"/>
  <text x="32" y="42" font-family="Helvetica" font-size="24" fill="#16325c">Acme CRM — Opportunity</text>
  <text x="32" y="120" font-family="Helvetica" font-size="20" fill="#54698d">Account Name</text>
  <rect x="32" y="134" width="420" height="42" fill="#ffffff" stroke="#d8dde6"/>
  <text x="44" y="162" font-family="Helvetica" font-size="20" fill="#080707">Northwind Traders</text>
  <text x="32" y="212" font-family="Helvetica" font-size="20" fill="#54698d">Close Date</text>
  <rect x="32" y="226" width="420" height="42" fill="#ffffff" stroke="#1589ee" stroke-width="3"/>
  <text x="44" y="254" font-family="Helvetica" font-size="20" fill="#080707">2026-12-31</text>
  <text x="32" y="304" font-family="Helvetica" font-size="20" fill="#54698d">Stage</text>
  <rect x="32" y="318" width="420" height="42" fill="#ffffff" stroke="#d8dde6"/>
  <text x="44" y="346" font-family="Helvetica" font-size="20" fill="#080707">Closed Won</text>
  <text x="32" y="396" font-family="Helvetica" font-size="20" fill="#54698d">API Key</text>
  <rect x="32" y="410" width="420" height="42" fill="#000000"/>
  <rect x="32" y="500" width="140" height="48" rx="4" fill="#0070d2"/>
  <text x="70" y="530" font-family="Helvetica" font-size="20" fill="#ffffff">Save</text>
</svg>`;
}

async function svgToJpegBase64(svg: string): Promise<string> {
  // No image dependency is added for a probe: macOS ships `sips`, and a temp file
  // here is fine because this frame is synthetic and contains nobody's data.
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { execFileSync } = await import("node:child_process");
  const dir = mkdtempSync(join(tmpdir(), "maman-vision-probe-"));
  const svgPath = join(dir, "frame.svg");
  const jpegPath = join(dir, "frame.jpg");
  writeFileSync(svgPath, svg);
  execFileSync("sips", ["-s", "format", "jpeg", svgPath, "--out", jpegPath], { stdio: "ignore" });
  return readFileSync(jpegPath).toString("base64");
}

async function main(): Promise<void> {
  // `--dry-run` exercises everything except the network: prompt extraction, frame
  // rendering, sizing. It exists so that the FIRST run with a real key fails only
  // for reasons the key is responsible for, instead of on a broken SVG converter.
  const dryRun = process.argv.includes("--dry-run");
  const apiKey = process.env["ANTHROPIC_API_KEY"] ?? "";
  const model = process.env["ANTHROPIC_VISION_MODEL"] ?? "";
  if (dryRun) {
    const prompt = shippedPrompt();
    const jpegB64 = await svgToJpegBase64(syntheticFrameSvg());
    console.log(`prompt extracted from vision.rs: ${prompt.length} chars`);
    console.log(`  starts: ${JSON.stringify(prompt.slice(0, 58))}`);
    console.log(`  ends:   ${JSON.stringify(prompt.slice(-46))}`);
    console.log(`synthetic frame: ${Math.round(jpegB64.length / 1024)} KB base64`);
    console.log(
      `predicted input tokens: ${
        imageTokens(SHIPPED_VISION_DEFAULTS.frameWidth, SHIPPED_VISION_DEFAULTS.frameHeight) +
        SHIPPED_VISION_DEFAULTS.systemPromptTokens
      }`,
    );
    console.log("dry run: nothing was sent.");
    return;
  }
  if (!apiKey || !model) {
    console.error(
      "vision-probe needs ANTHROPIC_API_KEY and ANTHROPIC_VISION_MODEL.\n" +
        "Nothing is sent without both — Teach Mode behaves the same way.",
    );
    process.exit(2);
  }

  const prompt = shippedPrompt();
  const jpegB64 = await svgToJpegBase64(syntheticFrameSvg());
  console.log(
    `frame: ${SHIPPED_VISION_DEFAULTS.frameWidth}x${SHIPPED_VISION_DEFAULTS.frameHeight}, ${Math.round(jpegB64.length / 1024)} KB base64`,
  );
  console.log(
    `predicted image tokens: ${imageTokens(SHIPPED_VISION_DEFAULTS.frameWidth, SHIPPED_VISION_DEFAULTS.frameHeight)}`,
  );
  console.log(`model: ${model}\n`);

  const startedAt = Date.now();
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      // Mirrors vision.rs exactly, cache block included.
      system: [{ type: "text", text: prompt, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpegB64 } },
            {
              type: "text",
              text: `frame_id=${FRAME_ID} session_id=${SESSION_ID}\nReply with JSON only.`,
            },
          ],
        },
      ],
    }),
  });
  const latencyMs = Date.now() - startedAt;

  if (!response.ok) {
    console.error(`✗ HTTP ${response.status} — the body is NOT printed (it can echo the request).`);
    process.exit(1);
  }

  const body = (await response.json()) as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
  };
  const text = body.content?.find((c) => c.type === "text")?.text ?? "";
  const usage = {
    input: body.usage?.input_tokens ?? 0,
    output: body.usage?.output_tokens ?? 0,
    cacheRead: body.usage?.cache_read_input_tokens ?? 0,
  };

  console.log(`latency: ${latencyMs} ms`);
  console.log(`tokens:  in=${usage.input} out=${usage.output} cache_read=${usage.cacheRead}`);

  // Compare what actually happened against the numbers the panel shows a user.
  const predicted =
    imageTokens(SHIPPED_VISION_DEFAULTS.frameWidth, SHIPPED_VISION_DEFAULTS.frameHeight) +
    SHIPPED_VISION_DEFAULTS.systemPromptTokens;
  console.log(
    `predicted input ${predicted} vs actual ${usage.input} ` +
      `(${usage.input > 0 ? `${Math.round((usage.input / predicted) * 100)}% of estimate` : "n/a"})`,
  );
  console.log(
    `predicted output ${SHIPPED_VISION_DEFAULTS.expectedOutputTokens} vs actual ${usage.output}`,
  );

  // THE POINT OF THE PROBE: does a real reply satisfy the strict schema?
  let parsedJson: unknown;
  const fenced = text
    .trim()
    .replace(/^```(?:json)?/, "")
    .replace(/```$/, "")
    .trim();
  try {
    parsedJson = JSON.parse(fenced);
  } catch {
    console.error(`\n✗ the reply was not JSON at all:\n${text.slice(0, 400)}`);
    process.exit(1);
  }
  const schema = visionObservationSchema.safeParse(parsedJson);
  const interpreted = interpretVisionResponse(parsedJson, {
    frameId: FRAME_ID,
    sessionId: SESSION_ID,
  });

  console.log(`\nschema: ${schema.success ? "✓ accepted" : "✗ REJECTED"}`);
  if (!schema.success) {
    for (const issue of schema.error.issues.slice(0, 6)) {
      console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  }
  console.log(
    `interpreter: ${interpreted.ok ? `✓ ${interpreted.actions.length} usable action(s)` : `refused (${interpreted.reason})`}`,
  );
  if (interpreted.ok) {
    for (const a of interpreted.actions) {
      console.log(
        `  · ${a.event_type} ${a.target_role}/${a.semantic_type} "${a.label ?? ""}" @ ${a.confidence}`,
      );
    }
  }
  console.log(`\nraw reply:\n${JSON.stringify(parsedJson, null, 2)}`);

  // What one real frame implies for a whole session, using the measured numbers.
  if (usage.input > 0) {
    const price: TokenPrice = { input_per_mtok_usd: 3, output_per_mtok_usd: 15 };
    const measured = estimateSessionCost({
      ...SHIPPED_VISION_DEFAULTS,
      systemPromptTokens: Math.max(
        0,
        usage.input -
          imageTokens(SHIPPED_VISION_DEFAULTS.frameWidth, SHIPPED_VISION_DEFAULTS.frameHeight),
      ),
      expectedOutputTokens: usage.output,
      maxSeconds: 900,
      price,
    });
    console.log(
      `\n15-min ceiling recomputed from THIS call, at $3/$15 per Mtok: ` +
        `$${measured.maxCostUsd.toFixed(2)} (${measured.maxFrames} frames)`,
    );
  }

  if (!schema.success) process.exit(1);
}

await main();
