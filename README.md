# SOAT (Source of Agentic Truth)

<p align="center">
  <img src="./packages/website/static/img/hero.jpg" alt="SOAT Banner" width="100%">
</p>

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![SafeSkill 92/100](https://img.shields.io/badge/SafeSkill-92%2F100_Verified%20Safe-brightgreen)](https://safeskill.dev/scan/ttoss-soat)

**SOAT** is an open-source framework designed to provide persistent memory capabilities for autonomous AI agents. It orchestrates the ingestion, storage, and retrieval of context using semantic search and vector embeddings.

## Why SOAT?

Sophisticated AI agents require a scalable substrate to maintain state and recall context. SOAT provides that infrastructure by treating memory as a semantic cosmos rather than a flat datastore.

- **Persistent Context**: Ingests and persists Documents and Files across agent lifecycles.
- **Semantic Recall**: Instant illumination of relevant context via high-dimensional vector similarity.
- **MCP Native**: First-class support for the [Model Context Protocol](https://modelcontextprotocol.io/), enabling seamless integration with agent runtimes.
- **Interoperable**: Standard REST API for universal application access.

## Core Resources

SOAT exposes two primary resources for constructing agentic memory:

### Documents

The fundamental unit of textual memory. Documents are ingested, atomized, and vectorized to enable granular semantic retrieval.

- **Ingestion**: Raw text processing with automatic embedding generation.
- **Indexing**: Optimized generic text storage for high-recall queries.

### Files

Management of binary assets and unstructured data blobs.

- **Storage**: Persistent handling of file objects.
- **Association**: Linking binary assets to semantic context.

## Featured Features

### Integration & Protocols

- **MCP Server**: Full Model Context Protocol implementation for direct LLM connection.
- **REST API**: Robust HTTP endpoints for system-to-system integration.
- **Vector Engine**: Powered by [pgvector](https://github.com/pgvector/pgvector) for efficient high-dimensional similarity search.

### Packages

| Package                           | Description                        |
| --------------------------------- | ---------------------------------- |
| [@soat/server](./packages/server) | Core memory server (MCP + REST).   |
| [@soat/cli](./packages/cli)       | Command-line management interface. |

## Documentation

**[Read the Full Documentation](https://soat.ttoss.dev)** – System architecture, API references, and deployment guides.

## Getting Started

The quickest way to get started is using Docker Compose.

1. **Clone the repository**

   ```bash
   git clone https://github.com/ttoss/soat.git
   cd soat
   ```

2. **Follow the [Getting Started Guide](https://soat.ttoss.dev/docs/getting-started)** to spin up the server and database using Docker Compose.

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
