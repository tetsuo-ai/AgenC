"""
CLI entry point for agenc-concordia.

Commands:
  bridge   — Start the bridge server (requires daemon running)
  run      — Run a simulation from a config module
  examples — List available example configs
  status   — Check simulation status

Phase 6 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import argparse
import dataclasses
import importlib
import json
import logging
import sys

logger = logging.getLogger(__name__)


def main() -> None:
    parser = argparse.ArgumentParser(
        prog="agenc-concordia",
        description="AgenC x Concordia simulation bridge",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Enable debug logging",
    )
    subparsers = parser.add_subparsers(dest="command")

    # --- run ---
    run_parser = subparsers.add_parser("run", help="Run a simulation")
    run_parser.add_argument(
        "--config", required=True,
        help="Python module path with a 'config' SimulationConfig (e.g., concordia_bridge.examples.medieval_town)",
    )
    run_parser.add_argument("--steps", type=int, help="Override max_steps")
    run_parser.add_argument("--bridge-url", default="http://localhost:3200")
    run_parser.add_argument("--event-port", type=int, default=3201)
    run_parser.add_argument("--control-port", type=int, default=3202)

    # --- run-json ---
    run_json_parser = subparsers.add_parser(
        "run-json", help="Run a simulation from a JSON config file",
    )
    run_json_parser.add_argument(
        "--config-file", required=True,
        help="Path to a JSON file matching SimulationConfig fields",
    )

    # --- examples ---
    subparsers.add_parser("examples", help="List available example configs")

    # --- status ---
    status_parser = subparsers.add_parser("status", help="Check simulation status")
    status_parser.add_argument("--control-port", type=int, default=3202)

    args = parser.parse_args()

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s",
    )

    if args.command == "run":
        cmd_run(args)
    elif args.command == "run-json":
        cmd_run_json(args)
    elif args.command == "examples":
        cmd_examples()
    elif args.command == "status":
        cmd_status(args)
    else:
        parser.print_help()


def cmd_run(args: argparse.Namespace) -> None:
    """Run a simulation from a config module."""
    # Import the config module
    try:
        module = importlib.import_module(args.config)
    except ModuleNotFoundError:
        print(f"Error: Could not import config module '{args.config}'")
        print("Use a dotted module path like: concordia_bridge.examples.medieval_town")
        sys.exit(1)

    if not hasattr(module, "config"):
        print(f"Error: Module '{args.config}' has no 'config' attribute")
        sys.exit(1)

    config = module.config

    # Apply overrides
    if args.steps:
        config = dataclasses.replace(config, max_steps=args.steps)
    if args.bridge_url:
        config = dataclasses.replace(config, bridge_url=args.bridge_url)
    if args.event_port:
        config = dataclasses.replace(config, event_port=args.event_port)
    if args.control_port:
        config = dataclasses.replace(config, control_port=args.control_port)

    _run_config(config)


def cmd_run_json(args: argparse.Namespace) -> None:
    """Run a simulation from a JSON config file."""
    from concordia_bridge.bridge_types import AgentConfig, SimulationConfig

    try:
        with open(args.config_file, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        print(f"Error: Config file not found: {args.config_file}")
        sys.exit(1)
    except json.JSONDecodeError as exc:
        print(f"Error: Invalid JSON config: {exc}")
        sys.exit(1)

    agents = []
    for agent in raw.get("agents", []):
        agent_id = agent.get("agent_id") or agent.get("id")
        agent_name = agent.get("agent_name") or agent.get("name")
        if not agent_id or not agent_name:
            print(f"Error: Invalid agent config entry: {agent!r}")
            sys.exit(1)

        agents.append(
            AgentConfig(
                id=agent_id,
                name=agent_name,
                personality=agent.get("personality", ""),
                goal=agent.get("goal", ""),
            )
        )

    config = SimulationConfig(
        world_id=raw.get("world_id", "default"),
        workspace_id=raw.get("workspace_id", "concordia-sim"),
        premise=raw.get("premise", ""),
        agents=agents,
        max_steps=raw.get("max_steps", 50),
        gm_instructions=raw.get("gm_instructions", ""),
        gm_model=raw.get("gm_model", "grok-3-mini"),
        gm_provider=raw.get("gm_provider", "ollama"),
        gm_api_key=raw.get("gm_api_key", ""),
        gm_base_url=raw.get("gm_base_url", ""),
        engine_type=raw.get("engine_type", "simultaneous"),
        gm_prefab=raw.get("gm_prefab", "generic"),
        bridge_url=raw.get("bridge_url", "http://localhost:3200"),
        event_port=raw.get("event_port", 3201),
        control_port=raw.get("control_port", 3202),
        embedding_model=raw.get("embedding_model", "all-MiniLM-L6-v2"),
        reflection_interval=raw.get("reflection_interval", 5),
        consolidation_interval=raw.get("consolidation_interval", 20),
        retention_interval=raw.get("retention_interval", 20),
        encryption_key=raw.get("encryption_key", ""),
        scenes=raw.get("scenes"),
    )

    _run_config(config)


def _run_config(config) -> None:
    from concordia_bridge.runner import run_simulation

    print(f"Running simulation: {config.world_id}")
    print(f"  Agents: {', '.join(a.name for a in config.agents)}")
    print(f"  Steps: {config.max_steps}")
    print(f"  Bridge: {config.bridge_url}")
    print()

    try:
        summary = run_simulation(config, verbose=True)
        print(f"\nSimulation complete:")
        print(f"  Steps: {summary['steps_completed']}/{summary['max_steps']}")
        print(f"  Events: {summary['event_count']}")
    except KeyboardInterrupt:
        print("\nSimulation interrupted.")
    except Exception as exc:
        print(f"\nSimulation failed: {exc}")
        if logger.isEnabledFor(logging.DEBUG):
            logger.exception("Simulation error")
        sys.exit(1)


def cmd_examples() -> None:
    """List available example simulation configs."""
    examples = [
        ("concordia_bridge.examples.medieval_town", "3 agents in a medieval town with conflicting goals"),
        ("concordia_bridge.examples.trading_floor", "4 traders with asymmetric information"),
        ("concordia_bridge.examples.research_lab", "3 AI researchers collaborating/competing"),
    ]
    print("Available example configs:\n")
    for module_path, description in examples:
        print(f"  {module_path}")
        print(f"    {description}\n")
    print("Run with: agenc-concordia run --config <module_path>")


def cmd_status(args: argparse.Namespace) -> None:
    """Check simulation status via the control server."""
    import requests

    try:
        resp = requests.get(
            f"http://localhost:{args.control_port}/simulation/status",
            timeout=5,
        )
        resp.raise_for_status()
        status = resp.json()
        print(f"Simulation status:")
        print(f"  World: {status.get('world_id', 'unknown')}")
        print(f"  Step: {status.get('step', 0)}/{status.get('max_steps', 0)}")
        print(f"  Running: {status.get('running', False)}")
        print(f"  Paused: {status.get('paused', False)}")
        print(f"  Agents: {status.get('agent_count', 0)}")
    except requests.ConnectionError:
        print("No simulation running (control server not reachable)")
    except Exception as exc:
        print(f"Error checking status: {exc}")


if __name__ == "__main__":
    main()
