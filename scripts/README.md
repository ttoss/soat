# Scripts

## validate-tutorial.sh

`validate-tutorial.sh` validates documentation tutorials by extracting and running only the CLI bash commands from a tutorial markdown file.

### What it does

1. Checks that the target markdown file exists.
2. Checks that `SOAT_BASE_URL` is set.
3. Extracts commands only from `<TabItem value="cli">` sections.
4. Extracts only fenced `bash` blocks inside those sections.
5. Joins multiline commands that end with `\`.
6. Executes commands in order in the same shell context (`eval`) so exported variables are reused across steps.
7. Stops immediately if any command fails.

### Usage

From repository root:

```bash
chmod +x scripts/validate-tutorial.sh
export SOAT_BASE_URL=http://localhost:5047
./scripts/validate-tutorial.sh packages/website/docs/tutorials/permissions.md
```

Verbose mode:

```bash
VERBOSE=1 ./scripts/validate-tutorial.sh packages/website/docs/tutorials/chat-with-llm.md
```

### Requirements

- Local SOAT server running.
- `soat` CLI available in `PATH`.
- `SOAT_BASE_URL` exported.

### Limitations

- Interactive commands (for example manual token input flows) are not automated.
- If a tutorial intentionally includes failing commands (for permission checks), validation will stop on the first failure.
- Commands are executed with `eval`, so only run trusted tutorial files.
