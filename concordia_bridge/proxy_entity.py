"""
Concordia Entity proxy — bridges Concordia's act()/observe() to the AgenC bridge server.

Implements the Concordia `Entity` and `EntityWithLogging` interfaces by
forwarding all calls over HTTP to the AgenC bridge server, which routes
them through the daemon's ChatExecutor pipeline.

Phase 0 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import functools
import logging
import time
from typing import Any

import requests

from concordia_bridge.resilience import CircuitBreaker

from concordia.typing.entity import (
    ActionSpec,
    DEFAULT_ACTION_SPEC,
    Entity,
    EntityWithLogging,
)

logger = logging.getLogger(__name__)


class ProxyEntityActError(RuntimeError):
    """Raised when the bridge cannot provide a valid agent action."""


class ProxyEntity(Entity):
    """Concordia Entity that proxies act/observe to an AgenC bridge server.

    Each ProxyEntity represents one AgenC agent in the simulation. When
    the Concordia engine calls act(), the proxy POSTs the ActionSpec to
    the bridge's /act endpoint. When observe() is called, it POSTs the
    observation to /observe for memory ingestion.
    """

    def __init__(
        self,
        agent_name: str,
        bridge_url: str = "http://localhost:3200",
        agent_id: str = "",
        world_id: str = "default",
        workspace_id: str = "concordia-sim",
        timeout_seconds: float = 120.0,
        max_retries: int = 2,
        retry_delay_seconds: float = 2.0,
    ) -> None:
        self._name = agent_name
        self._bridge_url = bridge_url.rstrip("/")
        self._agent_id = agent_id or agent_name.lower().replace(" ", "-")
        self._world_id = world_id
        self._workspace_id = workspace_id
        self._timeout = timeout_seconds
        self._max_retries = max_retries
        self._retry_delay = retry_delay_seconds
        self._turn_count = 0
        self._circuit_breaker = CircuitBreaker(failure_threshold=5, recovery_timeout_s=30.0)

    @functools.cached_property
    def name(self) -> str:
        return self._name

    @property
    def agent_id(self) -> str:
        return self._agent_id

    @property
    def world_id(self) -> str:
        return self._world_id

    @property
    def turn_count(self) -> int:
        return self._turn_count

    def act(self, action_spec: ActionSpec = DEFAULT_ACTION_SPEC) -> str:
        """Send action_spec to AgenC bridge, return the agent's action string.

        Retries on ConnectionError with exponential backoff (Phase 8.3).
        Raises ProxyEntityActError after all retries are exhausted.
        """
        self._turn_count += 1

        if self._circuit_breaker.is_open:
            logger.warning(
                "ProxyEntity %s act() circuit breaker open",
                self._name,
            )
            raise ProxyEntityActError(
                f"{self._name} bridge circuit breaker open",
            )

        last_exc: Exception | None = None

        for attempt in range(self._max_retries + 1):
            try:
                response = requests.post(
                    f"{self._bridge_url}/act",
                    json={
                        "agent_id": self._agent_id,
                        "agent_name": self._name,
                        "world_id": self._world_id,
                        "workspace_id": self._workspace_id,
                        "action_spec": action_spec.to_dict(),
                        "turn_count": self._turn_count,
                    },
                    timeout=self._timeout,
                )
                response.raise_for_status()
                result = response.json()
                action = result.get("action", "")
                self._circuit_breaker.record_success()
                logger.debug(
                    "ProxyEntity %s act() turn=%d: %s",
                    self._name,
                    self._turn_count,
                    action[:100],
                )
                return action
            except requests.Timeout:
                logger.warning(
                    "ProxyEntity %s act() timed out after %.1fs",
                    self._name,
                    self._timeout,
                )
                raise ProxyEntityActError(
                    f"{self._name} action timed out after {self._timeout:.1f}s",
                )
            except requests.ConnectionError as exc:
                last_exc = exc
                self._circuit_breaker.record_failure()
                if attempt < self._max_retries:
                    delay = self._retry_delay * (2 ** attempt)
                    logger.warning(
                        "ProxyEntity %s act() connection failed (attempt %d/%d) — "
                        "retrying in %.1fs",
                        self._name,
                        attempt + 1,
                        self._max_retries + 1,
                        delay,
                    )
                    time.sleep(delay)
                    continue
            except requests.HTTPError as exc:
                self._circuit_breaker.record_failure()
                logger.error(
                    "ProxyEntity %s act() HTTP error: %s",
                    self._name,
                    exc,
                )
                raise ProxyEntityActError(
                    f"{self._name} bridge HTTP error: {exc}",
                ) from exc

        logger.error(
            "ProxyEntity %s act() all %d retries exhausted — bridge unreachable: %s",
            self._name,
            self._max_retries + 1,
            last_exc,
        )
        raise ProxyEntityActError(
            f"{self._name} bridge unreachable after {self._max_retries + 1} attempts",
        ) from last_exc

    def observe(self, observation: str) -> None:
        """Send observation to AgenC bridge for memory ingestion.

        Observations are fire-safe: failures are logged but never raise,
        so the simulation engine is never blocked.
        """
        if not observation or not observation.strip():
            return
        try:
            response = requests.post(
                f"{self._bridge_url}/observe",
                json={
                    "agent_id": self._agent_id,
                    "agent_name": self._name,
                    "world_id": self._world_id,
                    "workspace_id": self._workspace_id,
                    "observation": observation,
                },
                timeout=self._timeout,
            )
            response.raise_for_status()
            logger.debug(
                "ProxyEntity %s observe(): %s",
                self._name,
                observation[:100],
            )
        except Exception as exc:
            # Observations are fire-safe — never block the engine
            logger.warning(
                "ProxyEntity %s observe() failed: %s",
                self._name,
                exc,
            )


class ProxyEntityWithLogging(ProxyEntity, EntityWithLogging):
    """ProxyEntity with Concordia logging support.

    Concordia's engine and prefabs often expect EntityWithLogging which
    adds get_last_log() for step-by-step debugging and checkpoint data.
    """

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self._last_log: dict[str, Any] = {}

    def act(self, action_spec: ActionSpec = DEFAULT_ACTION_SPEC) -> str:
        start = time.time()
        result = super().act(action_spec)
        elapsed_ms = (time.time() - start) * 1000
        self._last_log = {
            "action_spec": action_spec.to_dict(),
            "action": result,
            "agent_id": self._agent_id,
            "agent_name": self._name,
            "world_id": self._world_id,
            "turn_count": self._turn_count,
            "elapsed_ms": round(elapsed_ms, 1),
        }
        return result

    def get_last_log(self) -> dict[str, Any]:
        return self._last_log

    def get_state(self) -> dict[str, Any]:
        return {
            "agent_id": self._agent_id,
            "agent_name": self._name,
            "world_id": self._world_id,
            "workspace_id": self._workspace_id,
            "turn_count": self._turn_count,
            "last_log": self._last_log,
        }

    def set_state(self, state: dict[str, Any]) -> None:
        self._turn_count = int(state.get("turn_count", self._turn_count))
        last_log = state.get("last_log")
        if isinstance(last_log, dict):
            self._last_log = last_log
