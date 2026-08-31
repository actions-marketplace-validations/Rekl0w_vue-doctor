# oxlint-plugin-vue-doctor

Script-level Vue Doctor rules for oxlint.

```js
const vueDoctor = (await import("oxlint-plugin-vue-doctor")).default;

export default {
  plugins: {
    "vue-doctor": vueDoctor,
  },
  rules: {
    "vue-doctor/no-eval": "error",
    "vue-doctor/no-public-env-secret": "error",
    "vue-doctor/no-async-computed": "error",
  },
};
```

The main `@rekl0w/vue-doctor` CLI remains the source of truth for Vue SFC template, style, package-health, dead-code, and supply-chain checks. This package mirrors the checks oxlint can run directly over JavaScript and TypeScript ASTs.
