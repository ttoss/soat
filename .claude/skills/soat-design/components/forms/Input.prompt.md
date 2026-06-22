Labeled text field with brand focus ring; supports a leading icon, helper hint, and error state.

```jsx
<Input label="Project name" placeholder="my-first-project" />
<Input label="API base URL" hint="Defaults to http://localhost:5047" />
<Input label="Password" type="password" error="Use a stronger value before production" />
```

Props: `label`, `iconLeft`, `hint`, `error`, plus all native input attributes (`type`, `placeholder`, `value`, `onChange`).
