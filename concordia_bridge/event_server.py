"""
WebSocket event server for real-time simulation streaming.

Broadcasts SimulationEvents to connected viewer clients. Uses a
thread-safe queue for sync-to-async bridging since the Concordia
engine runs synchronously.

Phase 2 of the CONCORDIA_TODO.MD implementation plan.
"""

from __future__ import annotations

import asyncio
import json
import logging
import queue
import threading
import time
from dataclasses import asdict
from typing import Optional

import websockets
import websockets.server

from concordia_bridge.bridge_types import SimulationEvent

logger = logging.getLogger(__name__)


class EventServer:
    """WebSocket server that broadcasts simulation events to viewers.

    Thread-safe: broadcast() can be called from any thread (the synchronous
    Concordia engine thread). Events are queued and drained by the asyncio
    event loop running in a background thread.
    """

    def __init__(self, port: int = 3201, host: str = "0.0.0.0", max_buffer: int = 1000) -> None:
        self.port = port
        self.host = host
        self.max_buffer = max_buffer
        self._clients: set[websockets.server.ServerConnection] = set()
        self._replay_buffer: list[dict] = []
        self._queue: queue.Queue[str] = queue.Queue()
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._thread: Optional[threading.Thread] = None
        self._server: Optional[websockets.server.Server] = None
        self._running = False

    def start(self) -> None:
        """Start the event server in a background thread."""
        if self._running:
            return
        self._running = True
        self._thread = threading.Thread(target=self._run_loop, daemon=True)
        self._thread.start()
        # Wait for the server to be ready
        while self._loop is None and self._running:
            time.sleep(0.01)
        logger.info("Event server started on %s:%d", self.host, self.port)

    def stop(self) -> None:
        """Stop the event server."""
        self._running = False
        if self._loop and self._server:
            future = asyncio.run_coroutine_threadsafe(self._shutdown(), self._loop)
            try:
                future.result(timeout=5)
            except Exception:  # pragma: no cover - shutdown best effort
                logger.exception("Event server shutdown failed")
        if self._thread:
            self._thread.join(timeout=5)
        logger.info("Event server stopped")

    def broadcast(self, event: SimulationEvent) -> None:
        """Thread-safe broadcast — can be called from any thread."""
        data = json.dumps(asdict(event), default=str)
        self._replay_buffer.append(asdict(event))
        if len(self._replay_buffer) > self.max_buffer:
            self._replay_buffer = self._replay_buffer[-self.max_buffer:]
        self._queue.put(data)

    @property
    def client_count(self) -> int:
        return len(self._clients)

    @property
    def event_count(self) -> int:
        return len(self._replay_buffer)

    def _run_loop(self) -> None:
        """Background thread event loop."""
        self._loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self._loop)
        try:
            self._loop.run_until_complete(self._serve())
            pending = asyncio.all_tasks(self._loop)
            for task in pending:
                task.cancel()
            if pending:
                self._loop.run_until_complete(
                    asyncio.gather(*pending, return_exceptions=True)
                )
        finally:
            self._loop.close()
            self._loop = None
            self._server = None

    async def _serve(self) -> None:
        """Start the WebSocket server and drain queue."""
        async with websockets.serve(
            self._handler,
            self.host,
            self.port,
        ) as server:
            self._server = server
            while self._running:
                await self._drain_queue()
                await asyncio.sleep(0.02)

    async def _shutdown(self) -> None:
        """Close clients and the websocket server without aborting the loop."""
        clients = list(self._clients)
        self._clients.clear()
        for client in clients:
            try:
                await client.close()
            except Exception:  # pragma: no cover - best effort cleanup
                logger.debug("Error closing viewer websocket", exc_info=True)
        if self._server is not None:
            self._server.close()
            await self._server.wait_closed()

    async def _handler(self, websocket: websockets.server.ServerConnection) -> None:
        """Handle a new viewer connection."""
        self._clients.add(websocket)
        logger.info("Viewer connected (%d total)", len(self._clients))
        try:
            # Send replay buffer to late joiners
            for event_dict in self._replay_buffer:
                await websocket.send(json.dumps(event_dict, default=str))
            # Keep connection alive (viewer is read-only)
            async for _ in websocket:
                pass
        except websockets.exceptions.ConnectionClosed:
            pass
        finally:
            self._clients.discard(websocket)
            logger.info("Viewer disconnected (%d remaining)", len(self._clients))

    async def _drain_queue(self) -> None:
        """Send all queued events to connected clients."""
        while True:
            try:
                data = self._queue.get_nowait()
                dead_clients: list[websockets.server.ServerConnection] = []
                for client in list(self._clients):
                    try:
                        await client.send(data)
                    except websockets.exceptions.ConnectionClosed:
                        dead_clients.append(client)
                for client in dead_clients:
                    self._clients.discard(client)
            except queue.Empty:
                break
