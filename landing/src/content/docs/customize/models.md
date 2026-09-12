---
title: Models, thinking, and speed
description: Refresh model catalogs, choose favorites, and use capability-dependent thinking and service-tier controls.
section: customize
order: 2
type: guide
audience: Model selectors
related:
  - customize/providers
  - agent/context-compaction
  - troubleshooting/providers-models
---

The composer model picker shows configured providers and retains the current active provider. Model controls change according to catalog metadata and provider support.

## Choose and refresh models

1. Configure and activate a provider in [Settings → Providers](/docs/customize/providers).
1. Open the composer model picker.
1. Select a model from that provider.
1. Use `Refresh models` in Providers when the live catalog is stale or incomplete.

Seed model IDs are local fallback metadata. A successful refresh replaces or supplements them with the host's current catalog. A visible seed name does not prove the endpoint is online.

If a host does not offer a model list at all, the picker stays empty by design. For the Custom OpenAI-compatible provider, type any model ID into the picker search box and press Enter to select it; the ID goes to the host verbatim and appears in recents.

## Capabilities

Model information can identify:

- tool support;
- image input;
- native file input;
- audio input;
- structured output;
- thinking/reasoning support;
- context-window estimate;
- provider-specific service tiers.

The composer uses these fields to show controls and validate attachments. Do not assume models from the same provider have identical capabilities.

## Thinking

When the model supports thinking, Think controls reasoning behavior and effort. Settings → Agent → Show thinking in chat controls whether completed thinking appears as collapsed blocks above assistant replies.

Thinking preferences are retained per provider. If the selected model does not expose a compatible reasoning API, the control is hidden or reduced instead of sending an invented parameter.

## Speed and service tier

Models that support service tiers can show Speed with Default, Flex, or Priority. The selected value is stored per model where applicable. Availability and billing are provider decisions; the app only sends the supported tier value.

## Favorites, recents, and fallback metadata

Favorites and up to five recent model selections improve picker navigation. They do not configure a provider or store a key.

When catalog refresh fails, confirm the provider key, base URL, and network state. Then use Provider and model issues rather than repeatedly changing model IDs.
