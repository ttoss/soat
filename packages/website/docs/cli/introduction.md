---
description: "The @soat/cli command-line interface for the SOAT REST API, with every operation auto-generated as a sub-command from the OpenAPI specs."
sidebar_position: 1
slug: /cli
---

# SOAT CLI

The `@soat/cli` package is a command-line interface for the SOAT REST API. Every API operation is available as a sub-command, auto-generated from the same OpenAPI specs.

## Installation

```bash
npm install -g @soat/cli
# or
pnpm add -g @soat/cli
```

## Authentication

Before making API calls you must configure a profile with your server URL and token:

```bash
soat configure
```

You will be prompted for:

| Prompt   | Description                                            |
| -------- | ------------------------------------------------------ |
| Base URL | URL of your SOAT server (e.g. `http://localhost:5047`) |
| Token    | JWT session token (from `login-user`) or `sk_`-prefixed API key (from `create-api-key`) |

To save under a named profile, pass `--profile`:

```bash
soat configure --profile prod
```

Profiles are stored in `~/.soat/config.json`.

## Global Options

| Option                 | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `-p, --profile <name>` | Use a named profile from `~/.soat/config.json` |
| `-V, --version`        | Print the CLI version                          |
| `-h, --help`           | Display help for any command                   |

## Environment Variables

Environment variables take precedence over stored profiles:

| Variable        | Description                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------- |
| `SOAT_BASE_URL` | Server base URL. When set together with `SOAT_TOKEN`, skips profile lookup entirely. When set alone, overrides the base URL of the resolved profile. |
| `SOAT_TOKEN`    | Bearer token — JWT session token or `sk_`-prefixed API key. Must be set together with `SOAT_BASE_URL` to skip profile lookup entirely. |
| `SOAT_PROFILE`  | Name of the profile to use when no `--profile` flag is passed.                                                   |

## Available Commands

| Command         | Description                                      |
| --------------- | ------------------------------------------------ |
| `configure`     | Add or update a profile in `~/.soat/config.json` |
| `list-commands` | Print all available API commands                 |
| _any operation_ | Call the corresponding REST API operation        |

See the [Commands Reference](./commands.md) for the complete list of API operations.
