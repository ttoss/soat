---
sidebar_position: 2
---

# Storing & Retrieving Memory

Once connected via MCP, your agent has access to specific tools to interact with the memory database.

## Available Tools

The SOAT Server exposes the following tools to the agent:

### `add_memory`

Stores a piece of text into the database. It automatically generates a vector embedding for semantic search later.

- **Input**: `text` (string), `metadata` (optional JSON)
- **Example**: "The user prefers TypeScript over JavaScript for all new projects."

### `search_memory`

Retrieves relevant memories based on a query. It compares the vector embedding of the query with stored memories.

- **Input**: `query` (string)
- **Example**: "What are the user's coding preferences?"
- **Output**: A list of matching text snippets with similarity scores.

## Example Workflow

Here is how an interaction might look between you and an agent using SOAT:

1.  **User**: "My API key for the weather service is `12345`. Remember that."
2.  **Agent**: _Calls `add_memory` with text "Weather service API key is 12345"._
3.  **Agent**: "I have stored that API key in your memory."

... _Days later_ ...

1.  **User**: "I need to check the weather, what credential should I use?"
2.  **Agent**: _Calls `search_memory` with "weather credential API key"._
3.  **Soat Server**: _Returns the memory stored earlier._
4.  **Agent**: "You should use the API key `12345`."

## Best Practices

- **Be Specific**: Agents perform best when memories are atomic and self-contained.
- **Use Context**: When asking the agent to remember something, explicitly say "save this to memory".
