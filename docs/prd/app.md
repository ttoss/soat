# PRD — SOAT App (`@soat/app`)

| | |
|---|---|
| **Status** | Draft |
| **Package** | `packages/app` |
| **Served at** | `/app` (by `@soat/server`) |
| **Stack** | React + Vite + TypeScript + Tailwind CSS + shadcn/ui |
| **Author** | Pedro Arantes |
| **Last updated** | 2026-06-13 |

## 1. Overview

The SOAT App is a single-page web application that gives users a visual interface to the entire SOAT API. Instead of hand-building a page per module, the app contains a **generic rendering engine driven by the server's OpenAPI specs**: every module (projects, traces, agents, policies, …) is rendered from its spec — lists for `GET` collections, detail views for `GET` items, forms for `POST`/`PUT`, confirmations for `DELETE`. New server modules appear in the app with zero frontend work.

A persistent right-hand sidebar hosts an **AI guide chat**. The user picks an AI provider, and a guide agent (powered by the existing agents/conversations infrastructure) drives the UI: when the user says "I want to see the list of traces", the agent instructs the app — via a `client` tool — to mount the traces list view.

## 2. Goals

1. Authenticated users can browse and manage every SOAT resource they have permission for, through a single SPA.
2. The UI surface is **derived from the OpenAPI specs at runtime** — adding a module to the server requires no app changes.
3. Full CRUD: list, detail, create, update, delete for all enabled operations.
4. An AI guide chat can navigate the app and mount views on the user's behalf.
5. The app is built once and served by `@soat/server` from `/app` — no separate deployment.

## 3. Non-Goals (v1)

- No client-side routing / deep links. The app is a true SPA with a single URL (`/app`); the current view lives in client state only.
- No realtime updates (websockets/SSE) — views refresh on demand.
- No mobile-optimized layout (desktop-first; usable on tablet).
- No theming/whitelabel.
- No offline support.
- The chat does not stream tokens in v1 (uses the existing non-streaming generate flow).

## 4. Users

| Persona | Needs |
|---|---|
| **Project member** | Log in, see the projects they belong to, browse/manage resources inside those projects (agents, conversations, traces, files, secrets, …) within their permissions. |
| **Admin** | Everything above, plus global administration: users, **policies**, AI providers. |

## 5. Architecture

### 5.1 Package layout

New workspace package `packages/app`:

```
packages/app/
  index.html
  vite.config.ts
  tailwind.config.ts
  src/
    main.tsx
    app.tsx
    api/            # SDK client setup, OpenAPI spec loading
    auth/           # login form, token storage, session context
    engine/         # generic OpenAPI → UI rendering engine
    chat/           # AI guide sidebar
    components/     # shadcn/ui copy-in components
    views/          # shell views (project list, module workspace)
  PRD note: business logic stays out of components where possible;
  follow repo naming conventions (camelCase files, kebab-case folders).
```

- Uses `@soat/sdk` (`createClient` / `SoatClient`) for all API calls — no hand-rolled `fetch` against `/api/v1`.
- shadcn/ui components are copied into `src/components` (Radix-based); Tailwind is the only styling layer.
- Vite build outputs to `packages/app/dist` with `base: '/app/'`.

### 5.2 Serving from the server

`@soat/server` gains static serving for the SPA:

- `GET /app` and `GET /app/*` serve `packages/app/dist` (static assets + `index.html` fallback for any non-asset path under `/app`).
- The server build/Docker image copies `packages/app/dist` into the server artifact. The Dockerfile builds the app workspace before the server.
- Static serving is mounted **after** the REST router and MCP middleware so API routes always win.
- Serving the app must not require authentication (the login screen is part of the SPA); all data access remains protected by the existing `authMiddleware` on `/api/v1`.

### 5.3 OpenAPI spec exposure (new server endpoint)

The rendering engine needs the specs at runtime. Today they are only read server-side (`src/lib/soatTools.ts`). Add:

- `GET /api/v1/openapi.json` — returns the merged OpenAPI document for all modules under `src/rest/openapi/v1/*.yaml`, reusing the same loader as `soatTools.ts`. Authenticated (any logged-in user). Response is cacheable per server version (`ETag`).

This endpoint is the **single source of truth** for the app's UI surface, the same way it already is for the SDK, CLI manifest, and MCP tools.

## 6. Authentication & Session

- **Login screen**: username + password → `POST /api/v1/users/login`. On success the JWT is stored in `localStorage` and attached as `Authorization: Bearer <token>` to every SDK call.
- On startup, the app validates a stored token by calling `GET /api/v1/users/me`; invalid/expired tokens drop the user back to the login screen.
- **Logout** clears `localStorage` and resets all client state (including chat).
- Any API call returning `401` triggers a global logout.
- No registration in the app — users are provisioned by admins (existing flows).

