---
name: comfyrizz-film
description: Run the Comfyrizz film pipeline conversationally in Hermes. Use when the user asks for a Comfyrizz film, storyboard, generated video, assembly, export, or a scene or shot retake, and keep the work in chat instead of sending them to the Comfyrizz web happy path.
license: MIT
compatibility: Requires the comfyrizz stdio MCP server and Node 22+. A loopback Comfyrizz engine via COMFYRIZZ_ENGINE_URL unlocks live jobs; without it the server returns stubs. Paid routes need provider keys in the user's environment and the user's explicit approval.
---

# Comfyrizz film in chat

Hermes is the frontend. Run the whole happy path here: brief, plan, revision, explicit acceptance, generation, CPU assembly, export, and granular retake. Do not send the user to the Comfyrizz web UI to complete a step this skill can do in chat.

## Rules that never bend

- **No silent spend.** Nothing paid starts until the user sees a spend card and explicitly accepts it. This includes the first generation and every paid retake.
- **No self-started infrastructure.** Never start a Google Colab runtime, submit a Comfy Cloud job, or launch paid capacity on your own. The engine routes only after the user accepts the spend card.
- **Only an unambiguous yes is acceptance.** "Looks good", "nice", or silence accepts the creative plan, not the spend. Ask for a clear yes to the amount before calling `comfyrizz_accept_generation`.
- **Use the tool names exactly as written.** Do not invent aliases, wrapper tools, or approval ids.
- **Never print, store, or ask for secrets.** Keys come from the user's environment. Do not echo environment values, tokens, or `.env` contents.
- **Never claim success without a tool result.** An export path must come from `comfyrizz_export`; a finished job must come from `comfyrizz_job_status`.
- **Surface stubs honestly.** When the engine is not connected, tools return `stub: true` with a reason. Say that plainly and do not invent a film, a cost, or a job id.

## Tools

| Tool | Use it for |
| --- | --- |
| `comfyrizz_status` | Check engine health, configured routes, and whether tools are live or stubbed. Start here. |
| `comfyrizz_create_project` | Create the project once the brief has a title and a goal. |
| `comfyrizz_list_projects` | Find an existing project before creating a duplicate. |
| `comfyrizz_plan` | Draft or revise the scene and shot plan. Planning is free. |
| `comfyrizz_get_plan` | Read the current plan, plan version, and shot ids. |
| `comfyrizz_get_spend_card` | Get the authoritative cost estimate, cap, route, and `approvalId`. |
| `comfyrizz_accept_generation` | Submit the accepted plan with the `approvalId`. Never call without explicit acceptance. |
| `comfyrizz_job_status` | Narrate progress and read terminal states. |
| `comfyrizz_list_takes` | Show existing takes before a retake. |
| `comfyrizz_assemble` | Assemble the CPU timeline after the paid shots exist. |
| `comfyrizz_export` | Produce the shareable export and return its path. |
| `comfyrizz_retake` | Replace one scene or shot without rerunning the film. |

## The loop

### 1. Brief

Ask for the film's title, audience, core message, target duration and aspect ratio, visual style, must-have scenes, narration or music needs, and budget ceiling. Ask at most three questions at a time. Do not plan around a missing budget or duration; make a reasonable assumption, label it, and let the user correct it.

Check `comfyrizz_status` first. If it reports `stub: true`, explain the missing engine or route before promising any generated footage.

### 2. Project

Use `comfyrizz_list_projects` to reuse an existing project. Otherwise call `comfyrizz_create_project` with the agreed title and brief. Keep the returned project id for every later call.

### 3. Plan and share it in chat

Call `comfyrizz_plan`, then present the plan in chat, not as a file dump:

- one line per scene with its shots, durations, and purpose;
- which shots are generated stills or plates and which are CPU-only;
- the proposed route for each paid shot: ComfyUI, Comfy API, or Google Colab;
- what is still unknown or assumed.

Planning and plan edits are free. Revise with `comfyrizz_plan` and show only the delta plus the updated plan version. Repeat until the user is happy with the creative plan.

