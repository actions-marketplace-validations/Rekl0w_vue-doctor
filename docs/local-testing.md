# Local Testing

Use this when you want to run the local checkout of Vue Doctor against one of your real Vue projects before publishing to npm.

## Prerequisites

- Node.js `20.12` or newer
- npm `10` or newer
- A Vue project with `package.json`

Check your machine:

```powershell
node --version
npm --version
```

## Option 1: Live Local Link

This is best while developing Vue Doctor because every rebuild updates the linked command.

From this repo:

```powershell
cd C:\Users\Windows\Desktop\vue-doctor
npm install
npm run local:link
```

From your Vue project:

```powershell
cd C:\Users\Windows\Desktop\your-vue-project
vue-doctor --verbose
vue-doctor --json > vue-doctor-report.json
vue-doctor --markdown > vue-doctor-report.md
vue-doctor --sarif > vue-doctor.sarif
vue-doctor --blocking warning
```

When you are done testing:

```powershell
npm unlink -g @rekl0w/vue-doctor
```

## Option 2: Install The Local Tarball

This is closest to how users will install the published npm package.

From this repo:

```powershell
cd C:\Users\Windows\Desktop\vue-doctor
npm install
npm run local:pack
```

From your Vue project:

```powershell
cd C:\Users\Windows\Desktop\your-vue-project
npm install -D (Get-ChildItem C:\Users\Windows\Desktop\vue-doctor\.local-pack\rekl0w-vue-doctor-*.tgz | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
npx vue-doctor --verbose
```

Remove the local test package later:

```powershell
npm uninstall @rekl0w/vue-doctor
```

## Useful Smoke Commands

```powershell
vue-doctor --score
vue-doctor --json
vue-doctor --markdown
vue-doctor --sarif
vue-doctor src --include src
vue-doctor --blocking none
vue-doctor --blocking error
vue-doctor --annotations
vue-doctor --scope changed --base main --blocking warning
vue-doctor --update-baseline vue-doctor-baseline.json --blocking none
vue-doctor --baseline vue-doctor-baseline.json --blocking warning
```

## Expected Output

The CLI should print a `Vue Doctor` score line and diagnostics grouped by category. JSON mode should print one valid JSON object with `schemaVersion`, `project`, `diagnostics`, and `summary`. Markdown should render a summary table, and SARIF should emit a SARIF 2.1.0 object.
