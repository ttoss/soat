Terminal/CLI-styled code surface with an uppercase title bar and copy button; matches the SOAT docs site. Pass code as a plain string child.

```jsx
<CodeBlock title="Terminal">{`docker compose up -d`}</CodeBlock>
<CodeBlock language="bash">{`soat create-agent --name "support-bot"`}</CodeBlock>
```

Props: `title`, `language` (overrides title). Children must be a string.
