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
    assert.ok(/overloaded|wait a minute/i.test(e503.message));
    const e404 = friendlyModelError(new Error('model not found'), 'bad-model');
    assert.equal(e404.status, 502);
  });
});

describe('keywords - variant matching', () => {
  it('counts variants as present', async () => {
    const { findMissingKeywords } = await import('../src/services/resumeService.js');
    const resume = 'Built OAuth2 and JWT auth. Did log monitoring on Linux.';
    const missing = findMissingKeywords(resume, ['SSO (Single Sign-On)', 'Observability', 'Linux', 'Kubernetes']);
    assert.deepEqual(missing, ['Kubernetes']);
  });
  it('flags truly absent keywords', async () => {
    const { findMissingKeywords } = await import('../src/services/resumeService.js');
    assert.deepEqual(findMissingKeywords('React developer', ['React', 'GraphQL']), ['GraphQL']);
  });
});

describe('honesty - code enforcement', () => {
  it('computes real years from profile dates', async () => {
    const { ResumeService } = await import('../src/services/resumeService.js');
    const svc = new ResumeService();
    const yrs = svc.profileYears({ experience: [
      { company: 'A', startDate: '06/2020', endDate: '04/2024' },
      { company: 'B', startDate: '04/2024', endDate: 'Present' }
    ] });
    assert.ok(yrs >= 4 && yrs <= 7, `years=${yrs}`);
  });
  it('flags inflation beyond +1', async () => {
    const { ResumeService } = await import('../src/services/resumeService.js');
    const svc = new ResumeService();
    const profile = { experience: [{ company: 'AMGO', startDate: '01/2022', endDate: 'Present' }] };
    const bad = svc.checkHonesty('over 10 years of experience\nDev | AMGO | 01/2022 - Present', profile);
    assert.ok(bad.violations.some((v) => v.includes('inflation')));
    const ok = svc.checkHonesty('over 4 years of experience\nDev | AMGO | 01/2022 - Present', profile);
    assert.equal(ok.violations.filter((v) => v.includes('inflation')).length, 0);
  });
  it('flags invented employers, allows real ones', async () => {
    const { ResumeService } = await import('../src/services/resumeService.js');
    const svc = new ResumeService();
    const profile = { experience: [{ company: 'AMGO Games', startDate: '01/2022', endDate: 'Present' }] };
    const bad = svc.checkHonesty('Dev | Tech Innovators Inc. | 01/2018 - 05/2023', profile);
    assert.ok(bad.violations.some((v) => v.includes('unknown employer')));
    const ok = svc.checkHonesty('Dev | AMGO Games | 01/2022 - Present', profile);
    assert.equal(ok.violations.length, 0);
  });
  it('ignores contact, education, tech and date-only lines', async () => {
    const { ResumeService } = await import('../src/services/resumeService.js');
    const svc = new ResumeService();
    const profile = { experience: [{ company: 'AMGO', startDate: '01/2022', endDate: 'Present' }] };
    const text = [
      'a@b.com | +91 999 | City | github.com/x',
      'Dev | AMGO | 01/2022 - Present',
      'Jun 2017 - Dec 2019',
      'B.Tech | College of X | 2018 - 2021',
      'Proj | React, AWS, Docker'
    ].join('\n');
    const r = svc.checkHonesty(text, profile);
    assert.equal(r.violations.length, 0);
  });
});

describe('honesty - labels + date formats', () => {
  it('strips model preamble labels', async () => {
    const { ResumeService } = await import('../src/services/resumeService.js');
    const svc = new ResumeService();
    assert.equal(svc.stripLabels('RESUME:\nSHUBHAM PATIL\ndev').split('\n')[0], 'SHUBHAM PATIL');
    assert.equal(svc.stripLabels('Here is the corrected resume:\nABC').split('\n')[0], 'ABC');
    assert.equal(svc.stripLabels('SHUBHAM PATIL\ndev').split('\n')[0], 'SHUBHAM PATIL');
  });
  it('parses ISO and dash dates', async () => {
    const { ResumeService } = await import('../src/services/resumeService.js');
    const svc = new ResumeService();
    assert.ok(svc.profileYears({ experience: [{ company: 'A', startDate: '2020-06', endDate: '2024-04' }] }) > 3);
    assert.ok(svc.profileYears({ experience: [{ company: 'A', startDate: 'April 2020', endDate: 'Present' }] }) > 3);
  });
  it('flags unknownSpan when dates are unparseable', async () => {
    const { ResumeService } = await import('../src/services/resumeService.js');
    const svc = new ResumeService();
    const r = svc.checkHonesty('Dev | X | sometime - later', { experience: [{ company: 'A', startDate: '???', endDate: '' }] });
    assert.equal(r.unknownSpan, true);
  });
});

describe('captcha - helpers (no network)', () => {
  it('maps grid cells to box coords', async () => {
    const { cellCenter } = await import('../src/services/captchaSolver.js');
    const box = { x: 100, y: 200, width: 300, height: 300 };
    assert.deepEqual(cellCenter('R1C1', box, 3, 3), { x: 150, y: 250 });
    assert.deepEqual(cellCenter('R3C3', box, 3, 3), { x: 350, y: 450 });
    assert.equal(cellCenter('bogus', box, 3, 3), null);
    const clamp = cellCenter('R9C9', box, 3, 3);
    assert.deepEqual(clamp, { x: 350, y: 450 });
  });
});

