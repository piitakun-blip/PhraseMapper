const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

const AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: JSON_HEADERS,
  });
}

async function readJson(request) {
  const length = Number(request.headers.get("content-length") || 0);
  if (length > 50_000) {
    throw new Error("Request too large");
  }
  return await request.json();
}

async function fetchJsonWithTimeout(url, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "PhraseMapper/1.0",
        "accept": "application/json,text/plain,*/*",
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function parseGoogleTranslation(data) {
  let translation = "";
  let translit = "";

  if (data && Array.isArray(data[0])) {
    for (const segment of data[0]) {
      if (!Array.isArray(segment)) continue;

      if (typeof segment[0] === "string") {
        translation += segment[0];
      }

      if (!segment[0]) {
        if (typeof segment[2] === "string" && segment[2].trim()) {
          translit += segment[2];
        } else if (typeof segment[3] === "string" && segment[3].trim()) {
          translit += segment[3];
        }
      }
    }
  }

  if (!translation.trim()) return null;

  return {
    translation: translation.trim(),
    translit: translit.trim(),
    provider: "google",
  };
}

async function googleTranslate(text, sourceLang, targetLang) {
  const url =
    "https://translate.googleapis.com/translate_a/single" +
    "?client=gtx" +
    "&sl=" + encodeURIComponent(sourceLang) +
    "&tl=" + encodeURIComponent(targetLang) +
    "&dt=t" +
    "&dt=rm" +
    "&q=" + encodeURIComponent(text);

  const delays = [0, 500, 1200];

  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt]) {
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }

    try {
      const data = await fetchJsonWithTimeout(url, 4500);
      const parsed = parseGoogleTranslation(data);
      if (parsed) return parsed;
    } catch (error) {
      console.warn(`Google attempt ${attempt + 1} failed`, error);
    }
  }

  return null;
}

async function lingvaTranslate(text, sourceLang, targetLang) {
  const map = { zh: "zh-CN" };
  const source = map[sourceLang] || sourceLang;
  const target = map[targetLang] || targetLang;

  const instances = [
    "https://translate.dr460nf1r3.org",
    "https://lingva.garudalinux.org",
    "https://translate.jae.fi",
  ];

  const tasks = instances.map(async (base) => {
    const url =
      `${base}/api/v1/` +
      `${encodeURIComponent(source)}/` +
      `${encodeURIComponent(target)}/` +
      `${encodeURIComponent(text)}`;

    const data = await fetchJsonWithTimeout(url, 4500);
    const translation = data?.translation;

    if (!translation || !String(translation).trim()) {
      throw new Error("No translation");
    }

    return {
      translation: String(translation).trim(),
      translit: "",
      provider: "lingva",
    };
  });

  try {
    return await Promise.any(tasks);
  } catch {
    return null;
  }
}

async function myMemoryTranslate(text, sourceLang, targetLang) {
  const langMap = { zh: "zh-CN" };
  const source = langMap[sourceLang] || sourceLang;
  const target = langMap[targetLang] || targetLang;

  const url =
    "https://api.mymemory.translated.net/get" +
    "?q=" + encodeURIComponent(text) +
    "&langpair=" + encodeURIComponent(`${source}|${target}`);

  try {
    const data = await fetchJsonWithTimeout(url, 6000);
    const translation = data?.responseData?.translatedText;

    if (!translation || !String(translation).trim()) {
      return null;
    }

    return {
      translation: String(translation).trim(),
      translit: "",
      provider: "mymemory",
    };
  } catch {
    return null;
  }
}