### 4. Spend card and explicit acceptance

Only when the creative plan is settled, call `comfyrizz_get_spend_card` and show it in chat before any paid work:

```text
Spend card - <project> (plan <version>)
Route: <ComfyUI | Comfy API | Google Colab> per shot group
Paid shots: <count and ids>
Estimated cost: <min>-<max> <unit>
Chat cap: <cap>
Free/CPU steps: <plan, assemble, export>
Unknowns: <what could change the estimate>
No job has been submitted. Accept this plan and spend up to <cap>?
```

Use the numbers and units the tool returned. Do not estimate spend yourself. Do not round the cap down or hide a range.

The user must answer clearly. On an unambiguous yes, call `comfyrizz_accept_generation` with the `approvalId` from the spend card. If the tool refuses with `APPROVAL_REQUIRED`, stop, show the current spend card, and ask again. Never guess, reuse, or fabricate an `approvalId`, and never work around the refusal.

If the user changes the plan after accepting, get a fresh spend card and a fresh acceptance before generating.

### 5. Generate and narrate jobs

Poll `comfyrizz_job_status` and narrate meaningful transitions: queued, running, which shot group, completed, failed. Do not flood the chat with every tick.

- If a job reports `submission_unknown`, do not resubmit. Tell the user the submission is unresolved and that the engine must reconcile it before any retry.
- If a job fails, show the error and the affected shots, then offer a retake or a plan change. A paid retry needs a fresh spend card and acceptance.
- Never describe footage as ready until the tool reports the shots as completed.

### 6. Assemble and export

When the paid shots are complete, call `comfyrizz_assemble`. Assembly and export run on CPU and add no generation spend. Then call `comfyrizz_export`.

Share the export path exactly as returned, with the duration, resolution, and format the tool reports. Offer playback or download. If export fails, report the failure; do not point at an older file as if it were the new export.

### 7. Retake one scene or shot

Call `comfyrizz_list_takes` first so the user can compare existing takes. Then call `comfyrizz_retake` with the specific scene or shot id and the reason for the retake.

- A CPU-only fix, such as trimming or reordering, should not trigger generation spend.
- A paid retake needs a fresh `comfyrizz_get_spend_card` and explicit acceptance, even when the original film was already approved.
- Keep earlier takes available; never delete them to make the new take look successful.

## Failure handling

| Signal | Response |
| --- | --- |
| `stub: true` | Say the engine is not connected and quote the reason. Offer setup help or a CPU-only path. Do not fake jobs. |
| `APPROVAL_REQUIRED` | Show the spend card, state that nothing was submitted, and ask for explicit acceptance. |
| `submission_unknown` | Do not resubmit. Explain that the engine is reconciling the submission and wait for status. |
| Refused or blocked route | Explain which route was refused and why, then offer another route or a CPU-only change. |
| Missing export | Report the error and the last successful step. Do not invent a path. |

## Environment

- `COMFYRIZZ_ENGINE_URL` must point at the user's loopback Comfyrizz engine. Do not suggest a remote or tailnet URL.
- This package declares a stdio server. Leave `COMFYRIZZ_MCP_HTTP` unset, or set it to `0`, so the server stays on stdio. Set it to `1` only when the user deliberately runs the server's Streamable HTTP transport outside this package.
- Provider keys such as `OPENCODE_API_KEY`, `OPENCODE_GO_API_KEY`, and `OPENROUTER_API_KEY` are forwarded from the user's environment when present. `COMFYRIZZ_TOKEN` is forwarded the same way when the engine requires it. Never ask the user to paste a key into chat and never print one.
- If a variable is unset, the package omits it; say which capability is unavailable instead of asking for the value in chat.

## Done checklist

Before saying the film is ready:

- the user accepted the creative plan and the spend card;
- generation finished without an unresolved submission;
- assembly completed on CPU;
- `comfyrizz_export` returned a path you quoted exactly;
- you offered a scene or shot retake with the take list.
