# Vendored `@copilotkit/channels` (Workers-safe)

`copilotkit-channels-0.1.1.tgz` is the published npm package with `create-bot.js`
patched so package identity does **not** use `createRequire(import.meta.url)`
(that crashes workerd).

`@copilotkit/channels-ui` and `@copilotkit/channels-slack` come from the npm registry.

Refresh:

```bash
cd /tmp && rm -rf ck && mkdir ck && cd ck
npm pack @copilotkit/channels@0.1.1 && tar -xzf copilotkit-channels-0.1.1.tgz
cp "$HOME/Documents/CopilotKit/packages/channels/dist/create-bot.js" package/dist/create-bot.js
(cd package && npm pack --pack-destination "$HOME/Documents/opentag/edge/vendor")
cd "$HOME/Documents/opentag/edge" && npm install
```

Drop this once upstream publishes the Workers fix.
