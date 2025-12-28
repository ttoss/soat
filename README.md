# SOAT (Source of Agentic Truth)

<p align="center">
  <img src="./assets/banner.jpg" alt="SOAT Banner" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**SOAT** is an open-source framework designed to provide persistent memory capabilities for autonomous AI agents. It enables agents to store, retrieve, and manage information effectively using semantic search powered by vector embeddings.

## Why SOAT?

As AI agents become more sophisticated, they need a reliable way to maintain context and recall past interactions. SOAT addresses this challenge by providing:

- **Persistent Memory**: Agents can store information that persists across sessions
- **Semantic Recall**: Retrieve relevant memories using natural language queries, not just exact matches
- **MCP Integration**: Native support for [Model Context Protocol](https://modelcontextprotocol.io/), making it easy to integrate with AI assistants
- **Simple REST API**: Standard HTTP endpoints for easy integration with any application

## Features

### 🧠 Memory Management

- **Record Memory**: Store text content with automatically generated vector embeddings
- **Recall Memory**: Retrieve semantically similar memories using natural language queries
- **Vector Search**: Powered by [pgvector](https://github.com/pgvector/pgvector) for efficient similarity search

### 🔌 Multiple Integration Options

- **MCP Server**: Full Model Context Protocol support for AI assistant integration
- **REST API**: Simple HTTP endpoints for any application

### 📦 Monorepo Packages

| Package                                         | Description                               |
| ----------------------------------------------- | ----------------------------------------- |
| [@soat/server](./packages/server)               | Memory server with MCP and REST APIs      |
| [@soat/cli](./packages/cli)                     | Command-line interface (WIP)              |
| [@soat/text-atomizer](./packages/text-atomizer) | Text analysis and decomposition utilities |

## Getting Started

The quickest way to get started is to set up the SOAT server:

```bash
# Clone the repository
git clone https://github.com/ttoss/soat.git
cd soat

# Install dependencies
pnpm install
```

Then follow the detailed setup instructions in the [Server README](./packages/server/README.md).

## Architecture

```
┌─────────────────┐     ┌─────────────────┐
│   AI Agents     │     │  Applications   │
└────────┬────────┘     └────────┬────────┘
         │                       │
         │ MCP Protocol          │ REST API
         │                       │
         └───────────┬───────────┘
                     │
              ┌──────▼──────┐
              │ SOAT Server │
              └──────┬──────┘
                     │
         ┌───────────┴───────────┐
         │                       │
    ┌────▼────┐           ┌──────▼──────┐
    │ Ollama  │           │ PostgreSQL  │
    │(Embed)  │           │ + pgvector  │
    └─────────┘           └─────────────┘
```

## Contributing

We welcome contributions! Please feel free to submit issues and pull requests.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [ttoss](https://ttoss.dev) - For the HTTP server and MCP packages
- [pgvector](https://github.com/pgvector/pgvector) - PostgreSQL vector similarity search
- [Ollama](https://ollama.com) - Local LLM and embedding models