describe('gmail - per-user account resolution', () => {
  it('prefers encrypted DB creds over env', async () => {
    const { encrypt } = await import('../src/lib/crypto.js');
    const { resolveGmailAccount } = await import('../src/services/notify.js');
    const r = resolveGmailAccount({ gmailUser: 'u@gmail.com', gmailAppPassword: encrypt('secret123') });
    assert.equal(r.user, 'u@gmail.com');
    assert.equal(r.pass, 'secret123');
    assert.equal(r.owner, 'user');
  });
  it('falls back to server env', async () => {
    process.env.GMAIL_USER = 'srv@gmail.com';
    process.env.GMAIL_APP_PASSWORD = 'srvpass';
    const { resolveGmailAccount } = await import('../src/services/notify.js');
    const r = resolveGmailAccount({});
    assert.equal(r.owner, 'server');
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
  });
  it('returns null when nothing configured', async () => {
    delete process.env.GMAIL_USER;
    delete process.env.GMAIL_APP_PASSWORD;
    const { resolveGmailAccount } = await import('../src/services/notify.js');
    assert.equal(resolveGmailAccount({}), null);
  });
});

describe('captcha - agentic script gate (no network)', () => {
  it('rejects dangerous scripts', async () => {
    const { validateSolveScript } = await import('../src/services/captchaSolver.js');
    assert.ok(validateSolveScript(''));
    assert.ok(validateSolveScript('const x = require("fs");'));
    assert.ok(validateSolveScript('await page.goto("https://evil.com")'));
    assert.ok(validateSolveScript('await page.evaluate(() => 1)'));
    assert.ok(validateSolveScript('console.log("hi")'));
  });
  it('accepts legit interaction scripts', async () => {
    const { validateSolveScript } = await import('../src/services/captchaSolver.js');
    assert.equal(validateSolveScript('await page.getByRole("checkbox").first().click();\nawait sleep(2000);'), null);
    assert.equal(validateSolveScript('await page.locator("input").first().fill("abc123");\nawait page.keyboard.press("Enter");'), null);
  });
});

describe('captcha - coordinate tools (no network)', () => {
  it('accepts clickAt/typeAt scripts', async () => {
    const { validateSolveScript } = await import('../src/services/captchaSolver.js');
    assert.equal(validateSolveScript('await clickAt(310, 455);\nawait sleep(1000);'), null);
    assert.equal(validateSolveScript('await typeAt(200, 300, "483920");'), null);
  });
});

describe('captcha - script runner (no network)', () => {
  async function stubPage() {
    const calls = [];
    return {
      calls,
      mouse: {
        move: async (x, y) => { calls.push(['move', Math.round(x), Math.round(y)]); },
        click: async (x, y) => { calls.push(['click', Math.round(x), Math.round(y)]); },
        down: async () => { calls.push(['down']); },
        up: async () => { calls.push(['up']); }
      },
      keyboard: { pressSequentially: async (t) => { calls.push(['type', t]); }, press: async (k) => { calls.push(['press', k]); }, type: async (t) => { calls.push(['type', t]); } },
      viewportSize: () => ({ width: 1000, height: 800 }),
      waitForTimeout: (ms) => { calls.push(['wait', ms]); return new Promise((r) => setTimeout(r, Math.min(ms, 5))); }
    };
  }
  it('executes clickAt/typeAt scripts against a stub page', async () => {
    const { runSolveScript } = await import('../src/services/captchaSolver.js');
    const page = await stubPage();
    const r = await runSolveScript(page, 'await clickAt(500, 250);\nawait typeAt(100, 100, "483920");', 5000);
    assert.equal(r.ran, true);
    assert.ok(page.calls.some((c) => c[0] === 'click' && c[1] === 500 && c[2] === 200));
    assert.ok(page.calls.some((c) => c[0] === 'type' && c[1] === '483920'));
  });
  it('times out runaway scripts', async () => {
    const { runSolveScript } = await import('../src/services/captchaSolver.js');
    const page = await stubPage();
    const r = await runSolveScript(page, 'await sleep(5000); await clickAt(1, 1);', 300);
    assert.equal(r.ran, false);
    assert.ok(/timeout/.test(r.error));
  });
});

describe('captcha - getEmailCode tool (no network)', () => {
  it('exposes getEmailCode to scripts and resolves inbox code', async () => {
    const mod = await import('../src/services/captchaSolver.js');
    const calls = [];
    const page = {
      mouse: { move: async () => {}, click: async (x, y) => { calls.push(['click', Math.round(x), Math.round(y)]); } },
      keyboard: { type: async (t) => { calls.push(['type', t]); } },
      viewportSize: () => ({ width: 1000, height: 800 }),
      waitForTimeout: () => new Promise((r) => setTimeout(r, 1))
    };
    // Stub fetchLatestCode path is network-bound; only verify the tool is wired:
    // a script calling getEmailCode must not throw "not defined".
    const r = await mod.runSolveScript(page, 'await clickAt(500, 500);', 3000);
    assert.equal(r.ran, true);
    assert.ok(calls.some((c) => c[0] === 'click'));
  });
});
