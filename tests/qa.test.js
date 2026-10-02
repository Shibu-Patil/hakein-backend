import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeQuestion,
  isSensitive,
  matchQaProfile,
  coerceToOptions,
  closestOptionFallback,
  llmAnswer,
  answerQuestion
} from '../src/services/qaService.js';

const fakeAI = (text) => ({ generate: async () => text });

describe('qa - normalize + sensitive', () => {
  it('normalizes questions', () => {
    assert.equal(normalizeQuestion('  Do you need SPONSORSHIP? *'), 'do you need sponsorship');
  });
  it('flags sensitive questions', () => {
    assert.equal(isSensitive('Do you have a disability?'), true);
    assert.equal(isSensitive('How many years of React experience?'), false);
  });
});

describe('qa - qaProfile matching', () => {
  it('matches sponsorship from qaProfile', () => {
    const r = matchQaProfile('Will you require sponsorship now or in future?', { sponsorship: 'no' }, {});
    assert.equal(r.answer, 'no');
    assert.equal(r.source, 'qaProfile');
  });
  it('matches phone from profile', () => {
    const r = matchQaProfile('Mobile number?', {}, { phone: '9999999999' });
    assert.equal(r.answer, '9999999999');
  });
  it('returns missing when profile lacks the key', () => {
    const r = matchQaProfile('Expected CTC?', {}, {});
    assert.equal(r.answer, null);
    assert.equal(r.missing, true);
  });
});

describe('qa - option coercion', () => {
  it('exact match wins', () => {
    assert.equal(coerceToOptions('Yes', ['Yes', 'No']), 'Yes');
  });
  it('yes/no coercion is case-insensitive', () => {
    assert.equal(coerceToOptions('y', ['Yes', 'No']), 'Yes');
    assert.equal(coerceToOptions('NO', ['Yes', 'No']), 'No');
  });
  it('returns null when nothing matches', () => {
    assert.equal(coerceToOptions('Maybe', ['Yes', 'No']), null);
  });
});

describe('qa - llm fallback', () => {
  it('parses llm json answer', async () => {
    const r = await llmAnswer({
      question: 'How many years of React experience?',
      fieldType: 'text',
      job: 'React developer wanted',
      resumeText: '4 years building React apps',
      aiProvider: fakeAI('{"answer":"4","confidence":"high"}')
    });
    assert.equal(r.answer, '4');
  });
  it('coerces llm answer to options', async () => {
    const r = await llmAnswer({
      question: 'Are you authorized to work?',
      fieldType: 'radio',
      options: ['Yes', 'No'],
      job: '',
      resumeText: 'Authorized to work in India',
      aiProvider: fakeAI('{"answer":"yes","confidence":"high"}')
    });
    assert.equal(r.answer, 'Yes');
  });
  it('rejects when llm answer matches no option', async () => {
    const r = await llmAnswer({
      question: 'Are you authorized to work?',
      fieldType: 'radio',
      options: ['Yes', 'No'],
      job: '',
      resumeText: '',
      aiProvider: fakeAI('{"answer":"Maybe later","confidence":"high"}')
    });
    assert.equal(r.answer, null);
  });
});

describe('qa - answerQuestion priority (no DB)', () => {
  it('prefers qaProfile over llm', async () => {
    const r = await answerQuestion({
      userId: null,
      user: { qaProfile: { sponsorship: 'no' }, profile: {} },
      question: 'Will you need sponsorship?',
      fieldType: 'radio',
      options: ['Yes', 'No'],
      job: '',
      resumeText: '',
      aiProvider: fakeAI('{"answer":"Yes","confidence":"high"}')
    });
    assert.equal(r.answer, 'No');
    assert.equal(r.source, 'qaProfile');
  });
  it('falls back to llm with resume+jd', async () => {
    const r = await answerQuestion({
      userId: null,
      user: { qaProfile: {}, profile: {} },
      question: 'How many years of Node.js experience?',
      fieldType: 'text',
      job: 'Need 3+ years Node',
      resumeText: '5 years Node.js backend work',
      aiProvider: fakeAI('{"answer":"5","confidence":"high"}')
    });
    assert.equal(r.answer, '5');
    assert.equal(r.source, 'llm');
  });
  it('refuses sensitive questions without stored answer (explicit assisted mode)', async () => {
    const r = await answerQuestion({
      userId: null,
      user: { qaProfile: {}, profile: {}, preferences: { autoAnswerMode: 'assisted' } },
      question: 'Do you have a disability?',
      fieldType: 'radio',
      options: ['Yes', 'No'],
      job: '',
      resumeText: '',
      mode: 'assisted',
      aiProvider: fakeAI('{"answer":"No","confidence":"high"}')
    });
    assert.equal(r.answer, null);
    assert.equal(r.error, 'sensitive-no-stored-answer');
  });
  it('defaults to full-auto when no mode is set', async () => {
    const r = await answerQuestion({
      userId: null,
      user: { qaProfile: {}, profile: {} },
      question: 'Do you have a disability?',
      fieldType: 'radio',
      options: ['Yes', 'No'],
      job: '',
      resumeText: '',
      aiProvider: fakeAI('{"answer":"No","confidence":"high"}')
    });
    assert.equal(r.answer, 'No');
  });
});

