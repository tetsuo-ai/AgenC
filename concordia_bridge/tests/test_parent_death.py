from __future__ import annotations

from types import SimpleNamespace

import concordia_bridge.parent_death as parent_death


def test_resolve_expected_parent_pid_accepts_positive_ids() -> None:
    assert parent_death.resolve_expected_parent_pid("42") == 42
    assert parent_death.resolve_expected_parent_pid("1") is None
    assert parent_death.resolve_expected_parent_pid("not-a-pid") is None


def test_should_terminate_for_parent_exit_detects_reparenting() -> None:
    assert parent_death.should_terminate_for_parent_exit(1234, 1234, True) is False
    assert parent_death.should_terminate_for_parent_exit(1234, 1, False) is True
    assert parent_death.should_terminate_for_parent_exit(1234, 5678, False) is True


def test_install_parent_death_guard_terminates_if_parent_already_gone(monkeypatch) -> None:
    terminated: list[str] = []

    monkeypatch.setattr(parent_death, "resolve_expected_parent_pid", lambda raw_pid=None: 7777)
    monkeypatch.setattr(parent_death, "_install_linux_parent_death_signal", lambda: True)
    monkeypatch.setattr(parent_death.os, "getppid", lambda: 1)
    monkeypatch.setattr(parent_death, "parent_process_exists", lambda _pid: False)

    result = parent_death.install_parent_death_guard(
        on_parent_exit=lambda: terminated.append("terminated"),
        poll_interval_seconds=0.01,
    )

    assert result == 7777
    assert terminated == ["terminated"]


def test_install_parent_death_guard_starts_watcher_for_live_parent(monkeypatch) -> None:
    started: list[dict[str, object]] = []

    class FakeThread:
        def __init__(self, *, target, args, name, daemon):
            started.append({
                "target": target,
                "args": args,
                "name": name,
                "daemon": daemon,
                "started": False,
            })
            self._record = started[-1]

        def start(self) -> None:
            self._record["started"] = True

    monkeypatch.setattr(parent_death, "resolve_expected_parent_pid", lambda raw_pid=None: 8888)
    monkeypatch.setattr(parent_death, "_install_linux_parent_death_signal", lambda: True)
    monkeypatch.setattr(parent_death.os, "getppid", lambda: 8888)
    monkeypatch.setattr(parent_death, "parent_process_exists", lambda _pid: True)
    monkeypatch.setattr(parent_death.threading, "Thread", FakeThread)

    result = parent_death.install_parent_death_guard(
        on_parent_exit=lambda: None,
        poll_interval_seconds=0.01,
    )

    assert result == 8888
    assert started == [{
        "target": parent_death._watch_parent_process,
        "args": (8888, started[0]["args"][1], 0.01),
        "name": "concordia-parent-death",
        "daemon": True,
        "started": True,
    }]
