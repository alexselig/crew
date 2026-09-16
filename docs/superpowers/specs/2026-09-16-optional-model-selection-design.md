# Optional Model Selection Design

## Goal

Keep the New Session dialog launchable when Copilot model discovery is still
loading, fails, or returns no selectable models.

## Behavior

Copilot model discovery is an optional enhancement, not a prerequisite for
creating a session.

- While model discovery is loading, hide the Model field and allow Launch.
- If discovery fails, hide the Model field and allow Launch.
- If discovery succeeds with an empty model list, hide the Model field and
  allow Launch.
- If discovery succeeds with selectable models, show the existing Model
  dropdown.
- If the user selects a listed model, launch with `--model <id>`.
- If the Model dropdown is unavailable, launch with the Copilot preset's
  original arguments and do not add or replace a model argument. The installed
  Copilot CLI chooses its native default.
- Switching to another agent continues to hide the Copilot Model field.

The dialog does not show a model-discovery error or Retry control when launch
can proceed without model selection. Model discovery failure remains available
to diagnostics through the existing main-process behavior.

## State and Request Construction

The dialog derives `hasSelectableModels` from a successful catalog containing
at least one model. Model availability does not participate in `canCreate`.

For a Copilot preset:

- When `hasSelectableModels` is true, apply `withCopilotModel()` using the
  selected model.
- Otherwise, copy the preset arguments unchanged.

The selected model state remains initialized to Crew's preferred model. If
discovery completes before submission and lists that model, the dropdown
appears with it selected. If the preferred model is not listed, the existing
unavailable-selection behavior remains: the user must choose a listed model
before submitting an explicit model.

## Error Handling

Session creation errors remain visible in the dialog and keep the dialog open.
Model discovery errors do not block or alter session creation.

## Testing

Renderer tests must prove:

1. Launch is enabled while model discovery is pending.
2. The Model dropdown is absent while discovery is pending.
3. Discovery failure keeps the dropdown absent and Launch enabled.
4. An empty successful catalog keeps the dropdown absent and Launch enabled.
5. Pending, failed, and empty-catalog submissions preserve the preset arguments
   without adding `--model`.
6. A successful catalog shows the dropdown and an explicit selection adds the
   expected model argument.
7. Existing non-Copilot and custom-command launch behavior is unchanged.

Tests should use the renderer fixture or component harness and must not launch
an unsigned Electron application on hosts that block unsigned apps.

## Out of Scope

- Changing model discovery or its cache.
- Choosing a new hard-coded fallback model.
- Changing saved-session restore semantics.
- Version bumping or publishing a release.
