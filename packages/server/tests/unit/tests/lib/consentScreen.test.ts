import {
  parseConsentForm,
  renderConsentScreen,
} from '../../../../src/oauth/consentScreen';

describe('consentScreen', () => {
  describe('renderConsentScreen', () => {
    const base = {
      oauthParams: { client_id: 'c1', state: 'xyz' },
      action: '/oauth/consent',
      projects: [{ id: 'prj_1', name: 'Acme' }],
      modules: [
        {
          module: 'agents',
          actions: [
            { action: 'agents:CreateAgent', description: 'Create an agent' },
            { action: 'agents:ListAgents', description: 'List agents' },
          ],
        },
      ],
    };

    test('renders project options and the granular actions', () => {
      const html = renderConsentScreen(base);
      expect(html).toContain('<option value="prj_1">Acme (prj_1)</option>');
      expect(html).toContain('value="agents:CreateAgent"');
      expect(html).toContain('value="agents:ListAgents"');
    });

    test('renders the intermediary per-module checkbox and grant-all toggle', () => {
      const html = renderConsentScreen(base);
      expect(html).toContain('class="module-cb" data-module="agents"');
      expect(html).toContain('id="grant-all"');
    });

    test('carries oauth params as hidden fields', () => {
      const html = renderConsentScreen(base);
      expect(html).toContain('name="client_id" value="c1"');
      expect(html).toContain('name="state" value="xyz"');
    });

    test('escapes untrusted values to prevent HTML injection', () => {
      const html = renderConsentScreen({
        ...base,
        oauthParams: { state: '"><script>alert(1)</script>' },
      });
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    test('shows an error banner when provided', () => {
      const html = renderConsentScreen({
        ...base,
        error: 'Invalid credentials',
      });
      expect(html).toContain('Invalid credentials');
      expect(html).toContain('role="alert"');
    });
  });

  describe('parseConsentForm', () => {
    test('grant_all wins', () => {
      expect(
        parseConsentForm({ grant_all: '1', action: ['agents:GetAgent'] })
      ).toEqual({ kind: 'all' });
    });

    test('single action posts as a string', () => {
      expect(parseConsentForm({ action: 'agents:GetAgent' })).toEqual({
        kind: 'actions',
        actions: ['agents:GetAgent'],
      });
    });

    test('multiple actions post as an array', () => {
      expect(
        parseConsentForm({ action: ['agents:GetAgent', 'files:GetFile'] })
      ).toEqual({
        kind: 'actions',
        actions: ['agents:GetAgent', 'files:GetFile'],
      });
    });

    test('no selection yields an empty action list', () => {
      expect(parseConsentForm({})).toEqual({ kind: 'actions', actions: [] });
    });
  });
});
