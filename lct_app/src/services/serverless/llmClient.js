import { serverlessAuthHeaders, NeedsKeyError } from "./serverlessAuth";

export function extractJsonFromText(text) {
  if (!text) {
    throw new Error("LLM response text is empty");
  }

  // Strip chain-of-thought style wrappers
  const normalized = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  
  if (!normalized) {
    throw new Error("No JSON object found");
  }

  try {
    return JSON.parse(normalized);
  } catch (e) {
    // Ignore initial parse error
  }

  // Look for markdown code fences
  if (normalized.includes("```")) {
    const fences = ["```json", "```"];
    for (const fence of fences) {
      if (normalized.includes(fence)) {
        const parts = normalized.split(fence);
        if (parts.length > 1) {
          const snippet = parts[1];
          if (snippet.includes("```")) {
            const candidate = snippet.split("```")[0].trim();
            try {
              return JSON.parse(candidate);
            } catch (e) {
              continue;
            }
          }
        }
      }
    }
  }

  // Robust fallback: decode the first valid JSON value from any object/array start
  let firstBracket = -1;
  const objBracket = normalized.indexOf('{');
  const arrBracket = normalized.indexOf('[');
  
  if (objBracket !== -1 && arrBracket !== -1) {
    firstBracket = Math.min(objBracket, arrBracket);
  } else if (objBracket !== -1) {
    firstBracket = objBracket;
  } else if (arrBracket !== -1) {
    firstBracket = arrBracket;
  }

  if (firstBracket !== -1) {
    const candidateStr = normalized.substring(firstBracket);
    // JS doesn't have a built-in partial JSON decoder like Python's raw_decode.
    // We try to match matching brackets manually.
    let depth = 0;
    let endIndex = -1;
    let isString = false;
    let escape = false;

    for (let i = 0; i < candidateStr.length; i++) {
      const char = candidateStr[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (char === '\\') {
        escape = true;
        continue;
      }
      if (char === '"') {
        isString = !isString;
        continue;
      }
      if (!isString) {
        if (char === '{' || char === '[') {
          depth++;
        } else if (char === '}' || char === ']') {
          depth--;
          if (depth === 0) {
            endIndex = i;
            break;
          }
        }
      }
    }
    
    if (endIndex !== -1) {
      try {
        return JSON.parse(candidateStr.substring(0, endIndex + 1));
      } catch (e) {
        // Fallthrough
      }
    }
  }

  throw new Error("No JSON object found");
}

/**
 * Call the Vercel Proxy to hit OpenAI's chat completions API.
 * @param {string} apiKey - The user's BYOK OpenAI Key
 * @param {Array} messages - The ChatML formatted messages
 * @param {Object} options - extra config (temperature, model, etc)
 * @returns {Promise<Object>} The parsed JSON response 
 */
export async function callServerlessLlm(apiKey, messages, options = {}) {
  const model = options.model || "gpt-4o";
  const temperature = options.temperature || 0.2;

  const reqBody = {
    model,
    messages,
    temperature,
    // we could enforce response_format: { type: "json_object" } but we parse robustly anyway
    response_format: options.jsonMode ? { type: "json_object" } : undefined
  };

  const authHeaders = serverlessAuthHeaders(apiKey);
  if (!authHeaders) throw new NeedsKeyError();

  const response = await fetch('/api/proxy/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders
    },
    body: JSON.stringify(reqBody)
  });

  // 402 = the free trial's shared budget is used up: prompt for the visitor's key.
  if (response.status === 402) {
    throw new NeedsKeyError("Free trial used up. Add your OpenAI key to keep going.");
  }
  if (!response.ok) {
    let errText = await response.text().catch(() => "");
    throw new Error(`LLM Proxy Error (${response.status}): ${errText}`);
  }

  const json = await response.json();
  const content = json.choices?.[0]?.message?.content || "";
  
  if (options.jsonMode || options.extractJson) {
    return extractJsonFromText(content);
  }

  return content;
}
