# Browser build credential boundary

- Any Vite build mode refuses a nonempty VITE_AUTH_TOKEN before producing assets.
- Refusal names the unsafe configuration key without including its value.
- Empty or absent credentials permit normal builds; existing private development
  configuration is unchanged.
- Verify the real Vite config/build boundary with isolated manufactured values,
  then inspect fresh production assets without recording credential values.