describe('qa - full-auto mode', () => {
  it('closestOptionFallback picks overlapping option', () => {
    assert.equal(closestOptionFallback('I need sponsorship for work', ['Yes', 'No']), null);
    assert.equal(
      closestOptionFallback('Immediate joiner, 0 days notice', ['Immediate joiner', '30 days', '60 days']),
      'Immediate joiner'
    );
  });
  it('full-auto answers sensitive questions via llm instead of refusing', async () => {
    const r = await answerQuestion({
      userId: null,
      user: { qaProfile: {}, profile: {}, preferences: { autoAnswerMode: 'full-auto' } },
      question: 'Do you have a disability?',
      fieldType: 'radio',
      options: ['Yes', 'No'],
      job: '',
      resumeText: 'No disabilities declared',
      aiProvider: fakeAI('{"answer":"No","confidence":"high"}')
    });
    assert.equal(r.answer, 'No');
  });
  it('full-auto salvages option mismatch via fallback', async () => {
    const r = await answerQuestion({
      userId: null,
      user: { qaProfile: {}, profile: {} },
      question: 'Notice period?',
      fieldType: 'select',
      options: ['Immediate joiner', '30 days', '60 days'],
      job: '',
      resumeText: 'Serving notice, can join in 30 days',
      mode: 'full-auto',
      aiProvider: fakeAI('{"answer":"I can join in thirty days time","confidence":"medium"}')
    });
    assert.equal(r.answer, '30 days');
    assert.equal(r.source, 'llm-guess');
  });
  it('assisted mode still refuses the same mismatch', async () => {
    const r = await answerQuestion({
      userId: null,
      user: { qaProfile: {}, profile: {} },
      question: 'Notice period?',
      fieldType: 'select',
      options: ['Immediate joiner', '30 days', '60 days'],
      job: '',
      resumeText: '',
      aiProvider: fakeAI('{"answer":"sometime soon","confidence":"low"}')
    });
    assert.equal(r.answer, null);
  });
});

describe('alerts - job link extraction', () => {
  it('extracts LinkedIn job links', async () => {
    const { extractJobLinks } = await import('../src/services/alertIngest.js');
    const out = extractJobLinks('New job https://www.linkedin.com/comm/jobs/view/1234567890/?refId=abc and again https://www.linkedin.com/jobs/view/1234567890/');
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'linkedin');
    assert.equal(out[0].externalId, '1234567890');
  });
  it('extracts Naukri job links', async () => {
    const { extractJobLinks } = await import('../src/services/alertIngest.js');
    const out = extractJobLinks('Apply https://www.naukri.com/job-listings-react-developer-abc-12345678?src=test');
    assert.equal(out.length, 1);
    assert.equal(out[0].source, 'naukri');
  });
  it('ignores non-job links', async () => {
    const { extractJobLinks } = await import('../src/services/alertIngest.js');
    assert.equal(extractJobLinks('Hi, see https://example.com/page for details').length, 0);
  });
});

describe('agent.yaml - config', () => {
  it('loads agents and exposes safe listing without keys', async () => {
    const { loadAgentConfig, listAgents } = await import('../src/lib/agentConfig.js');
    const cfg = loadAgentConfig();
    assert.ok(cfg.active);
    assert.ok(Object.keys(cfg.agents).length >= 1);
    const listed = JSON.stringify(listAgents());
    assert.ok(!listed.includes('AIza') || process.env.GEMINI_API_KEY === '');
  });
  it('rejects unknown agent names with choices', async () => {
    const { resolveAgent } = await import('../src/lib/agentConfig.js');
    assert.throws(() => resolveAgent('no-such-agent'), /Choices:/);
  });
  it('factory accepts model override per provider', async () => {
    const { AIProviderFactory } = await import('../src/services/aiProviders.js');
    const g = AIProviderFactory.create('gemini', 'k', 'gemini-1.5-flash');
    assert.equal(g.model, 'gemini-1.5-flash');
    const o = AIProviderFactory.create('openrouter', 'k', 'x/y');
    assert.equal(o.model, 'x/y');
  });
});

describe('tokens + model errors', () => {
  it('sums per-step usage', async () => {
    const { sumUsage } = await import('../src/services/resumeService.js');
    const t = sumUsage([{ input: 100, output: 50, total: 150 }, { input: 200, output: 0, total: 200 }]);
    assert.deepEqual(t, { input: 300, output: 50, total: 350 });
  });
  it('explains overloaded/unknown models with agent.yaml hint', async () => {
    const { friendlyModelError } = await import('../src/services/aiProviders.js');
    const e503 = friendlyModelError(new Error('[503 Service Unavailable] high demand'), 'gemini-3.6-flash');
    assert.equal(e503.status, 502);
    assert.ok(/agent\.yaml/.test(e503.message));
    const e404 = friendlyModelError(new Error('model not found'), 'bad-model');
    assert.equal(e404.status, 502);
  });
});
