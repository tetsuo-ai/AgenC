"""
Custom GM observation component for Concordia.

Keeps the upstream MakeObservation queue/state contract, but improves
LLM-generated fallback observations by steering away from generic scene
recaps and retrying once when the draft is too repetitive.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence

from concordia.components.game_master import make_observation as make_observation_component
from concordia.document import interactive_document
from concordia.typing import entity as entity_lib
from concordia.typing import entity_component
from concordia_bridge.instrumented_engine import sanitize_story_text


_GENERIC_RECAP_CUES = (
    "bustling market square",
    "begin their day",
    "same scene",
    "stands in",
    "takes in the scene",
    "taking in the scene",
    "morning in the medieval town",
)

_STOPWORDS = {
    "a",
    "an",
    "and",
    "as",
    "at",
    "by",
    "for",
    "from",
    "he",
    "her",
    "his",
    "in",
    "into",
    "is",
    "it",
    "its",
    "of",
    "on",
    "or",
    "she",
    "that",
    "the",
    "their",
    "there",
    "they",
    "this",
    "to",
    "up",
    "while",
}

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_OBSERVATION_MAX_TOKENS = 220
_REFORMAT_MAX_TOKENS = 260


def _tokenize_for_similarity(text: str) -> set[str]:
    return {
        token
        for token in _TOKEN_RE.findall(text.lower())
        if token not in _STOPWORDS and len(token) > 2
    }


def observation_needs_refresh(
    draft: str,
    previous: str | None,
    active_entity_name: str,
) -> bool:
    """Return True when the observation draft is overly generic or repetitive."""
    normalized = draft.strip().lower()
    if not normalized:
        return True

    generic_hits = sum(1 for cue in _GENERIC_RECAP_CUES if cue in normalized)
    if generic_hits >= 2:
        return True

    if active_entity_name.lower() in normalized and "market square" in normalized:
        if "observe" in normalized or "stands" in normalized:
            return True

    if previous:
        previous_tokens = _tokenize_for_similarity(previous)
        draft_tokens = _tokenize_for_similarity(draft)
        if previous_tokens and draft_tokens:
            overlap = previous_tokens & draft_tokens
            union = previous_tokens | draft_tokens
            similarity = len(overlap) / max(len(union), 1)
            if similarity >= 0.72:
                return True

    return False


class FreshObservationComponent(make_observation_component.MakeObservation):
    """Upstream-compatible MakeObservation subclass with repetition control."""

    def __init__(self, *args, **kwargs) -> None:
        super().__init__(*args, **kwargs)
        self._last_observations: dict[str, str] = {}

    def pre_act(
        self,
        action_spec: entity_lib.ActionSpec,
    ) -> str:
        result = ""
        prompt_to_log = ""
        log_entry: dict[str, object] = {}

        if action_spec.output_type == entity_lib.OutputType.MAKE_OBSERVATION:
            prompt = interactive_document.InteractiveDocument(self._model)
            component_states = "\n".join(
                [self._component_pre_act_display(key) for key in self._components]
            )
            prompt.statement(f"{component_states}\n")
            prompt.statement(
                f'Working out the answer to: "{action_spec.call_to_action}"'
            )

            active_entity_name = self._get_active_entity_name_from_call_to_action(
                action_spec.call_to_action
            )
            log_entry["Active Entity"] = active_entity_name

            events = self._queue.get_and_clear(active_entity_name)
            log_entry["queue"] = self._queue.get_all()
            if events:
                log_entry["queue_active_entity"] = events
                result = "\n\n\n".join(events) + "\n\n\n"
            elif self._allow_llm_fallback:
                result = self._generate_fresh_observation(
                    prompt=prompt,
                    active_entity_name=active_entity_name,
                )
            else:
                result = ""

            if self._reformat_observations_in_specified_style:
                prompt.statement(
                    "Required observation format: "
                    f"{self._reformat_observations_in_specified_style}"
                )
                result_without_newlines = result.replace("\n", "").strip()
                correct_format = prompt.yes_no_question(
                    question=(
                        f'Draft: {active_entity_name} will observe:'
                        f' "{result_without_newlines}"\nIs the draft formatted'
                        " correctly in the specified format?"
                    )
                )
                if not correct_format:
                    result = prompt.open_question(
                        question=(
                            f"Reformat {active_entity_name}'s draft observation "
                            "to fit the required format."
                        ),
                        max_tokens=_REFORMAT_MAX_TOKENS,
                        terminators=(),
                    )

            result = sanitize_story_text(result)

            stripped = result.strip()
            if stripped:
                self._last_observations[active_entity_name] = stripped
            prompt_to_log = prompt.view().text()

        log_entry["Key"] = self._pre_act_label
        log_entry["Summary"] = result
        log_entry["Value"] = result
        log_entry["Prompt"] = prompt_to_log
        self._logging_channel(log_entry)
        return result

    def get_state(self) -> entity_component.ComponentState:
        state = dict(super().get_state())
        state["last_observations"] = dict(self._last_observations)
        return state

    def set_state(self, state: entity_component.ComponentState) -> None:
        super().set_state({"queue": state["queue"]})
        raw_last = state.get("last_observations", {})
        if isinstance(raw_last, Mapping):
            self._last_observations = {
                str(key): str(value)
                for key, value in raw_last.items()
                if isinstance(key, str) and isinstance(value, str)
            }
        else:
            self._last_observations = {}

    def _generate_fresh_observation(
        self,
        *,
        prompt: interactive_document.InteractiveDocument,
        active_entity_name: str,
    ) -> str:
        previous = self._last_observations.get(active_entity_name)
        if previous:
            prompt.statement(
                f"Most recent observation already shown to {active_entity_name}:\n"
                f"{previous}"
            )

        draft = prompt.open_question(
            question=(
                f"What new, concrete development does {active_entity_name} notice "
                "right now? Focus on one immediate change, interaction, or sensory "
                "detail from their local point of view. Do not summarize the whole "
                "scene, and do not repeat the previous observation unless it directly "
                "matters to the new beat. Keep the story moving forward. Do not "
                "mention turn order, prompts, or simulation-control language."
            ),
            max_tokens=_OBSERVATION_MAX_TOKENS,
            terminators=(),
        )

        if observation_needs_refresh(draft, previous, active_entity_name):
            prompt.statement(
                "The draft observation is too generic or too similar to the last one."
            )
            draft = prompt.open_question(
                question=(
                    f"Rewrite {active_entity_name}'s observation so it contains a "
                    "fresh, specific change in the immediate situation. Avoid broad "
                    "scene-setting, avoid repeating the prior observation, and keep "
                    f"the focus on what {active_entity_name} directly notices now. "
                    "Do not mention turn order, prompts, or simulation-control text."
                ),
                max_tokens=_OBSERVATION_MAX_TOKENS,
                terminators=(),
            )

        return draft
