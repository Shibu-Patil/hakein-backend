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
  }
  async generate(prompt) {
    throw new Error('Not implemented');
  }
}

class GeminiProvider extends BaseProvider {
  constructor(apiKey, model) {
    super(apiKey, model);
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.generativeModel = this.genAI.getGenerativeModel({ model });
  }

  async generate(prompt) {
    const result = await this.generativeModel.generateContent(prompt);
    return result.response.text();
  }
}

class OpenAIProvider extends BaseProvider {
  async generate(prompt) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
    const data = await response.json();
    if (!data.choices?.[0]) throw new Error(`OpenAI error: ${JSON.stringify(data).slice(0, 300)}`);
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
    if (!data.content?.[0]) throw new Error(`Anthropic error: ${JSON.stringify(data).slice(0, 300)}`);
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
    if (!data.choices?.[0]) throw new Error(`OpenRouter error: ${JSON.stringify(data).slice(0, 300)}`);
    return data.choices[0].message.content;
  }
}
