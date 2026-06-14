/**
 * Server-rendered OAuth consent screen.
 *
 * Pure HTML rendering — no I/O — so it is trivially unit-testable. The screen
 * lets the user pick a project and choose permissions at three granularities:
 *
 * - "Grant all permissions" (a single toggle → `*`)
 * - per-module (an intermediary checkbox that selects every action of a
 *   module → `<module>:*`)
 * - per-action (granular checkboxes → `<module>:<Action>`)
 */
import type { CatalogModule } from '../lib/permissionCatalog';

export type ConsentScreenProject = {
  id: string;
  name: string;
};

export type ConsentScreenParams = {
  /** OAuth authorize parameters to carry through the form as hidden fields. */
  oauthParams: Record<string, string>;
  projects: ConsentScreenProject[];
  modules: CatalogModule[];
  /** Where the form posts the decision. */
  action: string;
  /** Optional error banner (e.g. bad credentials). */
  error?: string;
};

const escapeHtml = (value: string): string => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const renderHiddenFields = (params: Record<string, string>): string => {
  return Object.entries(params)
    .map(([key, value]) => {
      return `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}" />`;
    })
    .join('');
};

const renderModule = (module: CatalogModule): string => {
  const actions = module.actions
    .map((a) => {
      return `
      <label class="action">
        <input type="checkbox" name="action" value="${escapeHtml(a.action)}"
          data-module="${escapeHtml(module.module)}" class="action-cb" />
        <code>${escapeHtml(a.action)}</code>
        <span class="desc">${escapeHtml(a.description)}</span>
      </label>`;
    })
    .join('');

  return `
    <fieldset class="module" data-module="${escapeHtml(module.module)}">
      <legend>
        <label>
          <input type="checkbox" class="module-cb" data-module="${escapeHtml(module.module)}" />
          <strong>${escapeHtml(module.module)}</strong>
        </label>
      </legend>
      ${actions}
    </fieldset>`;
};

const CONSENT_STYLES = `
    body { font-family: system-ui, sans-serif; max-width: 720px; margin: 2rem auto; padding: 0 1rem; }
    fieldset.module { margin: 0.5rem 0; border: 1px solid #ddd; border-radius: 6px; }
    label.action { display: flex; gap: 0.5rem; align-items: baseline; padding: 0.15rem 0; }
    label.action .desc { color: #666; font-size: 0.85rem; }
    .error { color: #b00020; }
    .grant-all { margin: 1rem 0; padding: 0.75rem; background: #f5f5f5; border-radius: 6px; }
    button { padding: 0.5rem 1rem; font-size: 1rem; }`;

// Progressive enhancement: tri-state module checkboxes. The screen works
// without JS (tick individual actions or "grant all"); this just wires the
// intermediary "select whole module" convenience and the grant-all toggle.
const CONSENT_SCRIPT = `
    (function () {
      var grantAll = document.getElementById('grant-all');
      var permissions = document.getElementById('permissions');
      function setPermissionsDisabled(disabled) {
        permissions.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
          cb.disabled = disabled;
        });
      }
      if (grantAll) {
        grantAll.addEventListener('change', function () {
          setPermissionsDisabled(grantAll.checked);
        });
      }
      document.querySelectorAll('.module-cb').forEach(function (moduleCb) {
        var mod = moduleCb.getAttribute('data-module');
        var actions = document.querySelectorAll('.action-cb[data-module="' + mod + '"]');
        moduleCb.addEventListener('change', function () {
          actions.forEach(function (a) { a.checked = moduleCb.checked; });
        });
        actions.forEach(function (a) {
          a.addEventListener('change', function () {
            var all = Array.prototype.every.call(actions, function (x) { return x.checked; });
            var none = Array.prototype.every.call(actions, function (x) { return !x.checked; });
            moduleCb.checked = all;
            moduleCb.indeterminate = !all && !none;
          });
        });
      });
    })();`;

export const renderConsentScreen = (params: ConsentScreenParams): string => {
  const projectOptions = params.projects
    .map((p) => {
      return `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)} (${escapeHtml(p.id)})</option>`;
    })
    .join('');

  const modulesHtml = params.modules.map(renderModule).join('');
  const errorBanner = params.error
    ? `<p class="error" role="alert">${escapeHtml(params.error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize access — SOAT</title>
  <style>${CONSENT_STYLES}</style>
</head>
<body>
  <h1>Authorize MCP access</h1>
  <p>Choose a project and the permissions to grant.</p>
  ${errorBanner}
  <form method="post" action="${escapeHtml(params.action)}">
    ${renderHiddenFields(params.oauthParams)}

    <label>Project
      <select name="project_id" required>
        <option value="" disabled selected>Select a project…</option>
        ${projectOptions}
      </select>
    </label>

    <div class="grant-all">
      <label>
        <input type="checkbox" id="grant-all" name="grant_all" value="1" />
        <strong>Grant all permissions</strong> for the selected project
      </label>
    </div>

    <div id="permissions">
      ${modulesHtml}
    </div>

    <p><button type="submit">Authorize</button></p>
  </form>

  <script>${CONSENT_SCRIPT}</script>
</body>
</html>`;
};

/**
 * Translates a submitted consent form body into a {@link ConsentSelection}-shaped
 * object. `grant_all` wins; otherwise the posted `action` values become a
 * granular selection. (Whole-module ticks post their child actions, so they
 * arrive here as an action list — no separate module tier needed server-side.)
 */
export const parseConsentForm = (body: {
  grant_all?: unknown;
  action?: unknown;
}): { kind: 'all' } | { kind: 'actions'; actions: string[] } => {
  if (
    body.grant_all === '1' ||
    body.grant_all === 'on' ||
    body.grant_all === true
  ) {
    return { kind: 'all' };
  }
  const raw = body.action;
  const actions = Array.isArray(raw)
    ? raw.map(String)
    : typeof raw === 'string'
      ? [raw]
      : [];
  return { kind: 'actions', actions };
};