## 7. App Shell & Navigation

Because there are no routes, the shell is a state machine:

```
unauthenticated → login screen
authenticated   → workspace
```

The workspace layout:

```
┌────────────┬──────────────────────────────┬──────────────┐
│  Left nav  │        Main view             │  Chat        │
│            │                              │  sidebar     │
│  Projects  │  (engine-rendered view)      │  (AI guide)  │
│  Modules   │                              │              │
│  Policies* │                              │              │
└────────────┴──────────────────────────────┴──────────────┘
            * admin only
```

- **Left nav** lists: the user's projects (from `GET /api/v1/projects` — the API already scopes results to projects the user can access), the modules available inside the selected project, and global/admin sections. **Policies** appears only for admins (detected via `GET /api/v1/users/me` role); non-admins never see the entry, and a `403` from the API renders a permission-denied state as a fallback.
- **Project context**: most modules are project-scoped. Selecting a project sets the active context; the engine injects the project ID into operations that require it (path param or `project_id` field).
- **Main view** renders exactly one engine view at a time, described by a serializable `ViewDescriptor` (see §8.3). The current descriptor *is* the navigation state — which is what allows the chat agent to drive navigation.

## 8. Generic Rendering Engine

### 8.1 Principle

The engine consumes the merged OpenAPI document and derives, per module (one per spec file / tag):

| Operation shape | View |
|---|---|
| `GET` collection (returns array) | **List view** — data table with columns derived from the response item schema; row click opens the detail view; toolbar with Create button (if a `POST` exists) and refresh |
| `GET` item (`/{id}`) | **Detail view** — field/value layout from the response schema; actions: Edit (if `PUT`/`PATCH` exists), Delete (if `DELETE` exists) |
| `POST` | **Create form** — fields generated from the request body schema |
| `PUT` / `PATCH` | **Edit form** — same generator, pre-filled from the current item |
| `DELETE` | **Confirm dialog** → calls the operation |
| Action endpoints (e.g. `POST /agents/{id}/generate`) | **Action form** — rendered like a create form on the resource detail view, response shown as a result panel |

All modules get the same component structure; only the schema-driven content differs.

### 8.2 Schema → UI mapping

Form/field generation rules (request body and response schemas):

| Schema | Control / rendering |
|---|---|
| `string` | text input; `enum` → select; `format: date-time` → formatted timestamp (read) / datetime input (write); long descriptions or `text`-ish fields → textarea |
| `number` / `integer` | number input |
| `boolean` | switch |
| `array` / `object` | JSON editor (textarea with validation) in v1; key/value display in read views |
| `required` | enforced client-side before submit |
| field names | API contract is **snake_case** (per the case-convention rule); the engine displays humanized labels ("project_id" → "Project ID") and sends snake_case bodies via the SDK |

Validation errors from the server (`DomainError` shape: `{ error: { code, message, meta? } }`) are rendered inline on the form; `403` renders a permission-denied state; `404` renders a not-found state.

### 8.3 ViewDescriptor

The unit of navigation. Serializable so both the UI (clicks) and the chat agent (tool calls) can produce it:

```ts
type ViewDescriptor = {
  module: string;            // e.g. 'traces'
  operationId: string;       // from the OpenAPI spec
  pathParams?: Record<string, string>;
  queryParams?: Record<string, string>;
  mode: 'list' | 'detail' | 'create' | 'edit' | 'action';
};
```

The engine validates a descriptor against the spec (unknown `operationId` or missing required params → error state, never a crash) before fetching data with the user's token and rendering.

## 9. AI Guide Chat

### 9.1 UX

- Right sidebar, collapsible, persistent across view changes.
- First use: the user picks an **AI provider** from `GET /api/v1/ai-providers` (scoped to the active project). The choice is remembered (`localStorage`) per project.
- Chat shows the conversation history for the current session; messages where the agent mounted a view include an inline "Showing: Traces list" affordance that re-mounts that view on click.

### 9.2 Backend wiring (reuses existing modules — no new chat endpoint)

1. **Guide agent provisioning**: when a provider is selected, the app find-or-creates an agent named `soat-app-guide` in the active project, bound to that provider, with a fixed system prompt (the guide persona + instructions about the `render_page` tool) and a single **`client` tool**:

   ```jsonc
   {
     "name": "render_page",
     "type": "client",
     "description": "Mount a view in the SOAT App UI",
     "inputSchema": {
       // camelCase per soat-tools/MCP convention for tool schemas
       "module": "string",
       "operationId": "string",
       "pathParams": "object?",
       "queryParams": "object?",
       "mode": "list | detail | create | edit | action"
     }
   }
   ```

   Find-or-create is idempotent: if the agent exists, the app updates the provider binding when it differs. Users without agent-create permission in the project get a clear message that the guide is unavailable for them until an admin creates it.

