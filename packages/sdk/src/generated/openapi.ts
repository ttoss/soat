// THIS FILE IS AUTO-GENERATED. DO NOT EDIT MANUALLY.
// Run `pnpm generate` to regenerate.

export interface paths {
    "/actors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List actors
         * @description Returns all actors the caller has access to. If projectId is provided, returns only actors in that project. project keys are scoped to a single project automatically. JWT users without projectId receive actors across all their accessible projects.
         */
        get: operations["listActors"];
        put?: never;
        /**
         * Create an actor
         * @description Creates a new actor. project keys automatically infer the project from the key's scope; JWT callers must supply projectId.
         */
        post: operations["createActor"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/actors/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an actor by ID
         * @description Returns an actor by its ID
         */
        get: operations["getActor"];
        put?: never;
        post?: never;
        /**
         * Delete an actor
         * @description Deletes an actor by its ID
         */
        delete: operations["deleteActor"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/tools": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agent tools
         * @description Returns all agent tools in the project.
         */
        get: operations["listAgentTools"];
        put?: never;
        /**
         * Create an agent tool
         * @description Creates a new agent tool in the project.
         */
        post: operations["createAgentTool"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/tools/{toolId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an agent tool
         * @description Returns a single agent tool by ID.
         */
        get: operations["getAgentTool"];
        /**
         * Update an agent tool
         * @description Updates an existing agent tool.
         */
        put: operations["updateAgentTool"];
        post?: never;
        /**
         * Delete an agent tool
         * @description Deletes an agent tool by ID.
         */
        delete: operations["deleteAgentTool"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/traces": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agent traces
         * @description Returns all traces for the project.
         */
        get: operations["listAgentTraces"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/traces/{traceId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a trace
         * @description Returns a single trace by ID.
         */
        get: operations["getAgentTrace"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List agents
         * @description Returns all agents in the project.
         */
        get: operations["listAgents"];
        put?: never;
        /**
         * Create an agent
         * @description Creates a new agent bound to an AI provider.
         */
        post: operations["createAgent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get an agent
         * @description Returns a single agent by ID.
         */
        get: operations["getAgent"];
        /**
         * Update an agent
         * @description Updates an existing agent.
         */
        put: operations["updateAgent"];
        post?: never;
        /**
         * Delete an agent
         * @description Deletes an agent by ID.
         */
        delete: operations["deleteAgent"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Run an agent generation
         * @description Sends messages to the agent, resolves its tools, and runs the AI model loop. Supports streaming via `stream: true`. Client tools pause the generation and return `requires_action`.
         */
        post: operations["createAgentGeneration"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/agents/{agentId}/generate/{generationId}/tool-outputs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Submit tool outputs for a paused generation
         * @description Resumes a generation that was paused due to client tool calls. Provide tool outputs for each pending tool call.
         */
        post: operations["submitAgentToolOutputs"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List chats
         * @description Returns all chats in the project.
         */
        get: operations["listChats"];
        put?: never;
        /**
         * Create a chat
         * @description Creates a new chat resource bound to an AI provider.
         */
        post: operations["createChat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chats/{chatId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a chat
         * @description Returns a single chat by ID.
         */
        get: operations["getChat"];
        put?: never;
        post?: never;
        /**
         * Delete a chat
         * @description Deletes a chat by ID.
         */
        delete: operations["deleteChat"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chats/{chatId}/completions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a chat completion for a stored chat
         * @description Runs a completion using the AI provider and settings stored in the chat. Pass `stream: true` for SSE streaming. A system message in `messages` overrides the chat's stored system message for this call only. Messages may use `documentId` instead of `content`.
         */
        post: operations["createChatCompletionForChat"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/chats/completions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a chat completion (stateless)
         * @description OpenAI Chat Completions-compatible endpoint. Resolves the AI provider from `aiProviderId`, decrypts its secret, and calls the appropriate Vercel AI SDK provider. Falls back to Ollama when `aiProviderId` is omitted.
         */
        post: operations["createChatCompletion"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversations
         * @description Returns all conversations the caller has access to. If projectId is provided, returns only conversations in that project. project keys are scoped to a single project automatically.
         */
        get: operations["listConversations"];
        put?: never;
        /**
         * Create a conversation
         * @description Creates a new conversation. project keys automatically infer the project from the key's scope; JWT callers must supply projectId.
         */
        post: operations["createConversation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a conversation by ID
         * @description Returns a conversation by its ID
         */
        get: operations["getConversation"];
        put?: never;
        post?: never;
        /**
         * Delete a conversation
         * @description Deletes a conversation by its ID
         */
        delete: operations["deleteConversation"];
        options?: never;
        head?: never;
        /**
         * Update a conversation
         * @description Updates the status of a conversation
         */
        patch: operations["updateConversation"];
        trace?: never;
    };
    "/conversations/{id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List conversation messages
         * @description Returns all messages (documents) attached to a conversation, ordered by position
         */
        get: operations["listConversationMessages"];
        put?: never;
        /**
         * Add a message to a conversation
         * @description Creates a document from the message text and attaches it to the conversation at the given position. If position is omitted, it is appended at the end.
         */
        post: operations["addConversationMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/generate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Generate the next message in a conversation
         * @description Generates the next message using the specified actor's linked agent or chat.
         *     On `completed`, the reply is persisted as a new ConversationMessage authored
         *     by that actor. On `requires_action`, nothing is persisted; the caller must
         *     submit tool outputs via the Agents module and re-invoke generate.
         */
        post: operations["generateConversationMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/actors": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List actors in a conversation
         * @description Returns all distinct actors who have sent at least one message in the conversation
         */
        get: operations["listConversationActors"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/conversations/{id}/messages/{documentId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a message from a conversation
         * @description Removes a document from a conversation
         */
        delete: operations["removeConversationMessage"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/documents": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List documents
         * @description Returns all documents the caller has access to. If projectId is provided, returns only documents in that project. project keys are scoped to a single project automatically. JWT users without projectId receive documents across all their accessible projects.
         */
        get: operations["listDocuments"];
        put?: never;
        /**
         * Create a document
         * @description Creates a new text document and generates an embedding vector for semantic search. project keys automatically infer the project from the key's scope; JWT callers must supply projectId.
         */
        post: operations["createDocument"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/documents/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a document by ID
         * @description Returns a document with its text content
         */
        get: operations["getDocument"];
        put?: never;
        post?: never;
        /**
         * Delete a document
         * @description Deletes a document and its underlying file
         */
        delete: operations["deleteDocument"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/documents/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Semantic search over documents
         * @description Embeds the query text and returns the most similar documents using cosine distance. If projectId is omitted, searches across all projects the caller has access to.
         */
        post: operations["searchDocuments"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List all files
         * @description Returns a list of all stored files
         */
        get: operations["listFiles"];
        put?: never;
        /**
         * Create a file
         * @description Creates a new file record in the system
         */
        post: operations["createFile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files/upload": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Upload a file
         * @description Uploads a file to the server and stores it in the configured storage directory
         */
        post: operations["uploadFile"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a file by ID
         * @description Returns the data and metadata of a specific file
         */
        get: operations["getFile"];
        put?: never;
        post?: never;
        /**
         * Delete a file
         * @description Removes a file from the system by ID
         */
        delete: operations["deleteFile"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files/{id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Download a file
         * @description Streams the file content to the client
         */
        get: operations["downloadFile"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/files/{id}/metadata": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Update file metadata
         * @description Updates the metadata field of a file
         */
        patch: operations["updateFileMetadata"];
        trace?: never;
    };
    "/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * List all users
         * @description Returns a list of all users
         */
        get: operations["listUsers"];
        put?: never;
        /**
         * Create a user
         * @description Creates a new user in the system
         */
        post: operations["createUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/{id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Get a user by ID
         * @description Returns the data of a specific user
         */
        get: operations["getUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/users/bootstrap": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create the first admin user
         * @description Creates the first admin user. Returns 409 if any user already exists.
         */
        post: operations["bootstrapUser"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        ActorRecord: {
            /**
             * @description Actor ID
             * @example act_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Project ID
             * @example proj_V1StGXR8Z5jdHi6B
             */
            projectId?: string;
            /** @example Alice */
            name?: string;
            /**
             * @description Actor type (e.g. 'customer', 'agent')
             * @example customer
             */
            type?: string | null;
            /**
             * @description External identifier (e.g. WhatsApp phone number)
             * @example +15551234567
             */
            externalId?: string | null;
            /** @description Persona-specific instructions composed into the effective system prompt during conversation generation. */
            instructions?: string | null;
            /** @description Agent this actor is linked to (mutually exclusive with chatId). */
            agentId?: string | null;
            /** @description Chat this actor is linked to (mutually exclusive with agentId). */
            chatId?: string | null;
            tags?: {
                [key: string]: string;
            };
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        ErrorResponse: {
            /** @example Actor not found */
            error?: string;
        };
        AgentTool: {
            /**
             * @description Public ID of the agent tool
             * @example agt_tool_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Public ID of the owning project
             * @example proj_V1StGXR8Z5jdHi6B
             */
            projectId?: string;
            /**
             * @description Tool name
             * @example get-weather
             */
            name?: string;
            /**
             * @description Tool type
             * @example http
             * @enum {string}
             */
            type?: "http" | "client" | "mcp" | "soat";
            /** @description What the tool does (sent to the model) */
            description?: string | null;
            /** @description JSON Schema for tool input */
            parameters?: Record<string, never> | null;
            /** @description Execution config (url, headers) */
            execute?: Record<string, never> | null;
            /** @description MCP server config (url, headers) */
            mcp?: Record<string, never> | null;
            /** @description SOAT platform actions to expose */
            actions?: string[] | null;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        CreateAgentToolRequest: {
            /** @description Public ID of the project */
            projectId?: string;
            /** @description Tool name */
            name: string;
            /**
             * @description Tool type (default http)
             * @enum {string}
             */
            type?: "http" | "client" | "mcp" | "soat";
            /** @description What the tool does */
            description?: string;
            /** @description JSON Schema for tool input */
            parameters?: Record<string, never>;
            /** @description Execution config (url, headers) */
            execute?: Record<string, never>;
            /** @description MCP server config (url, headers) */
            mcp?: Record<string, never>;
            /** @description SOAT platform actions */
            actions?: string[];
        };
        UpdateAgentToolRequest: {
            name?: string;
            /** @enum {string} */
            type?: "http" | "client" | "mcp" | "soat";
            description?: string | null;
            parameters?: Record<string, never> | null;
            execute?: Record<string, never> | null;
            mcp?: Record<string, never> | null;
            actions?: string[] | null;
        };
        Agent: {
            /**
             * @description Public ID of the agent
             * @example agt_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /** @description Public ID of the owning project */
            projectId?: string;
            /** @description Public ID of the AI provider */
            aiProviderId?: string;
            /** @description Display name */
            name?: string | null;
            /** @description System instructions guiding behavior */
            instructions?: string | null;
            /** @description Model identifier */
            model?: string | null;
            /** @description Public IDs of attached agent tools */
            toolIds?: string[] | null;
            /** @description Maximum reasoning steps */
            maxSteps?: number | null;
            /** @description Tool choice strategy */
            toolChoice?: Record<string, never> | null;
            /** @description Stop conditions */
            stopConditions?: Record<string, never>[] | null;
            /** @description Subset of toolIds active per step */
            activeToolIds?: string[] | null;
            /** @description Per-step overrides */
            stepRules?: Record<string, never>[] | null;
            /** @description Allowed/denied SOAT actions */
            boundaryPolicy?: Record<string, never> | null;
            /** @description Sampling temperature */
            temperature?: number | null;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        CreateAgentRequest: {
            /** @description Public ID of the project */
            projectId?: string;
            /** @description Public ID of the AI provider */
            aiProviderId: string;
            name?: string;
            instructions?: string;
            model?: string;
            toolIds?: string[];
            maxSteps?: number;
            toolChoice?: Record<string, never>;
            stopConditions?: Record<string, never>[];
            activeToolIds?: string[];
            stepRules?: Record<string, never>[];
            boundaryPolicy?: Record<string, never>;
            temperature?: number;
        };
        UpdateAgentRequest: {
            aiProviderId?: string;
            name?: string | null;
            instructions?: string | null;
            model?: string | null;
            toolIds?: string[] | null;
            maxSteps?: number | null;
            toolChoice?: Record<string, never> | null;
            stopConditions?: Record<string, never>[] | null;
            activeToolIds?: string[] | null;
            stepRules?: Record<string, never>[] | null;
            boundaryPolicy?: Record<string, never> | null;
            temperature?: number | null;
        };
        CreateAgentGenerationRequest: {
            messages: {
                /** @enum {string} */
                role: "system" | "user" | "assistant";
                content: string;
            }[];
            /**
             * @description When true the response is an SSE stream
             * @default false
             */
            stream: boolean;
            /** @description Optional trace ID to group generations */
            traceId?: string;
            /**
             * @description Maximum nested agent-call depth; 0 short-circuits with a depth-guard response
             * @default 10
             */
            maxCallDepth: number;
        };
        SubmitToolOutputsRequest: {
            toolOutputs: {
                /** @description ID of the tool call to respond to */
                toolCallId: string;
                /** @description Result of the tool execution */
                output: unknown;
            }[];
        };
        AgentGenerationResponse: {
            /**
             * @description Public ID of the generation
             * @example agt_gen_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Generation status
             * @enum {string}
             */
            status?: "completed" | "requires_action";
            /** @description Final text output (when completed) */
            text?: string | null;
            /** @description Pending tool calls (when requires_action) */
            toolCalls?: {
                toolCallId?: string;
                toolName?: string;
                args?: Record<string, never>;
            }[] | null;
        };
        AgentTrace: {
            /**
             * @description Public ID of the trace
             * @example agt_trace_V1StGXR8Z5jdHi6B
             */
            id?: string;
            projectId?: string;
            agentId?: string;
            generations?: Record<string, never>[];
            /** Format: date-time */
            createdAt?: string;
        };
        Chat: {
            /**
             * @description Public ID of the chat
             * @example cht_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Public ID of the owning project
             * @example proj_V1StGXR8Z5jdHi6B
             */
            projectId?: string;
            /**
             * @description Public ID of the AI provider
             * @example aip_V1StGXR8Z5jdHi6B
             */
            aiProviderId?: string;
            /**
             * @description Optional human-readable name
             * @example Support Bot
             */
            name?: string | null;
            /**
             * @description Optional system message sent with every completion
             * @example You are a helpful support assistant.
             */
            systemMessage?: string | null;
            /**
             * @description Optional model override for this chat
             * @example gpt-4o
             */
            model?: string | null;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        CreateChatRequest: {
            /**
             * @description Public ID of the AI provider
             * @example aip_V1StGXR8Z5jdHi6B
             */
            aiProviderId: string;
            /**
             * @description Public ID of the project. Required when the user belongs to multiple projects and no project key is used.
             * @example proj_V1StGXR8Z5jdHi6B
             */
            projectId?: string;
            /**
             * @description Optional human-readable name
             * @example Support Bot
             */
            name?: string;
            /**
             * @description Optional system message applied to all completions on this chat
             * @example You are a helpful support assistant.
             */
            systemMessage?: string;
            /**
             * @description Optional default model override
             * @example gpt-4o
             */
            model?: string;
        };
        ChatMessageInput: {
            /**
             * @example user
             * @enum {string}
             */
            role: "system" | "user" | "assistant";
            /**
             * @description Text content of the message (mutually exclusive with documentId)
             * @example What can you help me with?
             */
            content?: string;
            /**
             * @description Public ID of a document whose content is used as the message body (mutually exclusive with content). Only valid for user/assistant roles.
             * @example doc_V1StGXR8Z5jdHi6B
             */
            documentId?: string;
        };
        ChatCompletionForChatRequest: {
            messages: components["schemas"]["ChatMessageInput"][];
            /**
             * @description Override the chat's default model for this call
             * @example gpt-4o-mini
             */
            model?: string;
            /**
             * @description When `true` the response is an SSE stream.
             * @default false
             */
            stream: boolean;
        };
        ChatMessage: {
            /**
             * @description Role of the message author
             * @example user
             * @enum {string}
             */
            role: "system" | "user" | "assistant";
            /**
             * @description Text content of the message
             * @example Hello, how are you?
             */
            content: string;
        };
        ChatCompletionRequest: {
            /**
             * @description Public ID of the AI provider to use. When omitted the server falls back to Ollama.
             * @example aip_V1StGXR8Z5jdHi6B
             */
            aiProviderId?: string;
            /**
             * @description Model identifier. Overrides the provider's `defaultModel` when specified.
             * @example gpt-4o
             */
            model?: string;
            /** @description Ordered list of chat messages */
            messages: components["schemas"]["ChatMessage"][];
            /**
             * @description When `true` the response is an SSE stream of delta chunks. When `false` (default) a single JSON object is returned.
             * @default false
             */
            stream: boolean;
        };
        ChatCompletionResponseMessage: {
            /** @example assistant */
            role?: string;
            /** @example Hello! I am doing well, thank you. */
            content?: string;
        };
        ChatCompletionChoice: {
            /** @example 0 */
            index?: number;
            message?: components["schemas"]["ChatCompletionResponseMessage"];
            /** @example stop */
            finish_reason?: string;
        };
        ChatCompletionResponse: {
            /** @example chat.completion */
            object?: string;
            /** @example gpt-4o */
            model?: string;
            choices?: components["schemas"]["ChatCompletionChoice"][];
        };
        ConversationRecord: {
            /**
             * @description Conversation ID
             * @example conv_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Project ID
             * @example proj_V1StGXR8Z5jdHi6B
             */
            projectId?: string;
            /** @description Optional human-readable name for the conversation. */
            name?: string | null;
            /**
             * @description Conversation status
             * @example open
             * @enum {string}
             */
            status?: "open" | "closed";
            /**
             * Format: date-time
             * @description Creation timestamp
             */
            createdAt?: string;
            /**
             * Format: date-time
             * @description Last update timestamp
             */
            updatedAt?: string;
        };
        ConversationMessageRecord: {
            /**
             * @description Document ID
             * @example doc_V1StGXR8Z5jdHi6B
             */
            documentId?: string;
            /**
             * @description Actor ID who sent this message
             * @example act_V1StGXR8Z5jdHi6B
             */
            actorId?: string;
            /**
             * @description Zero-based position in the conversation
             * @example 0
             */
            position?: number;
        };
        ConversationActorRecord: {
            /**
             * @description Actor ID
             * @example act_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Project ID
             * @example proj_V1StGXR8Z5jdHi6B
             */
            projectId?: string;
            /**
             * @description Actor name
             * @example Alice
             */
            name?: string;
            /**
             * @description Actor type
             * @example human
             */
            type?: string;
            /**
             * @description External identifier
             * @example ext_123
             */
            externalId?: string;
            /**
             * Format: date-time
             * @description Creation timestamp
             */
            createdAt?: string;
            /**
             * Format: date-time
             * @description Last update timestamp
             */
            updatedAt?: string;
        };
        DocumentRecord: {
            /**
             * @description Document ID
             * @example doc_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /**
             * @description Underlying file ID
             * @example file_V1StGXR8Z5jdHi6B
             */
            fileId?: string;
            /**
             * @description Project ID
             * @example proj_V1StGXR8Z5jdHi6B
             */
            projectId?: string;
            /**
             * @description Original filename
             * @example my-doc.txt
             */
            filename?: string;
            /**
             * @description File size in bytes
             * @example 42
             */
            size?: number;
            /**
             * @description Text content (only present on getDocument)
             * @example The quick brown fox jumps over the lazy dog.
             */
            content?: string | null;
            /** Format: date-time */
            createdAt?: string;
            /** Format: date-time */
            updatedAt?: string;
        };
        /** @description Stored file metadata */
        FileRecord: {
            /**
             * @description Unique file identifier
             * @example abc123
             */
            id?: string;
            /**
             * @description Name of the file
             * @example document.pdf
             */
            filename?: string;
            /**
             * @description MIME type of the file
             * @example application/pdf
             */
            contentType?: string;
            /**
             * @description File size in bytes
             * @example 1024
             */
            size?: number;
            /**
             * @description Storage backend type
             * @example local
             * @enum {string}
             */
            storageType?: "local" | "s3" | "gcs";
            /**
             * @description Path where the file is stored
             * @example /uploads/document.pdf
             */
            storagePath?: string;
            /**
             * @description JSON string with additional metadata
             * @example {"author":"John"}
             */
            metadata?: string;
            /**
             * Format: date-time
             * @description Creation timestamp
             */
            createdAt?: string;
            /**
             * Format: date-time
             * @description Last update timestamp
             */
            updatedAt?: string;
        };
        UserRecord: {
            /**
             * @description Public user ID (usr_ prefix)
             * @example usr_V1StGXR8Z5jdHi6B
             */
            id?: string;
            /** @example johndoe */
            username?: string;
            /**
             * @example user
             * @enum {string}
             */
            role?: "admin" | "user";
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            createdAt?: string;
            /**
             * Format: date-time
             * @example 2024-01-01T00:00:00.000Z
             */
            updatedAt?: string;
        };
    };
    responses: {
        /** @description Authentication required */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
        /** @description Insufficient permissions */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /** @example File not found */
                "application/json": components["schemas"]["ErrorResponse"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listActors: {
        parameters: {
            query?: {
                /** @description Project ID (optional) */
                projectId?: string;
                /** @description External ID to filter by (e.g. WhatsApp phone number) */
                externalId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of actors */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActorRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createActor: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID. Required for JWT auth; omit when using an project key.
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    projectId?: string;
                    /** @example Alice */
                    name: string;
                    /**
                     * @description Optional actor type (e.g. 'customer', 'agent')
                     * @example customer
                     */
                    type?: string;
                    /**
                     * @description Optional external identifier (e.g. WhatsApp phone number). Must be unique within a project.
                     * @example +15551234567
                     */
                    externalId?: string;
                };
            };
        };
        responses: {
            /** @description Actor created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActorRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getActor: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Actor ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Actor found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ActorRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Actor not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteActor: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Actor ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Actor deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Actor not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listAgentTools: {
        parameters: {
            query?: {
                /** @description Project public ID to filter by */
                projectId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of agent tools */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTool"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createAgentTool: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentToolRequest"];
            };
        };
        responses: {
            /** @description Agent tool created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTool"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getAgentTool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                toolId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agent tool */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTool"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateAgentTool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                toolId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateAgentToolRequest"];
            };
        };
        responses: {
            /** @description Agent tool updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTool"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteAgentTool: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                toolId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listAgentTraces: {
        parameters: {
            query?: {
                /** @description Project public ID to filter by */
                projectId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of traces */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTrace"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getAgentTrace: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                traceId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Trace details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentTrace"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listAgents: {
        parameters: {
            query?: {
                /** @description Project public ID to filter by */
                projectId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of agents */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createAgent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentRequest"];
            };
        };
        responses: {
            /** @description Agent created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Agent details */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateAgentRequest"];
            };
        };
        responses: {
            /** @description Agent updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Agent"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteAgent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createAgentGeneration: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAgentGenerationRequest"];
            };
        };
        responses: {
            /** @description Generation result or SSE stream */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentGenerationResponse"];
                    "text/event-stream": string;
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Agent or AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    submitAgentToolOutputs: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                agentId: string;
                generationId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SubmitToolOutputsRequest"];
            };
        };
        responses: {
            /** @description Generation result after resuming */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AgentGenerationResponse"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Agent or generation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listChats: {
        parameters: {
            query?: {
                /** @description Project public ID to filter by */
                projectId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of chats */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Chat"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createChat: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateChatRequest"];
            };
        };
        responses: {
            /** @description Chat created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Chat"];
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getChat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                chatId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Chat record */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Chat"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Chat not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteChat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                chatId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Chat deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Chat not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createChatCompletionForChat: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                chatId: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChatCompletionForChatRequest"];
            };
        };
        responses: {
            /** @description Chat completion result (JSON or SSE stream) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChatCompletionResponse"];
                    "text/event-stream": string;
                };
            };
            /** @description Bad Request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Chat or AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createChatCompletion: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChatCompletionRequest"];
            };
        };
        responses: {
            /** @description Chat completion result (JSON or SSE stream) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChatCompletionResponse"];
                    "text/event-stream": string;
                };
            };
            /** @description Bad Request — `messages` is missing or empty */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized — missing or invalid bearer token */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description AI provider not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listConversations: {
        parameters: {
            query?: {
                /** @description Project ID (optional) */
                projectId?: string;
                /** @description Filter by actor ID */
                actorId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of conversations */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createConversation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID. Required for JWT auth; omit when using an project key.
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    projectId?: string;
                    /**
                     * @description Initial conversation status
                     * @default open
                     * @enum {string}
                     */
                    status?: "open" | "closed";
                };
            };
        };
        responses: {
            /** @description Conversation created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conversation found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Conversation deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description New conversation status
                     * @enum {string}
                     */
                    status: "open" | "closed";
                };
            };
        };
        responses: {
            /** @description Conversation updated */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listConversationMessages: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of messages */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationMessageRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    addConversationMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Message text content to add to the conversation
                     * @example Hello, how can I help you?
                     */
                    message: string;
                    /**
                     * @description Actor ID who is sending this message
                     * @example act_V1StGXR8Z5jdHi6B
                     */
                    actorId: string;
                    /**
                     * @description Zero-based position. Defaults to MAX+1 (append).
                     * @example 0
                     */
                    position?: number;
                };
            };
        };
        responses: {
            /** @description Message added */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationMessageRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation or actor not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    generateConversationMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @description ID of the actor that will produce the next message. Must have `agentId` or `chatId` set. */
                    actorId: string;
                    /** @description Optional model override. Only honored for chat-backed actors. */
                    model?: string;
                    /** @description If true, stream tokens via SSE. NOT IMPLEMENTED in v1 — returns 501. */
                    stream?: boolean;
                };
            };
        };
        responses: {
            /** @description Generation completed or requires action */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": Record<string, never>;
                };
            };
            /** @description Invalid request */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation or actor not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Streaming not implemented */
            501: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listConversationActors: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of actors */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ConversationActorRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    removeConversationMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Conversation ID */
                id: string;
                /** @description Document ID */
                documentId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Message removed */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Conversation or message not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listDocuments: {
        parameters: {
            query?: {
                /** @description Project ID (optional) */
                projectId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of documents */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"][];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createDocument: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID. Required for JWT auth; omit when using an project key.
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    projectId?: string;
                    /** @example The quick brown fox jumps over the lazy dog. */
                    content: string;
                    /** @example my-doc.txt */
                    filename?: string;
                };
            };
        };
        responses: {
            /** @description Document created */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getDocument: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Document ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Document found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Document not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteDocument: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description Document ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Document deleted */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Document not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    searchDocuments: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Project ID (optional). Omit to search across all accessible projects.
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    projectId?: string;
                    /** @example What is the capital of France? */
                    query: string;
                    /** @example 5 */
                    limit?: number;
                };
            };
        };
        responses: {
            /** @description Search results */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["DocumentRecord"][];
                };
            };
            /** @description Invalid request body */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Unauthorized */
            401: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Forbidden */
            403: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listFiles: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of files returned successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"][];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createFile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description Name of the file
                     * @example document.pdf
                     */
                    filename?: string;
                    /**
                     * @description MIME type of the file
                     * @example application/pdf
                     */
                    contentType?: string;
                    /**
                     * @description File size in bytes
                     * @example 1024
                     */
                    size?: number;
                    /**
                     * @description Storage backend type
                     * @example local
                     * @enum {string}
                     */
                    storageType: "local" | "s3" | "gcs";
                    /**
                     * @description Path where the file is stored
                     * @example /uploads/document.pdf
                     */
                    storagePath: string;
                    /**
                     * @description JSON string with additional metadata
                     * @example {"author":"John"}
                     */
                    metadata?: string;
                };
            };
        };
        responses: {
            /** @description File created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    uploadFile: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "multipart/form-data": {
                    /**
                     * Format: binary
                     * @description File content
                     */
                    file: string;
                    /**
                     * @description Project ID to associate the file with
                     * @example proj_V1StGXR8Z5jdHi6B
                     */
                    projectId: string;
                    /**
                     * @description Additional metadata as a JSON string
                     * @example {"author":"John"}
                     */
                    metadata?: string;
                };
            };
        };
        responses: {
            /** @description File uploaded successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"];
                };
            };
            /** @description Missing file or invalid project */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    getFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description File ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"];
                };
            };
            /** @description File not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    deleteFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description ID of the file to delete */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File deleted successfully */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            /** @description File not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    downloadFile: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description File ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description File content */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/octet-stream": string;
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description File not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    updateFileMetadata: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description File ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /**
                     * @description New metadata as a JSON string
                     * @example {"author":"Jane","tags":["report"]}
                     */
                    metadata?: string;
                    /**
                     * @description New filename for the file
                     * @example renamed-file.txt
                     */
                    filename?: string;
                };
            };
        };
        responses: {
            /** @description Metadata updated successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FileRecord"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description File not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    listUsers: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description List of users returned successfully */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserRecord"][];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    createUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example johndoe */
                    username: string;
                    /**
                     * Format: password
                     * @example supersecret
                     */
                    password: string;
                    /**
                     * @example user
                     * @enum {string}
                     */
                    role?: "admin" | "user";
                };
            };
        };
        responses: {
            /** @description User created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserRecord"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    getUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User ID */
                id: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description User found */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserRecord"];
                };
            };
            /** @description User not found */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
    bootstrapUser: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @example admin */
                    username: string;
                    /**
                     * Format: password
                     * @example supersecret
                     */
                    password: string;
                };
            };
        };
        responses: {
            /** @description Admin user created successfully */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UserRecord"];
                };
            };
            /** @description Users already exist */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
            /** @description Internal server error */
            500: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ErrorResponse"];
                };
            };
        };
    };
}
