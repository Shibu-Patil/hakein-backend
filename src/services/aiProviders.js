import { GoogleGenerativeAI } from '@google/generative-ai';

export class AIProviderFactory {
  static create(provider, apiKey, model) {
    switch (provider) {
      case 'gemini':
        return new GeminiProvider(apiKey, model || 'gemini-1.5-pro');
      case 'openai':
        return new OpenAIProvider(apiKey, model || 'gpt-4-turbo-preview');
      case 'anthropic':
        return new AnthropicProvider(apiKey, model || 'claude-3-opus-20240229');
      case 'openrouter':
        return new OpenRouterProvider(apiKey, model || 'meta-llama/llama-3.1-70b-instruct');
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

class BaseProvider {
  constructor(apiKey, model) {
    this.apiKey = apiKey;
    this.model = model;
    this.lastUsage = null; // { input, output, total } of the most recent call
  }
  async generate(prompt) {
    throw new Error('Not implemented');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransient(err) {
  return /503|overloaded|high demand|Service Unavailable|429|rate limit|timeout|ETIMEDOUT|ECONNRESET|500/i.test(String(err?.message || err));
}

class GeminiProvider extends BaseProvider {
  constructor(apiKey, model) {
    super(apiKey, model);
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.generativeModel = this.genAI.getGenerativeModel({ model });
  }

  async generate(prompt) {
    // Transient spikes (503 overloaded) are retried with backoff instead of failing the resume.
    let result;
    let lastErr = null;
    for (const wait of [0, 3000, 8000]) {
      if (wait) await sleep(wait);
      try {
        result = await this.generativeModel.generateContent(prompt);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!isTransient(e)) break;
      }
    }
    if (!result) {
      throw friendlyModelError(lastErr, this.model);
    }
    const um = result.response?.usageMetadata;
    this.lastUsage = um
      ? { input: um.promptTokenCount || 0, output: um.candidatesTokenCount || 0, total: um.totalTokenCount || 0 }
      : null;
    return result.response.text();
  }
}

class OpenAIProvider extends BaseProvider {
  async generate(prompt) {
    let response;
    try {
      response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.3,
          max_tokens: 4000
        })
      });
    } catch (e) {
      throw friendlyModelError(e, this.model);
    }
    const data = await response.json();
    if (!data.choices?.[0]) throw friendlyModelError(new Error(`OpenAI error: ${JSON.stringify(data).slice(0, 300)}`), this.model);
    const u = data.usage;
    this.lastUsage = u ? { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 } : null;
    return data.choices[0].message.content;
  }
}

class AnthropicProvider extends BaseProvider {
  async generate(prompt) {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    if (!data.content?.[0]) throw friendlyModelError(new Error(`Anthropic error: ${JSON.stringify(data).slice(0, 300)}`), this.model);
    const u = data.usage;
    this.lastUsage = u ? { input: u.input_tokens || 0, output: u.output_tokens || 0, total: (u.input_tokens || 0) + (u.output_tokens || 0) } : null;
    return data.content[0].text;
  }
}

class OpenRouterProvider extends BaseProvider {
  async generate(prompt) {
    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/Shibu-Patil/hakein-backend',
        'X-Title': 'Hakein'
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4000
      })
    });
    const data = await response.json();
    if (!data.choices?.[0]) throw friendlyModelError(new Error(`OpenRouter error: ${JSON.stringify(data).slice(0, 300)}`), this.model);
    const u = data.usage;
    this.lastUsage = u ? { input: u.prompt_tokens || 0, output: u.completion_tokens || 0, total: u.total_tokens || 0 } : null;
    return data.choices[0].message.content;
  }
}

// Turn raw SDK errors (bad model name, overload, bad key) into actionable messages.
export function friendlyModelError(err, model) {
  const msg = String(err?.message || err);
  if (/503|overloaded|high demand|Service Unavailable/i.test(msg)) {
    const e = new Error(
      `Model "${model}" stayed overloaded after retries. Wait a minute and try again — spikes are temporary. (Your key and model name are both valid.)`
    );
    e.status = 502;
    e.cause = msg.slice(0, 300);
    return e;
  }
  if (/404|not found|does not exist|invalid model/i.test(msg)) {
    const e = new Error(`Model "${model}" was not found. Fix the model name in agent.yaml.`);
    e.status = 502;
    e.cause = msg.slice(0, 300);
    return e;
  }
  if (/401|403|API key|invalid key|unauthenticated/i.test(msg)) {
    const e = new Error(`API key rejected for model "${model}". Check the key in .env (keys come only from env).`);
    e.status = 502;
    e.cause = msg.slice(0, 300);
    return e;
  }
  return err instanceof Error ? err : new Error(msg);
}