async function handleTranslate(request) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const text = String(body?.text || "").trim();
  const sourceLang = String(body?.sourceLang || "").trim();
  const targetLang = String(body?.targetLang || "").trim();
  const allowBackup = body?.allowBackup === true;
  const allowMyMemory = body?.allowMyMemory === true;

  if (!text || !sourceLang || !targetLang) {
    return jsonResponse({ error: "Missing translation fields" }, 400);
  }

  if (text.length > 4000) {
    return jsonResponse({ error: "Text too long" }, 400);
  }

  const google = await googleTranslate(text, sourceLang, targetLang);
  if (google) return jsonResponse(google);

  if (allowBackup) {
    const lingva = await lingvaTranslate(text, sourceLang, targetLang);
    if (lingva) return jsonResponse(lingva);

    if (allowMyMemory) {
      const memory = await myMemoryTranslate(text, sourceLang, targetLang);
      if (memory) return jsonResponse(memory);
    }
  }

  return jsonResponse({
    translation: "",
    translit: "",
    provider: "unavailable",
  }, 503);
}

function buildTutorPrompt(body) {
  const languageName = String(body?.languageName || "the selected language");
  const englishSentence = String(body?.englishSentence || "").trim();
  const translatedSentence = String(body?.translatedSentence || "").trim();
  const question = String(body?.question || "").trim();

  const cards = Array.isArray(body?.phraseCards)
    ? body.phraseCards.slice(0, 20)
    : [];

  const phraseText = cards
    .map((card, index) => {
      const phrase = String(card?.phrase || "").trim();
      const gloss = String(card?.gloss || "").trim();
      const reading = String(card?.reading || "").trim();
      const romaji = String(card?.romaji || "").trim();

      return `${index + 1}. ${phrase}` +
        (gloss ? ` — ${gloss}` : "") +
        (reading ? ` | reading: ${reading}` : "") +
        (romaji ? ` | romaji: ${romaji}` : "");
    })
    .join("\n");

  return `You are a concise language tutor inside an app called Ward's Phrase Mapper.

The learner is studying ${languageName}.
Explain the CURRENT translation in context, not isolated dictionary meanings.
Be accurate, practical, and concise.
When useful, explain grammar, word order, idioms, register, and why the natural translation differs from literal English.
Do not invent phrase-card meanings that conflict with the complete translated sentence.
If the translation itself seems unnatural, say so and give a better natural alternative.

English sentence:
${englishSentence || "(none)"}

${languageName} sentence:
${translatedSentence || "(none)"}

Phrase cards:
${phraseText || "(none)"}

Learner question:
${question}

Answer the learner directly.`;
}

function extractAIText(result) {
  if (!result) return "";

  if (typeof result === "string") return result;

  if (typeof result.response === "string") return result.response;

  if (typeof result.result === "string") return result.result;

  if (typeof result.output_text === "string") return result.output_text;

  if (Array.isArray(result)) {
    return result
      .map((x) => extractAIText(x))
      .filter(Boolean)
      .join("\n");
  }

  return "";
}

async function handleChat(request, env) {
  if (!env.AI) {
    return jsonResponse({
      error: "Workers AI binding is not configured",
    }, 503);
  }

  let body;
  try {
    body = await readJson(request);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const question = String(body?.question || "").trim();

  if (!question) {
    return jsonResponse({ error: "Question is required" }, 400);
  }

  if (question.length > 2000) {
    return jsonResponse({ error: "Question too long" }, 400);
  }

  const prompt = buildTutorPrompt(body);

  try {
    const result = await env.AI.run(AI_MODEL, {
      prompt,
      max_tokens: 650,
      temperature: 0.35,
    });

    const answer = extractAIText(result).trim();

    if (!answer) {
      return jsonResponse({
        error: "AI returned no text",
      }, 502);
    }

    return jsonResponse({
      answer,
      model: AI_MODEL,
    });
  } catch (error) {
    console.error("AI error", error);

    return jsonResponse({
      error: "AI tutor unavailable",
    }, 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": url.origin,
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (url.pathname === "/api/translate") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return handleTranslate(request);
    }

    if (url.pathname === "/api/chat") {
      if (request.method !== "POST") {
        return jsonResponse({ error: "Method not allowed" }, 405);
      }
      return handleChat(request, env);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Phrase Mapper backend is running.", {
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
