"""
CLI entry point for agenc-concordia.

Commands:
  bridge   — Start the bridge server (requires daemon running)
  run      — Run a simulation from a config module
  resume   — Resume a simulation from a checkpoint
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
from uuid import uuid4

logger = logging.getLogger(__name__)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="agenc-concordia",
        description="AgenC x Concordia simulation bridge",
    )
    parser.add_argument(
        "-v", "--verbose", action="store_true", help="Enable debug logging",
    )
    subparsers = parser.add_subparsers(dest="command")

    run_parser = subparsers.add_parser("run", help="Run a simulation")
    run_parser.add_argument(
        "--config", required=True,
        help="Python module path with a 'config' SimulationConfig (e.g., concordia_bridge.examples.medieval_town)",
    )
    run_parser.add_argument("--steps", type=int, help="Override max_steps")
    run_parser.add_argument("--bridge-url", default="http://localhost:3200")
    run_parser.add_argument("--event-port", type=int, default=3201)
    run_parser.add_argument("--control-port", type=int, default=3202)

    run_json_parser = subparsers.add_parser(
        "run-json", help="Run a simulation from a JSON config file",
    )
    run_json_parser.add_argument(
        "--config-file", required=True,
        help="Path to a JSON file matching SimulationConfig fields",
    )

    resume_parser = subparsers.add_parser(
        "resume", help="Resume a simulation from a checkpoint",
    )
    resume_parser.add_argument(
        "--checkpoint", required=True,
        help="Path to a checkpoint JSON file",
    )

    subparsers.add_parser("examples", help="List available example configs")

    status_parser = subparsers.add_parser("status", help="Check simulation status")
    status_parser.add_argument("--control-port", type=int, default=3202)
    return parser


def configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)-5s [%(name)s] %(message)s",
    )


def dispatch_command(parser: argparse.ArgumentParser, args: argparse.Namespace) -> None:
    command_handlers = {
        "run": lambda: cmd_run(args),
        "run-json": lambda: cmd_run_json(args),
        "resume": lambda: cmd_resume(args),
        "examples": cmd_examples,
        "status": lambda: cmd_status(args),
    }
    handler = command_handlers.get(args.command)
    if handler is None:
        parser.print_help()
        return
    handler()


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    configure_logging(args.verbose)
    dispatch_command(parser, args)


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
    from concordia_bridge.bridge_types import AgentConfig, build_simulation_config

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

    config = build_simulation_config(raw, agents)

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


def cmd_resume(args: argparse.Namespace) -> None:
    """Resume a simulation from a saved checkpoint."""
    from concordia_bridge.checkpoint import (
        load_checkpoint,
        simulation_config_from_checkpoint,
    )
    from concordia_bridge.runner import run_simulation

    checkpoint = load_checkpoint(args.checkpoint)
    if checkpoint is None:
        print(f"Error: Could not load checkpoint: {args.checkpoint}")
        sys.exit(1)

    config = simulation_config_from_checkpoint(checkpoint)
    resumed_simulation_id = str(uuid4())
    resumed_lineage_id = checkpoint.get("lineage_id") or checkpoint.get("simulation_id")
    resumed_parent_simulation_id = checkpoint.get("simulation_id")
    config = dataclasses.replace(
        config,
        simulation_id=resumed_simulation_id,
        lineage_id=resumed_lineage_id,
        parent_simulation_id=resumed_parent_simulation_id,
    )

    print(f"Resuming simulation: {config.world_id}")
    print(f"  Checkpoint: {args.checkpoint}")
    print(f"  Resume from step: {checkpoint.get('step', 0) + 1}")
    print(f"  Max steps: {config.max_steps}")
    print()

    try:
        summary = run_simulation(config, verbose=True, checkpoint=checkpoint)
        print(f"\nSimulation complete:")
        print(f"  Steps: {summary['steps_completed']}/{summary['max_steps']}")
        print(f"  Events: {summary['event_count']}")
    except KeyboardInterrupt:
        print("\nSimulation interrupted.")
    except Exception as exc:
        print(f"\nSimulation resume failed: {exc}")
        if logger.isEnabledFor(logging.DEBUG):
            logger.exception("Simulation resume error")
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
