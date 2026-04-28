---
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

| Prompt       | Description                                            |
| ------------ | ------------------------------------------------------ |
| Profile name | Name for this profile (`default` if left blank)        |
| Base URL     | URL of your SOAT server (e.g. `http://localhost:5047`) |
| Token        | JWT session token or `sk_`-prefixed project key        |

Profiles are stored in `~/.soat/config.json`.

## Global Options

| Option                 | Description                                    |
| ---------------------- | ---------------------------------------------- |
| `-p, --profile <name>` | Use a named profile from `~/.soat/config.json` |
| `-V, --version`        | Print the CLI version                          |
| `-h, --help`           | Display help for any command                   |

## Environment Variables

Environment variables take precedence over stored profiles:

| Variable        | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `SOAT_BASE_URL` | Server base URL — skips profile lookup entirely               |
| `SOAT_TOKEN`    | Bearer token — skips profile lookup entirely                  |
| `SOAT_PROFILE`  | Name of the profile to use when no `--profile` flag is passed |

## Available Commands

| Command         | Description                                      |
| --------------- | ------------------------------------------------ |
| `configure`     | Add or update a profile in `~/.soat/config.json` |
| `list-commands` | Print all available API commands                 |
| _any operation_ | Call the corresponding REST API operation        |

See the [Commands Reference](./commands.md) for the complete list of API operations.
