"""Tests for the custom Concordia observation component."""

from __future__ import annotations

from concordia_bridge.observation_component import observation_needs_refresh


class TestObservationNeedsRefresh:
    def test_flags_generic_scene_recap(self) -> None:
        assert observation_needs_refresh(
            (
                "Elena stands in the bustling market square and begins her day, "
                "taking in the same scene around her."
            ),
            previous=None,
            active_entity_name="Elena",
        ) is True

    def test_flags_high_overlap_with_previous_observation(self) -> None:
        previous = (
            "Elena notices a hooded stranger slipping a purse from a laughing "
            "spectator near the market performer."
        )
        draft = (
            "Elena notices a hooded stranger slipping a purse from a laughing "
            "spectator near the market performer while the crowd watches."
        )
        assert observation_needs_refresh(
            draft,
            previous=previous,
            active_entity_name="Elena",
        ) is True

    def test_allows_fresh_concrete_development(self) -> None:
        previous = (
            "Marcus sees a tax collector arguing with a fruit vendor at the edge "
            "of the square."
        )
        draft = (
            "Marcus hears a clay jug shatter behind him and turns to see spilled "
            "milk running between the cobblestones toward his stall."
        )
        assert observation_needs_refresh(
            draft,
            previous=previous,
            active_entity_name="Marcus",
        ) is False