2. **Conversation loop** (existing generate flow):
   - The app creates a conversation (or agent session) and posts the user's message.
   - Generation runs server-side with the selected provider.
   - When the agent calls `render_page`, the API returns `status: "requires_action"` with the tool call. The **frontend** executes it: validates the `ViewDescriptor`, fetches data **with the user's own token** (permissions stay user-scoped — the agent never gets credentials), mounts the view, and submits a tool output summarizing the result (e.g. `{ "ok": true, "items": 42 }` or the error) to the tool-outputs endpoint.
   - Generation resumes and the agent answers in the chat ("Here are your 42 traces…").
   - Plain conversational turns (no tool call) complete with `status: "completed"` and are rendered as chat messages.

3. **Spec awareness**: the guide's system prompt includes a compact index of available modules/operations (derived client-side from `/api/v1/openapi.json`) so the model knows what it can render. The full spec is not sent on every turn.

### 9.3 Failure handling

- Tool call references an unknown operation → the app submits an error tool output; the agent self-corrects.
- Data fetch fails (`403`/`404`) → the error is shown in the main view *and* returned as the tool output so the agent can explain it.
- Generation polling follows the existing pattern: poll the generation status with a bounded timeout; surface `in_progress` as a typing indicator.

## 10. Server Changes Required

All server changes follow the standard module checklist (lib → REST → OpenAPI → SDK/CLI regen → docs → tests → smoke test):

| Change | Notes |
|---|---|
| Serve SPA at `/app` | Static middleware + `index.html` fallback; mounted after API routes; covered by a unit test (200 + HTML content type) |
| `GET /api/v1/openapi.json` | New endpoint reusing the `soatTools` spec loader; authenticated; OpenAPI-spec'd itself; SDK/CLI regenerated |
| Docker image | Build `packages/app` and copy `dist` into the server image |

No changes to agents, conversations, tools, or policies modules — the chat reuses them as-is.

## 11. Permissions

The app adds **no permission model of its own**. Every operation goes through `/api/v1` with the user's token, so existing IAM/policies are the only enforcement layer. The frontend only does *progressive disclosure*: it hides admin sections from non-admins and renders friendly `403` states — never as a substitute for server-side checks.

## 12. Delivery Plan

| Phase | Scope | Exit criterion |
|---|---|---|
| **1 — Foundation** | `packages/app` scaffold (Vite/React/Tailwind/shadcn), server static serving at `/app`, `GET /api/v1/openapi.json`, login/logout/session | Log in at `/app`, see authenticated shell; server tests green |
| **2 — Engine (read)** | Spec parsing, ViewDescriptor, list + detail views for all modules, project context, admin-only policies nav | Browse every module's data read-only |
| **3 — Engine (write)** | Schema-driven create/edit forms, delete confirmation, action endpoints, DomainError rendering | Full CRUD on projects, agents, secrets via the UI |
| **4 — AI guide** | Provider picker, guide-agent provisioning, chat loop with `render_page` client tool, requires_action handling | "Show me the traces" mounts the traces list end-to-end |
| **5 — Hardening** | Smoke-test steps for the `/app` flow (server-side checks via CLI per the CLI-first rule; SPA availability via a static `200` check), empty/error/loading states, docs page for the app | `pnpm run -w smoke-tests` green incl. new steps |

## 13. Success Criteria

- A user can complete a full resource lifecycle (create → list → inspect → edit → delete) for any module without leaving `/app`.
- A new server module (new `*.yaml` spec) shows up in the app with **zero** frontend changes.
- The guide chat can mount at least list and detail views for every module via natural language.
- Admin-only surfaces (policies) are invisible to non-admins and return clean `403` states if forced.

## 14. Open Questions

1. **Token TTL / refresh** — current JWTs have a fixed expiry and no refresh endpoint; v1 accepts re-login on expiry. Add a refresh flow later?
2. **Large collections** — do the list endpoints support pagination params consistently? If not, the engine caps rendering and we add pagination server-side in a follow-up.
3. **Secrets display** — secret values must never render; confirm the API already omits values on reads (engine will additionally mask any field named like `*secret*`/`*key*`).
4. **Multi-conversation chat history** — v1 keeps one guide conversation per project per user; revisit if users want named chat sessions.
