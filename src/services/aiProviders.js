import { GoogleGenerativeAI } from '@google/generative-ai';

export class AIProviderFactory {
  static create(provider, apiKey) {
    switch (provider) {
      case 'gemini':
        return new GeminiProvider(apiKey);
      case 'openai':
        return new OpenAIProvider(apiKey);
      case 'anthropic':
        return new AnthropicProvider(apiKey);
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
}

class BaseProvider {
  constructor(apiKey) {
    this.apiKey = apiKey;
  }
  async generate(prompt) {
    throw new Error('Not implemented');
  }
}

class GeminiProvider extends BaseProvider {
  constructor(apiKey) {
    super(apiKey);
    this.genAI = new GoogleGenerativeAI(apiKey);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
  }

  async generate(prompt) {
    const result = await this.model.generateContent(prompt);
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
        model: 'gpt-4-turbo-preview',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4000
      })
    });
    const data = await response.json();
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
        model: 'claude-3-opus-20240229',
        max_tokens: 4000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const data = await response.json();
    return data.content[0].text;
  }
}