# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: Vinext/React with TypeScript, Tailwind CSS, shadcn components, and Cloudflare D1. The user asked to create the first working version now and refine it later, so the implementation stack is inferred and reversible.

## Product Summary

Urtoris is a paired workflow system: the “创建工作流端” creates and publishes multiple ordered workflows, while the “使用工作流端” loads a published version into the Agent, lets the user converse with it, and returns live status, logs, and a result.

## Users

- Workflow creators who design repeatable procedures.
- Workflow users who pick a published workflow, chat with the Agent, start a run, and inspect what the Agent did.
- For the first prototype, both roles can be used by the same person in one browser.

## Core Jobs

- Create multiple named workflows from a small set of safe step types.
- Publish a version that becomes available to the connected Agent.
- Load a published workflow into the Agent and send it messages, receiving a step-by-step reply.
- Start a run and watch each step move through queued, running, and completed states.
- Inspect the output and execution log without switching tools.

## Positioning

The defining mechanism is the visible handoff between authoring and execution: a workflow is not just drawn, it crosses a shared bridge and comes back with evidence of what the Agent did.

## MVP Scope

- A Creator surface for naming multiple workflows, adding/reordering/editing steps, and publishing versions.
- A “使用工作流端” surface with a workflow loader, an Agent chat panel, run controls, step progress, logs, and final output.
- Persistent workflow and run records through D1.
- A safe simulated executor using only prototype step types; no arbitrary shell commands or third-party credentials.
- Synthetic starter content clearly labeled as demonstration data.

## Out of Scope for This Version

- Public deployment, ICP filing, domain changes, billing, teams, permissions, marketplace distribution, arbitrary code execution, and external integrations.
- Production authentication and secrets management.

## Evidence and Assets

- No customer evidence, brand kit, production integrations, or real workflow data has been supplied.
- The domain `urtoris.cn` establishes the working product name “Urtoris”; this remains replaceable.

## Principles

- Make the creator-to-Agent loop work end to end before adding breadth.
- Keep every execution state legible and explainable.
- Default to safe, whitelisted actions.
- Learn from a usable prototype, then refine the model and visual system.

## Open Decisions

- Whether Creator and Agent become separate accounts, applications, or devices.
- Which real integrations and trigger types come first.
- Whether workflows are private, shared inside teams, or published to a marketplace.
- Final brand identity and production deployment region.
