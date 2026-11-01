# Privacy

OpenDesign is **local-first** and collects **no telemetry**. The desktop and web
app, the daemon, and the packaged launcher send no product analytics, session
replay, conversation content, quality traces, or crash and reliability reports
to anyone. There is no consent setting because there is nothing to opt out of.

Your projects, generated files, and BYOK API keys stay on your machine.

## What still leaves your machine

Features you use contact the services they need:

- **Model providers and coding agents.** Prompts, attachments, and context go to
  the agent CLI or model provider you select, under that provider's own terms.
  The keys you configure are stored locally and used only to call that provider.
- **Deploy targets.** Deploying a project to Vercel or Cloudflare Pages sends its
  files to that provider, using the credentials you configure.
- **Composio connectors.** Connectors you authorize run through Composio with the
  API key you provide.
- **Other providers you configure,** such as media providers, receive what those
  features need.
- **GitHub.** The app reads the OpenDesign repository's public star count from
  `api.github.com`. GitHub is also contacted when you install a plugin from it,
  import a repository as design-system source, or refresh a live artifact that
  reads from it.
- **OpenDesign content hosts.** The app fetches release notes from
  `whatsnew.open-design.ai`, plugin previews and catalog images from
  `repo-assets.open-design.ai`, and the plugin marketplace catalog from
  `open-design.ai`. Generated plugin manifests reference a schema URL on
  `open-design.ai`; that reference is not itself a request.
- **Community pets.** Browsing and syncing community pets calls a Supabase
  function that serves the catalog.
- **Updates.** The packaged app contacts its release channel at
  `releases.open-design.ai` to check for and download updates.

As with any HTTPS request, the receiving service can see your connection's
source IP address.

## Diagnostics you export yourself

Diagnostic bundles are created only when you ask for one and are saved locally.
Nothing is uploaded automatically; sharing a bundle is up to you.

## Changes to this page

This document tracks the data handling of the app. When that behavior changes,
this page is updated alongside it.
